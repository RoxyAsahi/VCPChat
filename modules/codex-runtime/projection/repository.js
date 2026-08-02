'use strict';

const path = require('path');
const crypto = require('crypto');
const { migrate } = require('./migrations');

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

function hasProjectionValue(value) {
    if (value == null) return false;
    if (typeof value === 'string') return value.length > 0;
    if (Array.isArray(value)) return value.some(hasProjectionValue);
    if (typeof value === 'object') return Object.values(value).some(hasProjectionValue);
    return true;
}

function mergeProjectionContent(existing, incoming) {
    if (!hasProjectionValue(incoming)) return existing;
    if (Array.isArray(incoming)) return incoming;
    if (!incoming || typeof incoming !== 'object') return incoming;
    const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
    const merged = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
        if (!hasProjectionValue(value)) continue;
        merged[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? mergeProjectionContent(base[key], value)
            : value;
    }
    return merged;
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
                    config_snapshot_json, config_revision, orphaned, pinned_at, created_at, updated_at, archived_at
                ) VALUES (
                    @session_id, @codex_thread_id, @agent_id, @agent_catalog_id, @agent_name_snapshot,
                    @title, @workspace_root, @state,
                    @config_snapshot_json, @config_revision, @orphaned, @pinned_at, @created_at, @updated_at, @archived_at
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
                    workspace_root = @workspace_root,
                    agent_name_snapshot = @agent_name_snapshot,
                    updated_at = @now
                WHERE session_id = @session_id AND config_revision = @expected_revision
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
            listMessageItems: this.db.prepare('SELECT codex_item_id FROM agent_messages WHERE session_id = ?'),
            deleteMessage: this.db.prepare(`
                DELETE FROM agent_messages WHERE session_id = ? AND codex_item_id = ?
            `),
            upsertBlock: this.db.prepare(`
                INSERT INTO agent_blocks (
                    block_id, message_id, kind, status, ordinal, content_json, authority, created_at, updated_at
                ) VALUES (
                    @block_id, @message_id, @kind, @status, @ordinal, @content_json, @authority, @created_at, @updated_at
                ) ON CONFLICT(message_id, ordinal) DO UPDATE SET
                    kind = excluded.kind, status = excluded.status,
                    content_json = excluded.content_json, authority = excluded.authority,
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
                    input_id, session_id, dedupe_key, prompt, state, client_message_id,
                    attempt_count, created_at, updated_at
                ) VALUES (
                    @input_id, @session_id, @dedupe_key, @prompt, 'queued', @client_message_id,
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
        this.upsertItemTransaction = this.db.transaction((sessionId, record, block) => {
            this._upsertItem(sessionId, record, block);
            this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
        });
        this.reconcileItemsTransaction = this.db.transaction((sessionId, entries, expectedGeneration) => {
            const state = this.stmt.getState.get(sessionId);
            if (Number.isInteger(expectedGeneration) && state?.mutation_generation !== expectedGeneration) {
                return false;
            }
            const incomingItemIds = new Set(entries.map((entry) => String(entry.record.itemId)));
            for (const row of this.stmt.listMessageItems.all(sessionId)) {
                if (!incomingItemIds.has(String(row.codex_item_id))) {
                    this.stmt.deleteMessage.run(sessionId, row.codex_item_id);
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
            this.stmt.setReconciled.run({ session_id: sessionId, now: Date.now() });
            this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
            return true;
        });
    }

    saveSession(session) {
        const now = Date.now();
        const sessionId = String(session.sessionId || `codex_session_${crypto.randomUUID()}`);
        this.stmt.upsertSession.run({
            session_id: sessionId,
            codex_thread_id: session.threadId || null,
            agent_id: String(session.agentId || 'codex'),
            agent_catalog_id: session.agentCatalogId || null,
            agent_name_snapshot: session.agentNameSnapshot || null,
            title: session.title || null,
            workspace_root: session.workspaceRoot || null,
            state: session.state || 'ready',
            config_snapshot_json: json(session.configSnapshot || {}),
            config_revision: Number.isInteger(session.configRevision) ? session.configRevision : 1,
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
            config_snapshot_json: json(configSnapshot || {}),
            workspace_root: workspaceRoot || current.workspaceRoot || null,
            agent_name_snapshot: agentNameSnapshot || current.agentNameSnapshot || null,
            now: Date.now(),
        });
        if (result.changes !== 1) return { updated: false, reason: 'conflict', session: this.getSession(sessionId) };
        return { updated: true, session: this.getSession(sessionId) };
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
        return {
            session,
            messages,
            storage: { readOnly: this.readOnly, degradedReason: this.degradedReason },
            projection: state ? {
                lastReconciledAt: state.last_reconciled_at,
                lastError: state.last_error,
                activity: parseJson(state.activity_json, {}),
            } : null,
        };
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

    upsertItem(sessionId, record, block) {
        if (Array.isArray(block)) {
            this.db.transaction(() => {
                for (const entry of block.filter(Boolean)) this._upsertItem(sessionId, record, entry);
                this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
            })();
        } else {
            this.upsertItemTransaction(sessionId, record, block);
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

    reconcileItems(sessionId, entries, expectedGeneration = undefined) {
        const applied = this.reconcileItemsTransaction(sessionId, entries, expectedGeneration);
        return { applied, projection: this.readProjection(sessionId) };
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
        if (block) {
            const ordinal = Number.isInteger(block.ordinal) ? block.ordinal : 0;
            const existingBlock = this.stmt.getBlock.get(existing.message_id, ordinal);
            const existingContent = parseJson(existingBlock?.content_json, {});
            let content;
            if (options.authoritative && block.replaceContent === true) {
                content = block.content || {};
            } else if (options.authoritative && Array.isArray(block.replaceFields)) {
                content = { ...existingContent };
                for (const field of block.replaceFields) {
                    if (Object.prototype.hasOwnProperty.call(block.content || {}, field)) content[field] = block.content[field];
                }
                for (const [field, value] of Object.entries(block.content || {})) {
                    if (!block.replaceFields.includes(field)) content[field] = mergeProjectionContent(content[field], value);
                }
            } else {
                content = mergeProjectionContent(existingContent, block.content || {});
            }
            this.stmt.upsertBlock.run({
                block_id: block.blockId || existingBlock?.block_id || `block:${sessionId}:${record.itemId}:${ordinal}`,
                message_id: existing.message_id,
                kind: block.kind || existingBlock?.kind,
                status: block.status || record.status || 'inProgress',
                ordinal,
                content_json: json(content),
                authority: block.authority || existingBlock?.authority || 'codex',
                created_at: existingBlock?.created_at || block.createdAt || now,
                updated_at: now,
            });
        }
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
            authority: block.authority || 'codex',
            created_at: block.created_at,
            updated_at: Date.now(),
        });
        this.stmt.advanceGeneration.run({ session_id: sessionId, now: Date.now() });
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

    enqueuePendingInput(sessionId, { dedupeKey, prompt }) {
        const inputId = `pending:${crypto.randomUUID()}`;
        const clientMessageId = `client_msg:${crypto.randomUUID()}`;
        const now = Date.now();
        this.stmt.insertPendingInput.run({
            input_id: inputId,
            session_id: sessionId,
            dedupe_key: String(dedupeKey),
            prompt: String(prompt),
            client_message_id: clientMessageId,
            created_at: now,
        });
        return this.stmt.getPendingInputByKey.get(sessionId, String(dedupeKey));
    }

    listPendingInputs(sessionId) {
        return this.stmt.listPendingInputs.all(sessionId).map((row) => ({
            inputId: row.input_id,
            sessionId: row.session_id,
            dedupeKey: row.dedupe_key,
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
            dedupe_key: Object.prototype.hasOwnProperty.call(patch, 'dedupeKey') ? String(patch.dedupeKey) : row.dedupe_key,
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
        return {
            sessionId: row.session_id,
            threadId: row.codex_thread_id,
            agentId: row.agent_id,
            agentCatalogId: row.agent_catalog_id || null,
            agentNameSnapshot: row.agent_name_snapshot || null,
            title: row.title,
            workspaceRoot: row.workspace_root,
            state: row.state,
            pinnedAt: row.pinned_at || null,
            configSnapshot: parseJson(row.config_snapshot_json, {}),
            configRevision: Number(row.config_revision || 1),
            orphaned: row.orphaned === 1,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            archivedAt: row.archived_at,
        };
    }

    _block(row) {
        return {
            blockId: row.block_id,
            kind: row.kind,
            status: row.status,
            ordinal: row.ordinal,
            content: parseJson(row.content_json, {}),
            authority: row.authority || 'codex',
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    _operation(row) {
        return {
            operationId: row.operation_id,
            sessionId: row.session_id || null,
            kind: row.kind,
            state: row.state,
            threadId: row.codex_thread_id || null,
            payload: parseJson(row.payload_json, {}),
            lastError: row.last_error || null,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
}

module.exports = { AgentProjectionRepository };
