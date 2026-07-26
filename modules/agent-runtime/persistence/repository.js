'use strict';

const path = require('path');
const { migrate } = require('./migrations');
const { redactValue } = require('../secretRedactor');
const { newId } = require('../contracts');

function parseJson(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function stringify(value, fallback = '{}') {
    if (value === undefined) return fallback;
    return JSON.stringify(redactValue(value));
}

class AgentRuntimeRepository {
    constructor(options = {}) {
        const Database = options.Database || require('better-sqlite3');
        this.databasePath = options.databasePath
            || path.join(options.userDataPath || process.cwd(), 'agent-runtime.sqlite');
        this.db = options.db || new Database(this.databasePath);
        this.schemaVersion = migrate(this.db);
        this._prepare();
    }

    _prepare() {
        this.statements = {
            insertSession: this.db.prepare(`
                INSERT INTO sessions (
                    session_id, parent_session_id, runtime, state, title, workspace_root,
                    metadata_json, summary, context_usage_json, created_at, updated_at, closed_at
                ) VALUES (
                    @session_id, @parent_session_id, @runtime, @state, @title, @workspace_root,
                    @metadata_json, @summary, @context_usage_json, @created_at, @updated_at, @closed_at
                )
            `),
            updateSession: this.db.prepare(`
                UPDATE sessions SET state = @state, title = @title, workspace_root = @workspace_root,
                    metadata_json = @metadata_json, summary = @summary,
                    context_usage_json = @context_usage_json, updated_at = @updated_at,
                    closed_at = @closed_at
                WHERE session_id = @session_id
            `),
            getSession: this.db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
            listSessions: this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, created_at DESC'),
            deleteSession: this.db.prepare('DELETE FROM sessions WHERE session_id = ?'),
            insertTurn: this.db.prepare(`
                INSERT INTO turns (turn_id, session_id, turn_index, state, prompt, error, started_at, completed_at)
                VALUES (@turn_id, @session_id, @turn_index, @state, @prompt, @error, @started_at, @completed_at)
            `),
            updateTurn: this.db.prepare(`
                UPDATE turns SET state = @state, error = @error, completed_at = @completed_at
                WHERE turn_id = @turn_id
            `),
            listTurns: this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index'),
            interruptTurns: this.db.prepare(`
                UPDATE turns SET state = 'failed', error = 'interrupted by runtime restart', completed_at = @now
                WHERE state IN ('queued', 'running', 'awaiting-approval', 'cancelling')
            `),
            interruptSessions: this.db.prepare(`
                UPDATE sessions SET state = 'failed', updated_at = @now
                WHERE state IN ('created', 'active', 'closing')
            `),
            insertEvent: this.db.prepare(`
                INSERT INTO events (
                    event_id, session_id, sequence, schema_version, timestamp, runtime, type,
                    turn_id, message_id, tool_call_id, approval_id, payload_json
                ) VALUES (
                    @event_id, @session_id, @sequence, @schema_version, @timestamp, @runtime, @type,
                    @turn_id, @message_id, @tool_call_id, @approval_id, @payload_json
                )
            `),
            listEvents: this.db.prepare(`
                SELECT * FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
            `),
            lastSequence: this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE session_id = ?'),
            insertMessage: this.db.prepare(`
                INSERT INTO messages (
                    message_id, session_id, turn_id, role, content_json, metadata_json, compacted, created_at
                ) VALUES (
                    @message_id, @session_id, @turn_id, @role, @content_json, @metadata_json, @compacted, @created_at
                )
            `),
            listMessages: this.db.prepare(`
                SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, message_id LIMIT ?
            `),
            markMessagesCompacted: this.db.prepare(`
                UPDATE messages SET compacted = 1 WHERE session_id = ? AND message_id <> ?
            `),
            upsertToolCall: this.db.prepare(`
                INSERT INTO tool_calls (
                    tool_call_id, session_id, turn_id, tool_name, state, arguments_hash,
                    argument_summary, output_summary, error, created_at, updated_at
                ) VALUES (
                    @tool_call_id, @session_id, @turn_id, @tool_name, @state, @arguments_hash,
                    @argument_summary, @output_summary, @error, @created_at, @updated_at
                ) ON CONFLICT(tool_call_id) DO UPDATE SET
                    state = excluded.state, output_summary = COALESCE(excluded.output_summary, tool_calls.output_summary),
                    error = COALESCE(excluded.error, tool_calls.error), updated_at = excluded.updated_at
            `),
            upsertApproval: this.db.prepare(`
                INSERT INTO approvals (
                    approval_id, session_id, turn_id, tool_call_id, tool_name, arguments_hash,
                    risk_level, state, reason, outcome_json, requested_at, expires_at, resolved_at
                ) VALUES (
                    @approval_id, @session_id, @turn_id, @tool_call_id, @tool_name, @arguments_hash,
                    @risk_level, @state, @reason, @outcome_json, @requested_at, @expires_at, @resolved_at
                ) ON CONFLICT(approval_id) DO UPDATE SET
                    state = excluded.state, outcome_json = excluded.outcome_json,
                    resolved_at = excluded.resolved_at
            `),
            interruptToolCalls: this.db.prepare(`
                UPDATE tool_calls SET state = 'cancelled', error = 'interrupted by runtime restart', updated_at = @now
                WHERE state IN ('requested', 'awaiting-local-approval', 'awaiting-toolbox-approval', 'running')
            `),
            interruptApprovals: this.db.prepare(`
                UPDATE approvals SET state = 'cancelled',
                    outcome_json = '{"approved":false,"reason":"runtime-restarted"}', resolved_at = @now
                WHERE state = 'pending'
            `),
            listToolCalls: this.db.prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at, tool_call_id'),
            listApprovals: this.db.prepare('SELECT * FROM approvals WHERE session_id = ? ORDER BY requested_at, approval_id'),
            insertArtifact: this.db.prepare(`
                INSERT INTO artifacts (artifact_id, session_id, turn_id, kind, path, metadata_json, created_at)
                VALUES (@artifact_id, @session_id, @turn_id, @kind, @path, @metadata_json, @created_at)
            `),
            listArtifacts: this.db.prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at, artifact_id'),
            upsertRuntimeState: this.db.prepare(`
                INSERT INTO runtime_state (session_id, driver_id, state_version, state_json, updated_at)
                VALUES (@session_id, @driver_id, @state_version, @state_json, @updated_at)
                ON CONFLICT(session_id) DO UPDATE SET driver_id = excluded.driver_id,
                    state_version = excluded.state_version, state_json = excluded.state_json,
                    updated_at = excluded.updated_at
            `),
            getRuntimeState: this.db.prepare('SELECT * FROM runtime_state WHERE session_id = ?'),
            insertCheckpoint: this.db.prepare(`
                INSERT INTO checkpoints (
                    checkpoint_id, session_id, turn_id, kind, summary,
                    context_usage_json, metadata_json, created_at
                ) VALUES (
                    @checkpoint_id, @session_id, @turn_id, @kind, @summary,
                    @context_usage_json, @metadata_json, @created_at
                )
            `),
            getCheckpoint: this.db.prepare(`
                SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1
            `),
        };
    }

    saveSession(session) {
        const now = Date.now();
        const row = {
            session_id: session.sessionId,
            parent_session_id: session.parentSessionId || null,
            runtime: session.runtime,
            state: session.state,
            title: session.title || null,
            workspace_root: session.workspaceRoot || null,
            metadata_json: stringify(session.metadata || {}),
            summary: session.summaryText || null,
            context_usage_json: session.contextUsage ? stringify(session.contextUsage) : null,
            created_at: session.createdAt || now,
            updated_at: session.updatedAt || now,
            closed_at: session.closedAt || null,
        };
        const exists = this.statements.getSession.get(session.sessionId);
        if (exists) this.statements.updateSession.run(row);
        else this.statements.insertSession.run(row);
    }

    saveTurn(sessionId, turn, turnIndex) {
        const row = {
            turn_id: turn.turnId,
            session_id: sessionId,
            turn_index: turnIndex,
            state: turn.state,
            prompt: String(turn.prompt || ''),
            error: turn.error || null,
            started_at: turn.startedAt || Date.now(),
            completed_at: turn.completedAt || null,
        };
        const existing = this.db.prepare('SELECT turn_id FROM turns WHERE turn_id = ?').get(turn.turnId);
        if (existing) this.statements.updateTurn.run(row);
        else this.statements.insertTurn.run(row);
    }

    saveEvent(event) {
        this.statements.insertEvent.run({
            event_id: event.eventId,
            session_id: event.sessionId,
            sequence: event.sequence,
            schema_version: event.schemaVersion,
            timestamp: event.timestamp,
            runtime: event.runtime,
            type: event.type,
            turn_id: event.turnId || null,
            message_id: event.messageId || null,
            tool_call_id: event.toolCallId || null,
            approval_id: event.approvalId || null,
            payload_json: stringify(event.payload || {}),
        });
    }

    saveMessage(message) {
        const safe = redactValue(message);
        this.statements.insertMessage.run({
            message_id: safe.messageId || newId('msg'),
            session_id: safe.sessionId,
            turn_id: safe.turnId || null,
            role: safe.role,
            content_json: stringify(safe.content === undefined ? '' : safe.content, 'null'),
            metadata_json: stringify(safe.metadata || {}),
            compacted: safe.compacted ? 1 : 0,
            created_at: safe.createdAt || Date.now(),
        });
    }

    saveToolCall(record) {
        const now = Date.now();
        this.statements.upsertToolCall.run({
            tool_call_id: record.toolCallId,
            session_id: record.sessionId,
            turn_id: record.turnId || null,
            tool_name: record.toolName,
            state: record.state,
            arguments_hash: record.argumentsHash || null,
            argument_summary: record.argumentSummary || null,
            output_summary: record.outputSummary || null,
            error: record.error || null,
            created_at: record.createdAt || now,
            updated_at: now,
        });
    }

    saveApproval(record, outcome) {
        this.statements.upsertApproval.run({
            approval_id: record.approvalId,
            session_id: record.sessionId,
            turn_id: record.turnId || null,
            tool_call_id: record.toolCallId || null,
            tool_name: record.toolName,
            arguments_hash: record.argumentsHash,
            risk_level: record.riskLevel,
            state: record.state,
            reason: record.reason || null,
            outcome_json: outcome ? stringify(outcome) : null,
            requested_at: record.createdAt,
            expires_at: record.expiresAt || null,
            resolved_at: record.resolvedAt || null,
        });
    }

    saveArtifact(record) {
        const artifactId = record.artifactId || newId('artifact');
        this.statements.insertArtifact.run({
            artifact_id: artifactId,
            session_id: record.sessionId,
            turn_id: record.turnId || null,
            kind: String(record.kind || 'file'),
            path: record.path || null,
            metadata_json: stringify(record.metadata || {}),
            created_at: record.createdAt || Date.now(),
        });
        return artifactId;
    }

    saveRuntimeState(record) {
        this.statements.upsertRuntimeState.run({
            session_id: record.sessionId,
            driver_id: String(record.driverId || 'unknown'),
            state_version: String(record.stateVersion || '1'),
            state_json: stringify(record.state || {}),
            updated_at: record.updatedAt || Date.now(),
        });
    }

    saveCheckpoint(record) {
        const checkpointId = record.checkpointId || newId('chk');
        this.statements.insertCheckpoint.run({
            checkpoint_id: checkpointId,
            session_id: record.sessionId,
            turn_id: record.turnId || null,
            kind: record.kind || 'compaction',
            summary: record.summary || null,
            context_usage_json: record.contextUsage ? stringify(record.contextUsage) : null,
            metadata_json: stringify(record.metadata || {}),
            created_at: record.createdAt || Date.now(),
        });
        return checkpointId;
    }

    restore() {
        const now = Date.now();
        this.db.transaction(() => {
            this.statements.interruptTurns.run({ now });
            this.statements.interruptSessions.run({ now });
            this.statements.interruptToolCalls.run({ now });
            this.statements.interruptApprovals.run({ now });
        })();
        return this.statements.listSessions.all().map((row) => ({
            ...this._sessionFromRow(row),
            turns: this.statements.listTurns.all(row.session_id).map((turn) => this._turnFromRow(turn)),
            events: this.getEvents(row.session_id, 0, 2000).events,
        }));
    }

    listSessions() {
        return this.statements.listSessions.all().map((row) => this._sessionFromRow(row));
    }

    getSession(sessionId) {
        const row = this.statements.getSession.get(sessionId);
        if (!row) return null;
        return {
            ...this._sessionFromRow(row),
            turns: this.statements.listTurns.all(sessionId).map((turn) => this._turnFromRow(turn)),
        };
    }

    deleteSession(sessionId) {
        return this.statements.deleteSession.run(sessionId).changes > 0;
    }

    getEvents(sessionId, sinceSequence = 0, limit = 2000) {
        const rows = this.statements.listEvents.all(sessionId, sinceSequence, limit);
        return {
            events: rows.map((row) => ({
                schemaVersion: row.schema_version,
                eventId: row.event_id,
                sequence: row.sequence,
                timestamp: row.timestamp,
                sessionId: row.session_id,
                turnId: row.turn_id || undefined,
                messageId: row.message_id || undefined,
                toolCallId: row.tool_call_id || undefined,
                approvalId: row.approval_id || undefined,
                runtime: row.runtime,
                type: row.type,
                payload: parseJson(row.payload_json, {}),
            })),
            lastSequence: this.statements.lastSequence.get(sessionId).sequence,
            droppedCount: 0,
        };
    }

    getMessages(sessionId, limit = 5000) {
        return this.statements.listMessages.all(sessionId, limit).map((row) => ({
            messageId: row.message_id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            role: row.role,
            content: parseJson(row.content_json, ''),
            metadata: parseJson(row.metadata_json, {}),
            compacted: Boolean(row.compacted),
            createdAt: row.created_at,
        }));
    }

    markMessagesCompacted(sessionId, retainedMessageId) {
        return this.statements.markMessagesCompacted.run(sessionId, retainedMessageId).changes;
    }

    getToolCalls(sessionId) {
        return this.statements.listToolCalls.all(sessionId).map((row) => ({
            toolCallId: row.tool_call_id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            toolName: row.tool_name,
            state: row.state,
            argumentsHash: row.arguments_hash,
            argumentSummary: row.argument_summary,
            outputSummary: row.output_summary,
            error: row.error,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        }));
    }

    getApprovals(sessionId) {
        return this.statements.listApprovals.all(sessionId).map((row) => ({
            approvalId: row.approval_id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            toolCallId: row.tool_call_id,
            toolName: row.tool_name,
            argumentsHash: row.arguments_hash,
            riskLevel: row.risk_level,
            state: row.state,
            reason: row.reason,
            outcome: parseJson(row.outcome_json),
            requestedAt: row.requested_at,
            expiresAt: row.expires_at,
            resolvedAt: row.resolved_at,
        }));
    }

    getArtifacts(sessionId) {
        return this.statements.listArtifacts.all(sessionId).map((row) => ({
            artifactId: row.artifact_id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            kind: row.kind,
            path: row.path,
            metadata: parseJson(row.metadata_json, {}),
            createdAt: row.created_at,
        }));
    }

    getRuntimeState(sessionId) {
        const row = this.statements.getRuntimeState.get(sessionId);
        if (!row) return null;
        return {
            sessionId: row.session_id,
            driverId: row.driver_id,
            stateVersion: row.state_version,
            state: parseJson(row.state_json, {}),
            updatedAt: row.updated_at,
        };
    }

    getLatestCheckpoint(sessionId) {
        const row = this.statements.getCheckpoint.get(sessionId);
        if (!row) return null;
        return {
            checkpointId: row.checkpoint_id,
            sessionId: row.session_id,
            turnId: row.turn_id,
            kind: row.kind,
            summary: row.summary,
            contextUsage: parseJson(row.context_usage_json),
            metadata: parseJson(row.metadata_json, {}),
            createdAt: row.created_at,
        };
    }

    transaction(fn) {
        return this.db.transaction(fn)();
    }

    close() {
        if (this.db && this.db.open) this.db.close();
    }

    _sessionFromRow(row) {
        return {
            sessionId: row.session_id,
            parentSessionId: row.parent_session_id,
            runtime: row.runtime,
            state: row.state,
            title: row.title,
            workspaceRoot: row.workspace_root,
            metadata: parseJson(row.metadata_json, {}),
            summaryText: row.summary,
            contextUsage: parseJson(row.context_usage_json),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            closedAt: row.closed_at,
            lastSequence: this.statements.lastSequence.get(row.session_id).sequence,
        };
    }

    _turnFromRow(row) {
        return {
            turnId: row.turn_id,
            prompt: row.prompt,
            state: row.state,
            error: row.error,
            startedAt: row.started_at,
            completedAt: row.completed_at,
            turnIndex: row.turn_index,
        };
    }
}

module.exports = {
    AgentRuntimeRepository,
    parseJson,
};
