'use strict';

const fs = require('fs');

const SCHEMA_VERSION = 11;
const LEGACY_TOOL_CARD_BACKUP_SCHEMA = 6;
const MAX_LEGACY_TOOL_CARD_COUNT = 512;
const MAX_LEGACY_TOOL_CARD_BYTES = 1024 * 1024;
const MAX_LEGACY_TOOL_CARD_TOTAL_BYTES = 8 * 1024 * 1024;

function hasColumn(db, table, column) {
    return db.prepare(`PRAGMA table_info('${table}')`).all().some((entry) => entry.name === column);
}

function addColumn(db, table, definition) {
    const [column] = definition.trim().split(/\s+/, 1);
    if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function backupBeforeMigration(db, databasePath, currentVersion) {
    if (!databasePath || databasePath === ':memory:' || !fs.existsSync(databasePath)
        || !Number.isInteger(currentVersion) || currentVersion >= SCHEMA_VERSION) return null;
    const backupPath = `${databasePath}.schema-${currentVersion}.bak`;
    try {
        if (fs.existsSync(backupPath)) fs.rmSync(backupPath);
        const escaped = backupPath.replace(/'/g, "''");
        db.exec(`VACUUM INTO '${escaped}'`);
        return backupPath;
    } catch (error) {
        throw new Error(`Could not back up Agent projection database before migration: ${error.message}`);
    }
}

function restoreVerifiedLegacyToolCards(db, databasePath) {
    // Schema 6 was the last on-disk projection known to contain a subset of
    // VCP dynamic-tool receipts that a later sparse Codex snapshot removed.
    // This deliberately recovers only those receipts; assistant prose is not
    // evidence of a tool call and is never converted into a display card.
    if (!databasePath || databasePath === ':memory:') return 0;
    const backupPath = `${databasePath}.schema-${LEGACY_TOOL_CARD_BACKUP_SCHEMA}.bak`;
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size > 64 * 1024 * 1024) return 0;

    let legacy = null;
    try {
        const Database = require('better-sqlite3');
        legacy = new Database(backupPath, { readonly: true, fileMustExist: true });
        const version = Number(legacy.prepare('SELECT version FROM projection_schema LIMIT 1').get()?.version || 0);
        if (version !== LEGACY_TOOL_CARD_BACKUP_SCHEMA) return 0;
        const tables = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
        if (!tables.has('agent_messages') || !tables.has('agent_blocks')) return 0;
        const rows = legacy.prepare(`
            SELECT m.message_id, m.session_id, m.codex_thread_id, m.codex_turn_id, m.codex_item_id,
                   m.role, m.status AS message_status, m.source_order, m.created_at AS message_created_at,
                   m.updated_at AS message_updated_at, b.block_id, b.kind, b.status AS block_status,
                   b.ordinal, b.content_json, b.created_at AS block_created_at, b.updated_at AS block_updated_at
            FROM agent_messages AS m
            JOIN agent_blocks AS b ON b.message_id = m.message_id
            WHERE b.kind = 'tool'
              AND json_valid(b.content_json)
              AND json_extract(b.content_json, '$.item.type') = 'dynamicToolCall'
            LIMIT ?
        `).all(MAX_LEGACY_TOOL_CARD_COUNT);
        if (!rows.length) return 0;

        const hasSession = db.prepare('SELECT 1 FROM agent_sessions WHERE session_id = ?');
        const hasItem = db.prepare('SELECT 1 FROM agent_messages WHERE session_id = ? AND codex_item_id = ?');
        const hasMessageId = db.prepare('SELECT 1 FROM agent_messages WHERE message_id = ?');
        const insertMessage = db.prepare(`
            INSERT INTO agent_messages (
                message_id, session_id, codex_thread_id, codex_turn_id, codex_item_id,
                role, status, source_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertBlock = db.prepare(`
            INSERT INTO agent_blocks (
                block_id, message_id, kind, status, ordinal, content_json, content_schema_version,
                authority, created_at, updated_at
            ) VALUES (?, ?, 'tool', ?, ?, ?, 1, 'toolbox', ?, ?)
        `);
        const advanceSessionOrder = db.prepare(`
            UPDATE projection_state
            SET next_source_order = MAX(next_source_order, ?),
                mutation_generation = mutation_generation + 1,
                updated_at = ?
            WHERE session_id = ?
        `);
        let restored = 0;
        let totalBytes = 0;
        const restore = db.transaction(() => {
            for (const row of rows) {
                const content = String(row.content_json || '');
                if (!row.session_id || !row.codex_item_id || content.length > MAX_LEGACY_TOOL_CARD_BYTES
                    || totalBytes + content.length > MAX_LEGACY_TOOL_CARD_TOTAL_BYTES
                    || !hasSession.get(row.session_id) || hasItem.get(row.session_id, row.codex_item_id)
                    || hasMessageId.get(row.message_id)) continue;
                let parsed;
                try { parsed = JSON.parse(content); } catch { continue; }
                if (parsed?.item?.type !== 'dynamicToolCall') continue;
                const now = Date.now();
                insertMessage.run(
                    row.message_id, row.session_id, row.codex_thread_id || '', row.codex_turn_id || null,
                    row.codex_item_id, row.role || 'tool', row.message_status || 'completed',
                    Number.isInteger(row.source_order) ? row.source_order : 0,
                    Number(row.message_created_at) || now, Number(row.message_updated_at) || now,
                );
                insertBlock.run(
                    row.block_id || `block:${row.session_id}:${row.codex_item_id}:${row.ordinal || 0}`,
                    row.message_id, row.block_status || row.message_status || 'completed',
                    Number.isInteger(row.ordinal) ? row.ordinal : 0, content,
                    Number(row.block_created_at) || now, Number(row.block_updated_at) || now,
                );
                advanceSessionOrder.run((Number.isInteger(row.source_order) ? row.source_order : 0) + 1, now, row.session_id);
                totalBytes += content.length;
                restored += 1;
            }
        });
        restore();
        return restored;
    } catch (_error) {
        // The backup is optional recovery material. A malformed or unavailable
        // backup must not block access to the current projection.
        return 0;
    } finally {
        try { legacy?.close(); } catch {}
    }
}

function migrate(db, options = {}) {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    const quickCheck = db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`Agent projection quick_check failed: ${quickCheck}`);
    const existingSchema = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projection_schema'").get();
    const existingVersion = existingSchema
        ? Number(db.prepare('SELECT version FROM projection_schema LIMIT 1').get()?.version)
        : null;
    backupBeforeMigration(db, options.databasePath, existingVersion);
    db.exec(`
        CREATE TABLE IF NOT EXISTS projection_schema (
            version INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_sessions (
            session_id TEXT PRIMARY KEY,
            codex_thread_id TEXT UNIQUE,
            agent_id TEXT NOT NULL,
            agent_catalog_id TEXT,
            agent_name_snapshot TEXT,
            title TEXT,
            workspace_root TEXT,
            state TEXT NOT NULL,
            config_snapshot_json TEXT NOT NULL,
            config_revision INTEGER NOT NULL DEFAULT 1,
            config_schema_version INTEGER NOT NULL DEFAULT 2,
            applied_config_snapshot_json TEXT NOT NULL DEFAULT '{}',
            applied_config_revision INTEGER NOT NULL DEFAULT 0,
            config_apply_state TEXT NOT NULL DEFAULT 'unmaterialized',
            config_apply_error TEXT,
            config_apply_updated_at INTEGER,
            orphaned INTEGER NOT NULL DEFAULT 0,
            pinned_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS agent_messages (
            message_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
            codex_thread_id TEXT NOT NULL,
            codex_turn_id TEXT,
            codex_item_id TEXT NOT NULL,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            source_order INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(session_id, codex_item_id)
        );

        CREATE INDEX IF NOT EXISTS agent_messages_session_order_idx
            ON agent_messages(session_id, source_order, message_id);

        CREATE TABLE IF NOT EXISTS agent_blocks (
            block_id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL REFERENCES agent_messages(message_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            content_json TEXT NOT NULL,
            content_schema_version INTEGER NOT NULL DEFAULT 1,
            authority TEXT NOT NULL DEFAULT 'codex',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(message_id, ordinal)
        );

        CREATE TABLE IF NOT EXISTS projection_state (
            session_id TEXT PRIMARY KEY REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
            next_source_order INTEGER NOT NULL DEFAULT 1,
            mutation_generation INTEGER NOT NULL DEFAULT 0,
            last_reconciled_at INTEGER,
            last_error TEXT,
            activity_json TEXT NOT NULL DEFAULT '{}',
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_pending_inputs (
            input_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
            dedupe_key TEXT NOT NULL,
            submission_id TEXT,
            kind TEXT NOT NULL DEFAULT 'follow-up',
            target_turn_id TEXT,
            prompt TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'queued',
            client_message_id TEXT,
            codex_turn_id TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS agent_pending_inputs_session_order_idx
            ON agent_pending_inputs(session_id, created_at, input_id);

        CREATE TABLE IF NOT EXISTS agent_operations (
            operation_id TEXT PRIMARY KEY,
            session_id TEXT,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            codex_thread_id TEXT,
            payload_json TEXT NOT NULL DEFAULT '{}',
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS agent_operations_state_idx
            ON agent_operations(state, updated_at, operation_id);

        CREATE TABLE IF NOT EXISTS agent_deletion_receipts (
            receipt_id TEXT PRIMARY KEY,
            session_hash TEXT NOT NULL,
            codex_thread_hash TEXT,
            deleted_at INTEGER NOT NULL
        );
    `);
    const row = db.prepare('SELECT version FROM projection_schema LIMIT 1').get();
    if (!row) {
        db.prepare('INSERT INTO projection_schema(version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version > SCHEMA_VERSION) {
        throw new Error(`Unsupported Agent projection schema ${row.version}; expected ${SCHEMA_VERSION}`);
    }
    addColumn(db, 'projection_state', 'mutation_generation INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'projection_state', "activity_json TEXT NOT NULL DEFAULT '{}'");
    addColumn(db, 'agent_sessions', 'agent_catalog_id TEXT');
    addColumn(db, 'agent_sessions', 'agent_name_snapshot TEXT');
    addColumn(db, 'agent_sessions', 'pinned_at INTEGER');
    db.exec('DROP INDEX IF EXISTS agent_sessions_updated_idx');
    db.exec(`CREATE INDEX agent_sessions_updated_idx
        ON agent_sessions(archived_at, pinned_at DESC, updated_at DESC, session_id)`);
    addColumn(db, 'agent_sessions', 'config_revision INTEGER NOT NULL DEFAULT 1');
    addColumn(db, 'agent_sessions', 'config_schema_version INTEGER NOT NULL DEFAULT 2');
    addColumn(db, 'agent_sessions', "applied_config_snapshot_json TEXT NOT NULL DEFAULT '{}'");
    addColumn(db, 'agent_sessions', 'applied_config_revision INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'agent_sessions', "config_apply_state TEXT NOT NULL DEFAULT 'unmaterialized'");
    addColumn(db, 'agent_sessions', 'config_apply_error TEXT');
    addColumn(db, 'agent_sessions', 'config_apply_updated_at INTEGER');
    addColumn(db, 'agent_blocks', "authority TEXT NOT NULL DEFAULT 'codex'");
    addColumn(db, 'agent_blocks', 'content_schema_version INTEGER NOT NULL DEFAULT 1');
    if (Number(existingVersion || 0) < 8) {
        db.exec(`
            UPDATE agent_sessions
            SET config_snapshot_json = CASE
                WHEN json_valid(config_snapshot_json)
                    THEN json_set(config_snapshot_json, '$.schemaVersion', 2, '$.workspaceRoot', workspace_root)
                    ELSE json_object('schemaVersion', 2)
                END,
                applied_config_snapshot_json = CASE
                    WHEN json_valid(config_snapshot_json)
                    THEN json_set(config_snapshot_json, '$.schemaVersion', 2, '$.workspaceRoot', workspace_root)
                    ELSE json_object('schemaVersion', 2)
                END,
                applied_config_revision = config_revision,
                config_apply_state = CASE WHEN codex_thread_id IS NULL THEN 'unmaterialized' ELSE 'applied' END,
                config_apply_error = NULL,
                config_apply_updated_at = updated_at
        `);
    }
    if (Number(existingVersion || 0) < 10) {
        // Dynamic tool calls are executed by the VCPToolBox bridge. Older
        // projections recorded them as Codex-owned, which allowed a sparse
        // thread/read snapshot to delete their durable display cards.
        db.exec(`
            UPDATE agent_blocks
            SET authority = 'toolbox'
            WHERE kind = 'tool'
                AND authority = 'codex'
                AND json_extract(content_json, '$.item.type') = 'dynamicToolCall'
        `);
    }
    if (Number(existingVersion || 0) < 11) {
        restoreVerifiedLegacyToolCards(db, options.databasePath);
    }
    addColumn(db, 'agent_pending_inputs', "state TEXT NOT NULL DEFAULT 'queued'");
    addColumn(db, 'agent_pending_inputs', "submission_id TEXT");
    addColumn(db, 'agent_pending_inputs', "kind TEXT NOT NULL DEFAULT 'follow-up'");
    addColumn(db, 'agent_pending_inputs', "target_turn_id TEXT");
    addColumn(db, 'agent_pending_inputs', 'client_message_id TEXT');
    addColumn(db, 'agent_pending_inputs', 'codex_turn_id TEXT');
    addColumn(db, 'agent_pending_inputs', 'attempt_count INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'agent_pending_inputs', 'updated_at INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'agent_pending_inputs', 'last_error TEXT');
    db.prepare('UPDATE agent_pending_inputs SET updated_at = created_at WHERE updated_at = 0').run();
    db.prepare('UPDATE agent_pending_inputs SET submission_id = dedupe_key WHERE submission_id IS NULL').run();
    db.prepare("UPDATE agent_pending_inputs SET kind = 'follow-up' WHERE kind IS NULL OR kind = ''").run();
    db.prepare('UPDATE projection_schema SET version = ?').run(SCHEMA_VERSION);
    const foreignKeyErrors = db.pragma('foreign_key_check');
    if (foreignKeyErrors.length) throw new Error('Agent projection foreign_key_check failed after migration');
    return SCHEMA_VERSION;
}

module.exports = { migrate, SCHEMA_VERSION };
