'use strict';

const path = require('path');
const crypto = require('crypto');
const { migrate } = require('./migrations');
const {
    SESSION_CONFIG_SCHEMA_VERSION,
    BLOCK_CONTENT_SCHEMA_VERSION,
    normalizeSessionConfig,
    normalizeApplyState,
} = require('../dataContracts');
const { normalizeProjectionSnapshot, projectionPatchBetween } = require('./v2');
const { reorderReconciledMessages } = require('./reconcile-order');
const { mapBlockRow, mapOperationRow, mapSessionRow } = require('./rowMappers');
const { mergeProjectionContent } = require('./contentMerge');

function parseJson(value, fallback) {
    try {
        return value == null ? fallback : JSON.parse(value);
    } catch (_error) {
        return fallback;
    }
}

function json(value) {
    return JSON.stringify(value ?? null);
}

function mergeStoredBlockContent(existingContent, block, options) {
    if (options.authoritative && block.replaceContent === true) return block.content || {};
    if (!options.authoritative || !Array.isArray(block.replaceFields)) {
        return mergeProjectionContent(existingContent, block.content || {});
    }
    const content = { ...existingContent };
    const fields = new Set(block.replaceFields);
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(block.content || {}, field)) content[field] = block.content[field];
    }
    for (const [field, value] of Object.entries(block.content || {})) {
        if (!fields.has(field)) content[field] = mergeProjectionContent(content[field], value);
    }
    return content;
}

function upsertItemBlock(stmt, sessionId, record, block, existing, session, now, options) {
    const ordinal = Number.isInteger(block.ordinal) ? block.ordinal : 0;
    const existingBlock = stmt.getBlock.get(existing.message_id, ordinal);
    const content = mergeStoredBlockContent(parseJson(existingBlock?.content_json, {}), block, options);
    if (block.kind === 'reasoning') {
        if (!Array.isArray(content.summary)) content.summary = [];
        if (!Array.isArray(content.content)) content.content = [];
    }
    stmt.upsertBlock.run({
        block_id: block.blockId || existingBlock?.block_id || `block:${sessionId}:${record.itemId}:${ordinal}`,
        message_id: existing.message_id,
        kind: block.kind || existingBlock?.kind,
        status: block.status || record.status || 'inProgress',
        ordinal,
        content_json: json(content),
        content_schema_version: BLOCK_CONTENT_SCHEMA_VERSION,
        authority: block.authority || existingBlock?.authority || 'codex',
        created_at: existingBlock?.created_at || block.createdAt || now,
        updated_at: now,
    });
}

class AgentProjectionRepository {
    constructor(options = {}) {
        const Database = options.Database || require('better-sqlite3');
        this.databasePath = options.databasePath
            || path.join(options.userDataPath || process.cwd(), 'codex-agent-projection.sqlite');
        this.readOnly = options.readOnly === true;
        this.degradedReason = options.degradedReason || null;
        this.db = options.db || new Database(this.databasePath, this.readOnly ? { readonly: true, fileMustExist: true } : undefined);
        try {
            if (this.readOnly) {
                this.db.pragma('query_only = ON');
                this.db.pragma('busy_timeout = 5000');
                const quickCheck = this.db.pragma('quick_check', { simple: true });
                if (quickCheck !== 'ok') throw new Error(`Agent projection quick_check failed in read-only mode: ${quickCheck}`);
                const foreignKeyErrors = this.db.pragma('foreign_key_check');
                if (foreignKeyErrors.length) throw new Error('Agent projection foreign_key_check failed in read-only mode');
                this.schemaVersion = Number(this.db.prepare('SELECT version FROM projection_schema LIMIT 1').get()?.version || 0);
            } else {
                this.schemaVersion = migrate(this.db, { databasePath: options.db ? null : this.databasePath });
            }
            this._prepare();
        } catch (error) {
            if (!options.db) {
                try { this.db.close(); } catch {}
            }
            throw error;
        }
    }

    assertWritable() {
        if (!this.readOnly) return;
        const error = new Error('Agent projection database is in read-only degraded mode');
        error.code = 'PROJECTION_READ_ONLY';
        throw error;
    }

    _prepare() {
        this.stmt = {
            upsertSession: this.db.prepare(`
                INSERT INTO agent_sessions (
                    session_id, codex_thread_id, agent_id, agent_catalog_id, agent_name_snapshot,
                    title, workspace_root, state,
                    config_snapshot_json, config_revision, config_schema_version,
                    applied_config_snapshot_json, applied_config_revision, config_apply_state,
                    config_apply_error, config_apply_updated_at,
                    orphaned, pinned_at, created_at, updated_at, archived_at
                ) VALUES (
                    @session_id, @codex_thread_id, @agent_id, @agent_catalog_id, @agent_name_snapshot,
                    @title, @workspace_root, @state,
                    @config_snapshot_json, @config_revision, @config_schema_version,
                    @applied_config_snapshot_json, @applied_config_revision, @config_apply_state,
                    @config_apply_error, @config_apply_updated_at,
                    @orphaned, @pinned_at, @created_at, @updated_at, @archived_at
                ) ON CONFLICT(session_id) DO UPDATE SET
                    codex_thread_id = COALESCE(excluded.codex_thread_id, agent_sessions.codex_thread_id),
                    agent_id = excluded.agent_id,
                    agent_catalog_id = COALESCE(excluded.agent_catalog_id, agent_sessions.agent_catalog_id),
                    agent_name_snapshot = COALESCE(excluded.agent_name_snapshot, agent_sessions.agent_name_snapshot),
                    title = COALESCE(excluded.title, agent_sessions.title),
                    workspace_root = COALESCE(excluded.workspace_root, agent_sessions.workspace_root),
                    state = excluded.state,
                    config_snapshot_json = excluded.config_snapshot_json,
                    config_revision = excluded.config_revision,
                    config_schema_version = excluded.config_schema_version,
                    applied_config_snapshot_json = excluded.applied_config_snapshot_json,
                    applied_config_revision = excluded.applied_config_revision,
                    config_apply_state = excluded.config_apply_state,
                    config_apply_error = excluded.config_apply_error,
                    config_apply_updated_at = excluded.config_apply_updated_at,
                    orphaned = excluded.orphaned,
                    pinned_at = excluded.pinned_at,
                    updated_at = excluded.updated_at,
                    archived_at = excluded.archived_at
            `),
            getSession: this.db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?'),
            getByThread: this.db.prepare('SELECT * FROM agent_sessions WHERE codex_thread_id = ?'),
            listSessions: this.db.prepare(`
                SELECT * FROM agent_sessions WHERE archived_at IS NULL
                ORDER BY CASE WHEN pinned_at IS NULL THEN 1 ELSE 0 END, pinned_at DESC, updated_at DESC, session_id
            `),
            listArchivedSessions: this.db.prepare(`
                SELECT * FROM agent_sessions WHERE archived_at IS NOT NULL
                ORDER BY archived_at DESC, updated_at DESC, session_id
            `),
            archiveSession: this.db.prepare(`
                UPDATE agent_sessions SET archived_at = @now, updated_at = @now, state = 'archived'
                WHERE session_id = @session_id
            `),
            unarchiveSession: this.db.prepare(`
                UPDATE agent_sessions SET archived_at = NULL, state = 'ready', updated_at = @now
                WHERE session_id = @session_id
            `),
            setPinned: this.db.prepare(`
                UPDATE agent_sessions SET pinned_at = @pinned_at, updated_at = @now
                WHERE session_id = @session_id
            `),
            setOrphaned: this.db.prepare(`
                UPDATE agent_sessions SET orphaned = @orphaned, state = @state,
                    updated_at = @now WHERE session_id = @session_id
            `),
            replaceUnmaterializedThread: this.db.prepare(`
                UPDATE agent_sessions SET codex_thread_id = @codex_thread_id,
                    orphaned = 0, state = 'ready', updated_at = @now
                WHERE session_id = @session_id
            `),
            updateSessionConfigCas: this.db.prepare(`
                UPDATE agent_sessions SET config_snapshot_json = @config_snapshot_json,
                    config_revision = config_revision + 1,
                    config_schema_version = @config_schema_version,
                    config_apply_state = CASE WHEN codex_thread_id IS NULL THEN 'unmaterialized' ELSE 'pending' END,
                    config_apply_error = NULL,
                    config_apply_updated_at = @now,
                    workspace_root = @workspace_root,
                    agent_name_snapshot = @agent_name_snapshot,
                    updated_at = @now
                WHERE session_id = @session_id AND config_revision = @expected_revision
            `),
            markConfigApplying: this.db.prepare(`
                UPDATE agent_sessions SET config_apply_state = 'applying', config_apply_error = NULL,
                    config_apply_updated_at = @now
                WHERE session_id = @session_id AND config_revision = @config_revision
            `),
            markConfigApplied: this.db.prepare(`
                UPDATE agent_sessions SET applied_config_snapshot_json = @applied_config_snapshot_json,
                    applied_config_revision = @config_revision, config_apply_state = 'applied',
                    config_apply_error = NULL, config_apply_updated_at = @now
                WHERE session_id = @session_id AND config_revision = @config_revision
            `),
            markConfigFailed: this.db.prepare(`
                UPDATE agent_sessions SET config_apply_state = 'error', config_apply_error = @error,
                    config_apply_updated_at = @now
                WHERE session_id = @session_id AND config_revision = @config_revision
            `),
            getMessageByItem: this.db.prepare(`
                SELECT * FROM agent_messages WHERE session_id = ? AND codex_item_id = ?
            `),
            upsertMessage: this.db.prepare(`
                INSERT INTO agent_messages (
                    message_id, session_id, codex_thread_id, codex_turn_id, codex_item_id,
                    role, status, source_order, created_at, updated_at
                ) VALUES (
                    @message_id, @session_id, @codex_thread_id, @codex_turn_id, @codex_item_id,
                    @role, @status, @source_order, @created_at, @updated_at
                ) ON CONFLICT(session_id, codex_item_id) DO UPDATE SET
                    codex_turn_id = COALESCE(excluded.codex_turn_id, agent_messages.codex_turn_id),
                    role = excluded.role, status = excluded.status, updated_at = excluded.updated_at
            `),
            listMessages: this.db.prepare(`
                SELECT * FROM agent_messages WHERE session_id = ? ORDER BY source_order, message_id
            `),
            setMessageSourceOrder: this.db.prepare(`
                UPDATE agent_messages SET source_order = @source_order WHERE message_id = @message_id
            `),
            listMessageAuthorities: this.db.prepare(`
                SELECT messages.codex_item_id, messages.message_id,
                    SUM(CASE WHEN blocks.authority = 'codex' THEN 1 ELSE 0 END) AS codex_block_count,
                    SUM(CASE WHEN blocks.authority IS NOT NULL AND blocks.authority != 'codex' THEN 1 ELSE 0 END)
                        AS local_block_count
                FROM agent_messages AS messages
                LEFT JOIN agent_blocks AS blocks ON blocks.message_id = messages.message_id
                WHERE messages.session_id = ?
                GROUP BY messages.codex_item_id, messages.message_id
            `),
            deleteMessage: this.db.prepare(`
                DELETE FROM agent_messages WHERE session_id = ? AND codex_item_id = ?
            `),
            upsertBlock: this.db.prepare(`
                INSERT INTO agent_blocks (
                    block_id, message_id, kind, status, ordinal, content_json, content_schema_version,
                    authority, created_at, updated_at
                ) VALUES (
                    @block_id, @message_id, @kind, @status, @ordinal, @content_json, @content_schema_version,
                    @authority, @created_at, @updated_at
                ) ON CONFLICT(message_id, ordinal) DO UPDATE SET
                    kind = excluded.kind, status = excluded.status,
                    content_json = excluded.content_json, content_schema_version = excluded.content_schema_version,
                    authority = excluded.authority,
                    updated_at = excluded.updated_at
            `),
            getBlock: this.db.prepare('SELECT * FROM agent_blocks WHERE message_id = ? AND ordinal = ?'),
            listBlocks: this.db.prepare('SELECT * FROM agent_blocks WHERE message_id = ? ORDER BY ordinal'),
            deleteCodexBlocksExcept: this.db.prepare(`
                DELETE FROM agent_blocks WHERE message_id = @message_id AND authority = 'codex'
                    AND ordinal NOT IN (SELECT value FROM json_each(@ordinals_json))
            `),
            getState: this.db.prepare('SELECT * FROM projection_state WHERE session_id = ?'),
            createState: this.db.prepare(`
                INSERT OR IGNORE INTO projection_state(session_id, next_source_order, updated_at)
                VALUES (?, 1, ?)
            `),
            advanceOrder: this.db.prepare(`
                UPDATE projection_state SET next_source_order = next_source_order + 1, updated_at = @now
                WHERE session_id = @session_id
            `),
            setNextSourceOrder: this.db.prepare(`
                UPDATE projection_state SET next_source_order = @next_source_order, updated_at = @now
                WHERE session_id = @session_id
            `),
            advanceGeneration: this.db.prepare(`
                UPDATE projection_state SET mutation_generation = mutation_generation + 1, updated_at = @now
                WHERE session_id = @session_id
            `),
            setReconciled: this.db.prepare(`
                UPDATE projection_state SET last_reconciled_at = @now, last_error = NULL, updated_at = @now
                WHERE session_id = @session_id
            `),
            setError: this.db.prepare(`
                UPDATE projection_state SET last_error = @error, updated_at = @now WHERE session_id = @session_id
            `),
            setActivity: this.db.prepare(`
                UPDATE projection_state SET activity_json = @activity_json, updated_at = @now
                WHERE session_id = @session_id
            `),
            insertPendingInput: this.db.prepare(`
                INSERT OR IGNORE INTO agent_pending_inputs(
                    input_id, session_id, dedupe_key, submission_id, kind, target_turn_id,
                    prompt, state, client_message_id,
                    attempt_count, created_at, updated_at
                ) VALUES (
                    @input_id, @session_id, @dedupe_key, @submission_id, @kind, @target_turn_id,
                    @prompt, 'queued', @client_message_id,
                    0, @created_at, @created_at
                )
            `),
            getPendingInputByKey: this.db.prepare(`
                SELECT * FROM agent_pending_inputs WHERE session_id = ? AND dedupe_key = ?
            `),
            listPendingInputs: this.db.prepare(`
                SELECT * FROM agent_pending_inputs WHERE session_id = ? ORDER BY created_at, input_id
            `),
            deletePendingInput: this.db.prepare('DELETE FROM agent_pending_inputs WHERE input_id = ?'),
            updatePendingInput: this.db.prepare(`
                UPDATE agent_pending_inputs SET state = @state,
                    dedupe_key = @dedupe_key,
                    submission_id = @submission_id,
                    kind = @kind,
                    target_turn_id = @target_turn_id,
                    prompt = @prompt,
                    client_message_id = @client_message_id,
                    codex_turn_id = @codex_turn_id,
                    attempt_count = @attempt_count,
                    last_error = @last_error,
                    updated_at = @updated_at
                WHERE input_id = @input_id
            `),
            insertOperation: this.db.prepare(`
                INSERT INTO agent_operations(
                    operation_id, session_id, kind, state, codex_thread_id,
                    payload_json, last_error, created_at, updated_at
                ) VALUES (
                    @operation_id, @session_id, @kind, @state, @codex_thread_id,
                    @payload_json, @last_error, @created_at, @updated_at
                )
            `),
            updateOperation: this.db.prepare(`
                UPDATE agent_operations SET state = @state,
                    codex_thread_id = COALESCE(@codex_thread_id, codex_thread_id),
                    payload_json = @payload_json,
                    last_error = @last_error,
                    updated_at = @updated_at
                WHERE operation_id = @operation_id
            `),
            getOperation: this.db.prepare('SELECT * FROM agent_operations WHERE operation_id = ?'),
            listRecoverableOperations: this.db.prepare(`
                SELECT * FROM agent_operations
                WHERE state IN ('prepared', 'dispatching', 'remote-applied', 'uncertain', 'failed')
                ORDER BY updated_at, operation_id
            `),
            deleteSession: this.db.prepare('DELETE FROM agent_sessions WHERE session_id = ?'),
            insertDeletionReceipt: this.db.prepare(`
                INSERT INTO agent_deletion_receipts(receipt_id, session_hash, codex_thread_hash, deleted_at)
                VALUES (@receipt_id, @session_hash, @codex_thread_hash, @deleted_at)
            `),
        };
        this.upsertItemTransaction = this.db.transaction((sessionId, record, block, options = {}) => {
            this._upsertItem(sessionId, record, block, options);
            this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
        });
        this.reconcileItemsTransaction = this.db.transaction((sessionId, entries, expectedGeneration, deleteMissing = true) => {
            const state = this.stmt.getState.get(sessionId);
            if (Number.isInteger(expectedGeneration) && state?.mutation_generation !== expectedGeneration) {
                return false;
            }
            const rowsBefore = this.stmt.listMessages.all(sessionId);
            if (deleteMissing) {
                const incomingItemIds = new Set(entries.map((entry) => String(entry.record.itemId)));
                for (const row of this.stmt.listMessageAuthorities.all(sessionId)) {
                    if (!incomingItemIds.has(String(row.codex_item_id))) {
                        if (Number(row.local_block_count) > 0) {
                            this.stmt.deleteCodexBlocksExcept.run({
                                message_id: row.message_id,
                                ordinals_json: '[]',
                            });
                        } else {
                            this.stmt.deleteMessage.run(sessionId, row.codex_item_id);
                        }
                    }
                }
            }
            for (const entry of entries) {
                const blocks = Array.isArray(entry.blocks) ? entry.blocks : [entry.block];
                const validBlocks = blocks.filter(Boolean);
                for (const block of validBlocks) this._upsertItem(sessionId, entry.record, block, { authoritative: true });
                if (entry.authoritativeOrdinals !== false) {
                    const message = this.stmt.getMessageByItem.get(sessionId, entry.record.itemId);
                    if (message) this.stmt.deleteCodexBlocksExcept.run({
                        message_id: message.message_id,
                        ordinals_json: JSON.stringify(validBlocks.map((block) => Number.isInteger(block.ordinal) ? block.ordinal : 0)),
                    });
                }
            }
            reorderReconciledMessages(this.stmt, sessionId, entries, rowsBefore);
            this.stmt.setReconciled.run({ session_id: sessionId, now: Date.now() });
            this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
            return true;
        });
    }

    saveSession(session) {
        const now = Date.now();
        const sessionId = String(session.sessionId || `codex_session_${crypto.randomUUID()}`);
        const desiredConfig = normalizeSessionConfig({
            ...(session.configSnapshot || {}),
            workspaceRoot: session.workspaceRoot || session.configSnapshot?.workspaceRoot || '',
        });
        const appliedConfig = normalizeSessionConfig(session.appliedRuntimeConfig || desiredConfig);
        const configRevision = Number.isInteger(session.configRevision) ? session.configRevision : 1;
        this.stmt.upsertSession.run({
            session_id: sessionId,
            codex_thread_id: session.threadId || null,
            agent_id: String(session.agentId || 'codex'),
            agent_catalog_id: session.agentCatalogId || null,
            agent_name_snapshot: session.agentNameSnapshot || null,
            title: session.title || null,
            workspace_root: session.workspaceRoot || null,
            state: session.state || 'ready',
            config_snapshot_json: json(desiredConfig),
            config_revision: configRevision,
            config_schema_version: SESSION_CONFIG_SCHEMA_VERSION,
            applied_config_snapshot_json: json(appliedConfig),
            applied_config_revision: Number.isInteger(session.appliedRuntimeConfigRevision)
                ? session.appliedRuntimeConfigRevision : (session.threadId ? configRevision : 0),
            config_apply_state: normalizeApplyState(session.configApplyState,
                session.threadId ? 'applied' : 'unmaterialized'),
            config_apply_error: session.configApplyError || null,
            config_apply_updated_at: session.configApplyUpdatedAt || now,
            orphaned: session.orphaned ? 1 : 0,
            pinned_at: session.pinnedAt || null,
            created_at: session.createdAt || now,
            updated_at: session.updatedAt || now,
            archived_at: session.archivedAt || null,
        });
        this.stmt.createState.run(sessionId, now);
        return this.getSession(sessionId);
    }

    updateSessionConfig(sessionId, expectedRevision, { configSnapshot, workspaceRoot, agentNameSnapshot }) {
        const current = this.getSession(sessionId);
        if (!current) return { updated: false, reason: 'not-found', session: null };
        const result = this.stmt.updateSessionConfigCas.run({
            session_id: String(sessionId),
            expected_revision: Number(expectedRevision),
            config_snapshot_json: json(normalizeSessionConfig({
                ...(configSnapshot || {}),
                workspaceRoot: workspaceRoot || current.workspaceRoot || configSnapshot?.workspaceRoot || '',
            })),
            config_schema_version: SESSION_CONFIG_SCHEMA_VERSION,
            workspace_root: workspaceRoot || current.workspaceRoot || null,
            agent_name_snapshot: agentNameSnapshot || current.agentNameSnapshot || null,
            now: Date.now(),
        });
        if (result.changes !== 1) return { updated: false, reason: 'conflict', session: this.getSession(sessionId) };
        return { updated: true, session: this.getSession(sessionId) };
    }

    markSessionConfigApplying(sessionId, configRevision) {
        this.stmt.markConfigApplying.run({ session_id: String(sessionId), config_revision: Number(configRevision), now: Date.now() });
        return this.getSession(sessionId);
    }

    markSessionConfigApplied(sessionId, configRevision, configSnapshot) {
        this.stmt.markConfigApplied.run({
            session_id: String(sessionId), config_revision: Number(configRevision),
            applied_config_snapshot_json: json(normalizeSessionConfig({
                ...(configSnapshot || {}),
                workspaceRoot: this.getSession(sessionId)?.workspaceRoot || configSnapshot?.workspaceRoot || '',
            })), now: Date.now(),
        });
        return this.getSession(sessionId);
    }

    markSessionConfigFailed(sessionId, configRevision, error) {
        this.stmt.markConfigFailed.run({
            session_id: String(sessionId), config_revision: Number(configRevision),
            error: String(error || 'Runtime configuration could not be applied'), now: Date.now(),
        });
        return this.getSession(sessionId);
    }

    getSession(sessionId) {
        const row = this.stmt.getSession.get(sessionId);
        return row ? this._session(row) : null;
    }

    getSessionByThread(threadId) {
        const row = this.stmt.getByThread.get(threadId);
        return row ? this._session(row) : null;
    }

    listSessions(options = {}) {
        const rows = options.archived === true
            ? this.stmt.listArchivedSessions.all()
            : this.stmt.listSessions.all();
        return rows.map((row) => this._session(row));
    }

    readProjection(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) return null;
        const messages = this.stmt.listMessages.all(sessionId).map((row) => ({
            messageId: row.message_id,
            sessionId: row.session_id,
            threadId: row.codex_thread_id,
            turnId: row.codex_turn_id,
            itemId: row.codex_item_id,
            role: row.role,
            status: row.status,
            sourceOrder: row.source_order,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            blocks: this.stmt.listBlocks.all(row.message_id).map((block) => this._block(block)),
        }));
        const state = this.stmt.getState.get(sessionId);
        const result = {
            session,
            messages,
            projectionRevision: Number(state?.mutation_generation || 0),
            storage: { readOnly: this.readOnly, degradedReason: this.degradedReason },
            projection: state ? {
                lastReconciledAt: state.last_reconciled_at,
                lastError: state.last_error,
                activity: parseJson(state.activity_json, {}),
                mutationGeneration: Number(state.mutation_generation || 0),
            } : null,
        };
        result.normalized = normalizeProjectionSnapshot(result);
        return result;
    }

    getProjectedMessageByItem(sessionId, itemId) {
        const row = this.stmt.getMessageByItem.get(sessionId, itemId);
        if (!row) return null;
        return {
            messageId: row.message_id,
            sessionId: row.session_id,
            threadId: row.codex_thread_id,
            turnId: row.codex_turn_id,
            itemId: row.codex_item_id,
            role: row.role,
            status: row.status,
            sourceOrder: row.source_order,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            blocks: this.stmt.listBlocks.all(row.message_id).map((block) => this._block(block)),
        };
    }

    upsertItem(sessionId, record, block, options = {}) {
        if (Array.isArray(block)) {
            this.db.transaction(() => {
                for (const entry of block.filter(Boolean)) this._upsertItem(sessionId, record, entry, options);
                this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
            })();
        } else {
            this.upsertItemTransaction(sessionId, record, block, options);
        }
        return this.stmt.getMessageByItem.get(sessionId, record.itemId);
    }

    projectionGeneration(sessionId) {
        return Number(this.stmt.getState.get(sessionId)?.mutation_generation || 0);
    }

    updateActivity(sessionId, patch = {}) {
        const state = this.stmt.getState.get(sessionId);
        if (!state) return null;
        const current = parseJson(state.activity_json, {});
        const activity = mergeProjectionContent(current, patch);
        this.stmt.setActivity.run({
            session_id: sessionId,
            activity_json: json(activity),
            now: Date.now(),
        });
        return activity;
    }

    reconcileItems(sessionId, entries, expectedGeneration = undefined, options = {}) {
        const before = this.readProjection(sessionId);
        const applied = this.reconcileItemsTransaction(
            sessionId, entries, expectedGeneration, options.deleteMissing !== false,
        );
        const projection = this.readProjection(sessionId);
        return { applied, projection, patch: applied ? projectionPatchBetween(before, projection) : null };
    }

    _upsertItem(sessionId, record, block, options = {}) {
        const session = this.stmt.getSession.get(sessionId);
        if (!session) throw new Error(`Unknown Agent projection session: ${sessionId}`);
        const now = Date.now();
        let existing = this.stmt.getMessageByItem.get(sessionId, record.itemId);
        if (!existing) {
            const state = this.stmt.getState.get(sessionId);
            const sourceOrder = state?.next_source_order || 1;
            this.stmt.advanceOrder.run({ session_id: sessionId, now });
            existing = {
                message_id: record.messageId || `msg:${sessionId}:${record.itemId}`,
                source_order: sourceOrder,
                created_at: record.createdAt || now,
            };
        }
        this.stmt.upsertMessage.run({
            message_id: existing.message_id,
            session_id: sessionId,
            codex_thread_id: record.threadId || session.codex_thread_id,
            codex_turn_id: record.turnId || null,
            codex_item_id: record.itemId,
            role: record.role || 'assistant',
            status: record.status || 'inProgress',
            source_order: existing.source_order,
            created_at: existing.created_at,
            updated_at: now,
        });
        if (block) upsertItemBlock(this.stmt, sessionId, record, block, existing, session, now, options);
    }

    appendBlockText(sessionId, itemId, ordinal, delta, kind = 'message') {
        const message = this.stmt.getMessageByItem.get(sessionId, itemId);
        if (!message) throw new Error(`Unknown Codex item: ${itemId}`);
        let block = this.stmt.getBlock.get(message.message_id, ordinal);
        if (!block) {
            const now = Date.now();
            block = {
                block_id: `block:${sessionId}:${itemId}:${ordinal}`,
                message_id: message.message_id,
                kind,
                status: 'inProgress',
                ordinal,
                content_json: '{}',
                created_at: now,
                updated_at: now,
            };
        }
        const content = parseJson(block.content_json, {});
        content.text = `${content.text || ''}${String(delta || '')}`;
        this.stmt.upsertBlock.run({
            block_id: block.block_id,
            message_id: block.message_id,
            kind: block.kind || kind,
            status: block.status,
            ordinal,
            content_json: json(content),
            content_schema_version: BLOCK_CONTENT_SCHEMA_VERSION,
            authority: block.authority || 'codex',
            created_at: block.created_at,
            updated_at: Date.now(),
        });
        this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
    }

    ensureReasoningPart(sessionId, itemId, field, index) {
        if (!['summary', 'content'].includes(field) || !Number.isInteger(index) || index < 0) return false;
        const message = this.stmt.getMessageByItem.get(sessionId, itemId);
        if (!message) return false;
        const block = this.stmt.getBlock.get(message.message_id, 0);
        const content = block ? parseJson(block.content_json, {}) : { summary: [], content: [] };
        const values = Array.isArray(content[field]) ? [...content[field]] : [];
        while (values.length <= index) values.push('');
        content[field] = values;
        this.stmt.upsertBlock.run({
            block_id: block?.block_id || `block:${sessionId}:${itemId}:0`,
            message_id: message.message_id,
            kind: 'reasoning',
            status: block?.status || 'inProgress',
            ordinal: 0,
            content_json: json(content),
            content_schema_version: BLOCK_CONTENT_SCHEMA_VERSION,
            authority: block?.authority || 'codex',
            created_at: block?.created_at || Date.now(),
            updated_at: Date.now(),
        });
        this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
        return true;
    }

    appendReasoningText(sessionId, itemId, field, index, delta) {
        if (!['summary', 'content'].includes(field) || !Number.isInteger(index) || index < 0) return false;
        const message = this.stmt.getMessageByItem.get(sessionId, itemId);
        if (!message) return false;
        const block = this.stmt.getBlock.get(message.message_id, 0);
        const content = block ? parseJson(block.content_json, {}) : { summary: [], content: [] };
        const values = Array.isArray(content[field]) ? [...content[field]] : [];
        while (values.length <= index) values.push('');
        values[index] = `${values[index] || ''}${String(delta || '')}`;
        content[field] = values;
        this.stmt.upsertBlock.run({
            block_id: block?.block_id || `block:${sessionId}:${itemId}:0`,
            message_id: message.message_id,
            kind: 'reasoning',
            status: block?.status || 'inProgress',
            ordinal: 0,
            content_json: json(content),
            content_schema_version: BLOCK_CONTENT_SCHEMA_VERSION,
            authority: block?.authority || 'codex',
            created_at: block?.created_at || Date.now(),
            updated_at: Date.now(),
        });
        this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
        return true;
    }

    markReconciled(sessionId) {
        this.stmt.setReconciled.run({ session_id: sessionId, now: Date.now() });
    }

    markProjectionError(sessionId, error) {
        this.stmt.setError.run({ session_id: sessionId, error: String(error || ''), now: Date.now() });
    }

    markOrphaned(sessionId, orphaned = true) {
        this.stmt.setOrphaned.run({
            session_id: sessionId,
            orphaned: orphaned ? 1 : 0,
            state: orphaned ? 'orphaned' : 'ready',
            now: Date.now(),
        });
    }

    replaceUnmaterializedThread(sessionId, threadId) {
        this.stmt.replaceUnmaterializedThread.run({
            session_id: sessionId,
            codex_thread_id: String(threadId),
            now: Date.now(),
        });
        return this.getSession(sessionId);
    }

    archiveSession(sessionId) {
        this.stmt.archiveSession.run({ session_id: sessionId, now: Date.now() });
        return this.getSession(sessionId);
    }

    unarchiveSession(sessionId) {
        this.stmt.unarchiveSession.run({ session_id: sessionId, now: Date.now() });
        return this.getSession(sessionId);
    }

    setPinned(sessionId, pinned) {
        this.stmt.setPinned.run({
            session_id: sessionId,
            pinned_at: pinned ? Date.now() : null,
            now: Date.now(),
        });
        return this.getSession(sessionId);
    }

    enqueuePendingInput(sessionId, {
        dedupeKey, submissionId, kind = 'follow-up', targetTurnId = null, prompt, clientMessageId,
    }) {
        const inputId = `pending:${crypto.randomUUID()}`;
        const stableSubmissionId = String(submissionId || dedupeKey || `submission:${crypto.randomUUID()}`);
        const stableClientMessageId = String(clientMessageId || `client_msg:${crypto.randomUUID()}`);
        const now = Date.now();
        this.stmt.insertPendingInput.run({
            input_id: inputId,
            session_id: sessionId,
            dedupe_key: stableSubmissionId,
            submission_id: stableSubmissionId,
            kind: String(kind || 'follow-up'),
            target_turn_id: targetTurnId ? String(targetTurnId) : null,
            prompt: String(prompt),
            client_message_id: stableClientMessageId,
            created_at: now,
        });
        return this.listPendingInputs(sessionId)
            .find((entry) => entry.submissionId === stableSubmissionId) || null;
    }

    listPendingInputs(sessionId) {
        return this.stmt.listPendingInputs.all(sessionId).map((row) => ({
            inputId: row.input_id,
            sessionId: row.session_id,
            dedupeKey: row.dedupe_key,
            submissionId: row.submission_id || row.dedupe_key,
            kind: row.kind || 'follow-up',
            targetTurnId: row.target_turn_id || null,
            prompt: row.prompt,
            state: row.state,
            clientMessageId: row.client_message_id,
            turnId: row.codex_turn_id,
            attemptCount: row.attempt_count,
            updatedAt: row.updated_at,
            lastError: row.last_error,
            createdAt: row.created_at,
        }));
    }

    updatePendingInput(inputId, patch = {}) {
        const row = this.db.prepare('SELECT * FROM agent_pending_inputs WHERE input_id = ?').get(String(inputId));
        if (!row) return null;
        this.stmt.updatePendingInput.run({
            input_id: String(inputId),
            state: patch.state || row.state,
            dedupe_key: Object.prototype.hasOwnProperty.call(patch, 'submissionId')
                ? String(patch.submissionId) : row.dedupe_key,
            submission_id: Object.prototype.hasOwnProperty.call(patch, 'submissionId')
                ? String(patch.submissionId) : (row.submission_id || row.dedupe_key),
            kind: Object.prototype.hasOwnProperty.call(patch, 'kind') ? String(patch.kind) : (row.kind || 'follow-up'),
            target_turn_id: Object.prototype.hasOwnProperty.call(patch, 'targetTurnId')
                ? (patch.targetTurnId ? String(patch.targetTurnId) : null) : row.target_turn_id,
            prompt: Object.prototype.hasOwnProperty.call(patch, 'prompt') ? String(patch.prompt) : row.prompt,
            client_message_id: Object.prototype.hasOwnProperty.call(patch, 'clientMessageId')
                ? String(patch.clientMessageId) : row.client_message_id,
            codex_turn_id: Object.prototype.hasOwnProperty.call(patch, 'turnId') ? patch.turnId : row.codex_turn_id,
            attempt_count: Number.isInteger(patch.attemptCount) ? patch.attemptCount : row.attempt_count,
            last_error: Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError : row.last_error,
            updated_at: Date.now(),
        });
        return this.listPendingInputs(row.session_id).find((entry) => entry.inputId === String(inputId)) || null;
    }

    removePendingInput(inputId) {
        this.stmt.deletePendingInput.run(String(inputId));
    }

    retryPendingInput(inputId) {
        const row = this.db.prepare('SELECT * FROM agent_pending_inputs WHERE input_id = ?').get(String(inputId));
        if (!row) return null;
        return this.updatePendingInput(inputId, {
            state: 'queued',
            clientMessageId: `client_msg:${crypto.randomUUID()}`,
            turnId: null,
            attemptCount: 0,
            lastError: null,
        });
    }

    createOperation({ operationId, sessionId = null, kind, state = 'prepared', threadId = null, payload = {} }) {
        const now = Date.now();
        const idValue = operationId || `operation:${crypto.randomUUID()}`;
        this.stmt.insertOperation.run({
            operation_id: idValue,
            session_id: sessionId,
            kind: String(kind),
            state: String(state),
            codex_thread_id: threadId,
            payload_json: json(payload),
            last_error: null,
            created_at: now,
            updated_at: now,
        });
        return this.getOperation(idValue);
    }

    updateOperation(operationId, patch = {}) {
        const current = this.stmt.getOperation.get(String(operationId));
        if (!current) return null;
        this.stmt.updateOperation.run({
            operation_id: String(operationId),
            state: patch.state || current.state,
            codex_thread_id: Object.prototype.hasOwnProperty.call(patch, 'threadId') ? patch.threadId : current.codex_thread_id,
            payload_json: json(Object.prototype.hasOwnProperty.call(patch, 'payload') ? patch.payload : parseJson(current.payload_json, {})),
            last_error: Object.prototype.hasOwnProperty.call(patch, 'lastError') ? patch.lastError : current.last_error,
            updated_at: Date.now(),
        });
        return this.getOperation(operationId);
    }

    getOperation(operationId) {
        const row = this.stmt.getOperation.get(String(operationId));
        return row ? this._operation(row) : null;
    }

    listRecoverableOperations() {
        return this.stmt.listRecoverableOperations.all().map((row) => this._operation(row));
    }

    permanentlyDeleteSession(sessionId, threadId = null) {
        const now = Date.now();
        const receipt = {
            receiptId: `deletion:${crypto.randomUUID()}`,
            sessionHash: crypto.createHash('sha256').update(String(sessionId)).digest('hex'),
            threadHash: threadId ? crypto.createHash('sha256').update(String(threadId)).digest('hex') : null,
            deletedAt: now,
        };
        this.db.transaction(() => {
            this.stmt.deleteSession.run(String(sessionId));
            this.stmt.insertDeletionReceipt.run({
                receipt_id: receipt.receiptId,
                session_hash: receipt.sessionHash,
                codex_thread_hash: receipt.threadHash,
                deleted_at: now,
            });
        })();
        return receipt;
    }

    close() {
        this.db.close();
    }

    _session(row) {
        return mapSessionRow(row);
    }

    _block(row) {
        return mapBlockRow(row);
    }

    _operation(row) {
        return mapOperationRow(row);
    }
}

module.exports = { AgentProjectionRepository };
