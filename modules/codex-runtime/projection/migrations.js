'use strict';

const SCHEMA_VERSION = 6;

function migrate(db) {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
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
            orphaned INTEGER NOT NULL DEFAULT 0,
            pinned_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS agent_sessions_updated_idx
            ON agent_sessions(archived_at, pinned_at DESC, updated_at DESC, session_id);

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
            prompt TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, dedupe_key)
        );
        CREATE INDEX IF NOT EXISTS agent_pending_inputs_session_order_idx
            ON agent_pending_inputs(session_id, created_at, input_id);
    `);
    const row = db.prepare('SELECT version FROM projection_schema LIMIT 1').get();
    if (!row) {
        db.prepare('INSERT INTO projection_schema(version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version === 1) {
        db.exec('ALTER TABLE projection_state ADD COLUMN mutation_generation INTEGER NOT NULL DEFAULT 0');
        db.exec(`
            ALTER TABLE agent_sessions ADD COLUMN agent_catalog_id TEXT;
            ALTER TABLE agent_sessions ADD COLUMN agent_name_snapshot TEXT;
        `);
        db.prepare('UPDATE projection_schema SET version = ?').run(SCHEMA_VERSION);
    } else if (row.version === 2) {
        db.exec(`
            ALTER TABLE agent_sessions ADD COLUMN agent_catalog_id TEXT;
            ALTER TABLE agent_sessions ADD COLUMN agent_name_snapshot TEXT;
        `);
        db.prepare('UPDATE projection_schema SET version = ?').run(SCHEMA_VERSION);
    } else if (row.version === 3) {
        db.exec('ALTER TABLE agent_sessions ADD COLUMN pinned_at INTEGER');
        db.exec('DROP INDEX IF EXISTS agent_sessions_updated_idx');
        db.exec(`CREATE INDEX agent_sessions_updated_idx
            ON agent_sessions(archived_at, pinned_at DESC, updated_at DESC, session_id)`);
        db.prepare('UPDATE projection_schema SET version = ?').run(SCHEMA_VERSION);
    } else if (row.version === 4) {
        db.exec(`CREATE TABLE agent_pending_inputs (
            input_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES agent_sessions(session_id) ON DELETE CASCADE,
            dedupe_key TEXT NOT NULL,
            prompt TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(session_id, dedupe_key)
        );
        CREATE INDEX agent_pending_inputs_session_order_idx
            ON agent_pending_inputs(session_id, created_at, input_id)`);
        db.prepare('UPDATE projection_schema SET version = ?').run(SCHEMA_VERSION);
    } else if (row.version === 5) {
        db.exec("ALTER TABLE projection_state ADD COLUMN activity_json TEXT NOT NULL DEFAULT '{}'");
        db.prepare('UPDATE projection_schema SET version = ?').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported Agent projection schema ${row.version}; expected ${SCHEMA_VERSION}`);
    }
    return SCHEMA_VERSION;
}

module.exports = { migrate, SCHEMA_VERSION };
