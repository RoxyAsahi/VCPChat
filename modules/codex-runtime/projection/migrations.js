'use strict';

const fs = require('fs');
const { normalizeContent, stableBlockId } = require('./v2');

const SCHEMA_VERSION = 12;
const MINIMUM_MIGRATABLE_SCHEMA = 6;

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

function legacyReasoningContent(content) {
    const summary = Array.isArray(content?.summary) ? content.summary : [];
    if (summary.length || typeof content?.text !== 'string' || !content.text) return content;
    return { ...content, summary: [content.text] };
}

function canonicalizeBlocks(db) {
    const rows = db.prepare(`
        SELECT b.rowid, b.block_id, b.kind, b.ordinal, b.content_json, b.authority,
               m.session_id, m.codex_item_id
        FROM agent_blocks AS b
        JOIN agent_messages AS m ON m.message_id = b.message_id
        ORDER BY b.rowid
    `).all();
    const plans = [];
    const identities = new Set();
    for (const row of rows) {
        const sessionId = String(row.session_id || '').trim();
        const itemId = String(row.codex_item_id || '').trim();
        const ordinal = Number(row.ordinal);
        if (!sessionId || !itemId || !Number.isInteger(ordinal) || ordinal < 0) {
            throw new Error(`Agent projection schema 12 cannot normalize block identity ${row.block_id || '<missing>'}`);
        }
        let content;
        try { content = JSON.parse(row.content_json); } catch (_error) {
            throw new Error(`Agent projection schema 12 found malformed Block JSON: ${row.block_id}`);
        }
        if (!content || typeof content !== 'object' || Array.isArray(content)) {
            throw new Error(`Agent projection schema 12 requires object Block content: ${row.block_id}`);
        }
        const prepared = row.kind === 'reasoning' ? legacyReasoningContent(content) : content;
        const itemType = prepared?.item?.type || prepared?.unknown?.type
            || (row.kind === 'reasoning' ? 'reasoning' : null);
        const blockId = stableBlockId(sessionId, itemId, ordinal);
        if (identities.has(blockId)) {
            throw new Error(`Agent projection schema 12 found duplicate Block identity: ${blockId}`);
        }
        identities.add(blockId);
        plans.push({
            rowid: row.rowid,
            blockId,
            contentJson: JSON.stringify(normalizeContent(prepared, itemType)),
            authority: itemType === 'dynamicToolCall' ? 'toolbox' : (row.authority || 'codex'),
        });
    }
    const park = db.prepare('UPDATE agent_blocks SET block_id = ? WHERE rowid = ?');
    const update = db.prepare(`
        UPDATE agent_blocks
        SET block_id = ?, content_json = ?, content_schema_version = 2, authority = ?
        WHERE rowid = ?
    `);
    for (const plan of plans) park.run(`__schema12__:${plan.rowid}`, plan.rowid);
    for (const plan of plans) update.run(
        plan.blockId, plan.contentJson, plan.authority, plan.rowid,
    );
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
    if (existingVersion != null && (!Number.isInteger(existingVersion)
        || existingVersion < MINIMUM_MIGRATABLE_SCHEMA)) {
        throw new Error(`Unsupported Agent projection schema ${existingVersion}; minimum migratable schema is ${MINIMUM_MIGRATABLE_SCHEMA}`);
    }
    backupBeforeMigration(db, options.databasePath, existingVersion);
    const applyMigration = db.transaction(() => {
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
            content_schema_version INTEGER NOT NULL DEFAULT 2,
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
    addColumn(db, 'agent_blocks', 'content_schema_version INTEGER NOT NULL DEFAULT 2');
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
    if (Number(existingVersion || 0) < 12) canonicalizeBlocks(db);
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
    });
    applyMigration();
    return SCHEMA_VERSION;
}

module.exports = { migrate, SCHEMA_VERSION };
