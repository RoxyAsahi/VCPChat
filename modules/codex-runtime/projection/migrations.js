'use strict';

const SCHEMA_VERSION = 3;

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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived_at INTEGER
        );

        CREATE INDEX IF NOT EXISTS agent_sessions_updated_idx
            ON agent_sessions(archived_at, updated_at DESC, session_id);

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
            updated_at INTEGER NOT NULL
        );
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
    } else if (row.version !== SCHEMA_VERSION) {
        throw new Error(`Unsupported Agent projection schema ${row.version}; expected ${SCHEMA_VERSION}`);
    }
    return SCHEMA_VERSION;
}

module.exports = { migrate, SCHEMA_VERSION };
