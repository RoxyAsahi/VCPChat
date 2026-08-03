'use strict';

const SCHEMA_VERSION = 1;

const MIGRATIONS = [
    {
        version: 1,
        sql: `
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                parent_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
                runtime TEXT NOT NULL,
                state TEXT NOT NULL,
                title TEXT,
                workspace_root TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                summary TEXT,
                context_usage_json TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                closed_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS turns (
                turn_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                turn_index INTEGER NOT NULL,
                state TEXT NOT NULL,
                prompt TEXT NOT NULL,
                error TEXT,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                UNIQUE(session_id, turn_index)
            );

            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
                role TEXT NOT NULL,
                content_json TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                compacted INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS messages_session_created_idx
                ON messages(session_id, created_at, message_id);

            CREATE TABLE IF NOT EXISTS events (
                event_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                sequence INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                runtime TEXT NOT NULL,
                type TEXT NOT NULL,
                turn_id TEXT,
                message_id TEXT,
                tool_call_id TEXT,
                approval_id TEXT,
                payload_json TEXT NOT NULL,
                UNIQUE(session_id, sequence)
            );
            CREATE INDEX IF NOT EXISTS events_session_sequence_idx
                ON events(session_id, sequence);

            CREATE TABLE IF NOT EXISTS tool_calls (
                tool_call_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
                tool_name TEXT NOT NULL,
                state TEXT NOT NULL,
                arguments_hash TEXT,
                argument_summary TEXT,
                output_summary TEXT,
                error TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS approvals (
                approval_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
                tool_call_id TEXT REFERENCES tool_calls(tool_call_id) ON DELETE SET NULL,
                tool_name TEXT NOT NULL,
                arguments_hash TEXT NOT NULL,
                risk_level TEXT NOT NULL,
                state TEXT NOT NULL,
                reason TEXT,
                outcome_json TEXT,
                requested_at INTEGER NOT NULL,
                expires_at INTEGER,
                resolved_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS artifacts (
                artifact_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                path TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runtime_state (
                session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
                driver_id TEXT NOT NULL,
                state_version TEXT NOT NULL,
                state_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS checkpoints (
                checkpoint_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                turn_id TEXT REFERENCES turns(turn_id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                summary TEXT,
                context_usage_json TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS checkpoints_session_created_idx
                ON checkpoints(session_id, created_at DESC);
        `,
    },
];

function migrate(db) {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    const currentVersion = db.pragma('user_version', { simple: true });
    if (currentVersion > SCHEMA_VERSION) {
        throw new Error(`Agent runtime database schema ${currentVersion} is newer than supported ${SCHEMA_VERSION}`);
    }
    for (const migration of MIGRATIONS) {
        if (migration.version <= currentVersion) continue;
        db.transaction(() => {
            db.exec(migration.sql);
            db.pragma(`user_version = ${migration.version}`);
        })();
    }
    return SCHEMA_VERSION;
}

module.exports = {
    SCHEMA_VERSION,
    MIGRATIONS,
    migrate,
};
