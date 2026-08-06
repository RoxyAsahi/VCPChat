'use strict';

const { StreamingAccumulatorRegistry } = require('../streamingAccumulator');
const { normalizeCodexFileChanges } = require('../diffModel');
const { projectVcpContent } = require('../vcpContentProjection');
const { sanitizeUnknownItem } = require('./v2');
const {
    LIMITS,
    boundedJson,
    boundedText,
    displayPath,
    normalizeReasoningContent,
    normalizeUserInputParts,
} = require('./content-policy');

const ITEM_KIND = Object.freeze({
    userMessage: ['user', 'message'],
    agentMessage: ['assistant', 'message'],
    reasoning: ['assistant', 'reasoning'],
    plan: ['assistant', 'observation'],
    commandExecution: ['assistant', 'tool'],
    fileChange: ['assistant', 'tool'],
    mcpToolCall: ['assistant', 'tool'],
    collabToolCall: ['assistant', 'tool'],
    dynamicToolCall: ['assistant', 'tool'],
    webSearch: ['assistant', 'tool'],
    imageView: ['assistant', 'attachment'],
    contextCompaction: ['system', 'observation'],
});

const DEFAULT_PENDING_DELTA_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING_DELTA_ITEMS = 128;
const DEFAULT_MAX_PENDING_DELTAS_PER_ITEM = 32;
const DEFAULT_MAX_PENDING_DELTA_BYTES_PER_ITEM = 64 * 1024;
const DEFAULT_MAX_PENDING_DELTA_BYTES = 1024 * 1024;
const DEFAULT_MAX_UNKNOWN_ITEM_DIAGNOSTICS = 256;

function replacementSlotKey(turnId, role) {
    return `${String(turnId || '')}:${role === 'user' ? 'user' : 'assistant'}`;
}

function incrementSlot(counts, key) {
    counts.set(key, (counts.get(key) || 0) + 1);
}

function hasIdentityReplacementCoverage(projection, entries) {
    const existing = new Map();
    for (const message of projection?.messages || []) {
        const codexBlocks = (message.blocks || []).filter((block) => (
            block.authority === 'codex' && block.kind !== 'reasoning'
        ));
        if (codexBlocks.length) incrementSlot(existing, replacementSlotKey(message.turnId, message.role));
    }
    const incoming = new Map();
    for (const entry of entries) {
        const blocks = (Array.isArray(entry.blocks) ? entry.blocks : [entry.block]).filter(Boolean);
        if (blocks.some((block) => block.authority === 'codex' && block.kind !== 'reasoning')) {
            incrementSlot(incoming, replacementSlotKey(entry.record.turnId, entry.record.role));
        }
    }
    if (!existing.size || existing.size !== incoming.size) return false;
    return [...existing].every(([key, count]) => incoming.get(key) === count);
}

function normalizedToolItem(item, fields) {
    return { type: boundedText(item.type, 128), id: boundedText(item.id, 256), ...Object.fromEntries(fields
        .filter((field) => Object.prototype.hasOwnProperty.call(item, field))
        .map((field) => [field, boundedJson(item[field])])) };
}

function normalizedDynamicToolItem(item) {
    const wrapped = item.tool === 'vcp_invoke' && item.arguments && typeof item.arguments === 'object';
    return {
        ...normalizedToolItem(item, ['namespace', 'status', 'contentItems', 'success', 'durationMs']),
        tool: boundedText(wrapped ? item.arguments.tool || 'vcp_invoke' : item.tool || 'vcp_invoke', 256),
        wrapperTool: boundedText(item.tool || 'vcp_invoke', 256),
        arguments: boundedJson(wrapped ? item.arguments.arguments : item.arguments),
    };
}

function displayFileName(value) {
    return displayPath(value) || 'Codex image';
}

function itemContent(item) {
    switch (item.type) {
        case 'userMessage': return { parts: normalizeUserInputParts(item.content) };
        case 'agentMessage': return projectVcpContent(item.text || '');
        case 'reasoning': return normalizeReasoningContent(item);
        case 'plan': return { text: boundedText(item.text, 64 * 1024) };
        case 'contextCompaction': {
            const hasSummary = Object.prototype.hasOwnProperty.call(item, 'summary');
            const hasMessage = Object.prototype.hasOwnProperty.call(item, 'message');
            const hasStatus = Object.prototype.hasOwnProperty.call(item, 'status');
            let summary;
            if (hasSummary) summary = item.summary == null ? item.summary : String(item.summary).slice(0, 2_000);
            else if (hasMessage) summary = item.message == null ? item.message : String(item.message).slice(0, 2_000);
            else summary = item.status === 'failed' ? '上下文压缩失败。'
                : item.status === 'completed' ? '上下文压缩完成。'
                    : '正在整理上下文。';
            return { text: summary, ...(hasStatus ? { phase: item.status } : {}) };
        }
        case 'fileChange': return { changes: normalizeCodexFileChanges(item.changes), status: item.status || 'inProgress' };
        case 'commandExecution': return { item: normalizedToolItem(item, [
            'pluginId', 'scriptPath', 'command', 'cwd', 'processId', 'source', 'status',
            'commandActions', 'aggregatedOutput', 'exitCode', 'durationMs',
        ]) };
        case 'mcpToolCall': return { item: normalizedToolItem(item, [
            'server', 'tool', 'status', 'arguments', 'appContext', 'pluginId', 'readOnlyHint',
            'result', 'error', 'durationMs',
        ]) };
        case 'dynamicToolCall': return { item: normalizedDynamicToolItem(item) };
        case 'collabAgentToolCall': return { item: normalizedToolItem(item, [
            'tool', 'status', 'senderThreadId', 'receiverThreadIds', 'prompt', 'model',
            'reasoningEffort', 'agentsStates',
        ]) };
        case 'webSearch': return { item: normalizedToolItem(item, ['action', 'query', 'status']) };
        case 'imageView': return { item: {
            type: item.type,
            id: item.id,
            name: displayFileName(item.path),
        } };
        default: return { unknown: sanitizeUnknownItem(item) };
    }
}

class CodexProjectionProjector {
    constructor(repository, options = {}) {
        this.repository = repository;
        this.streaming = new StreamingAccumulatorRegistry();
        this.pendingDeltas = new Map();
        this.pendingDeltaBytes = 0;
        this.pendingDeltaTimer = null;
        this.pendingDeltaTtlMs = Math.max(1, Number(options.pendingDeltaTtlMs)
            || DEFAULT_PENDING_DELTA_TTL_MS);
        this.maxPendingDeltaItems = Math.max(1, Number(options.maxPendingDeltaItems)
            || DEFAULT_MAX_PENDING_DELTA_ITEMS);
        this.maxPendingDeltasPerItem = Math.max(1, Number(options.maxPendingDeltasPerItem)
            || DEFAULT_MAX_PENDING_DELTAS_PER_ITEM);
        this.maxPendingDeltaBytesPerItem = Math.max(1, Number(options.maxPendingDeltaBytesPerItem)
            || DEFAULT_MAX_PENDING_DELTA_BYTES_PER_ITEM);
        this.maxPendingDeltaBytes = Math.max(this.maxPendingDeltaBytesPerItem,
            Number(options.maxPendingDeltaBytes) || DEFAULT_MAX_PENDING_DELTA_BYTES);
        this.clock = options.clock || Date.now;
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;
        this.scheduleReconcile = typeof options.scheduleReconcile === 'function'
            ? options.scheduleReconcile : null;
        this.onProtocolDiagnostic = typeof options.onProtocolDiagnostic === 'function'
            ? options.onProtocolDiagnostic : null;
        this.maxUnknownItemDiagnostics = Math.max(1, Number(options.maxUnknownItemDiagnostics)
            || DEFAULT_MAX_UNKNOWN_ITEM_DIAGNOSTICS);
        this.unknownItemDiagnostics = new Map();
        this.reconcileScheduledSessions = new Set();
    }

    dispose() {
        if (this.pendingDeltaTimer) this.clearTimer(this.pendingDeltaTimer);
        this.pendingDeltaTimer = null;
        for (const bucket of this.pendingDeltas.values()) {
            this.streaming.clearItem(bucket.threadId, bucket.itemId);
        }
        this.pendingDeltas.clear();
        this.pendingDeltaBytes = 0;
        this.unknownItemDiagnostics.clear();
        this.reconcileScheduledSessions.clear();
    }

    projectNotification(message) {
        const method = message?.method;
        const params = message?.params || {};
        if (!method) return false;
        if (method === 'item/started' || method === 'item/completed') {
            const completed = method === 'item/completed';
            const result = this._projectItem(params, completed);
            if (completed) this.streaming.clearItem(params.threadId, params.item?.id);
            return result;
        }
        if (method === 'item/agentMessage/delta') {
            return this._append(params, 0, params.delta, 'message');
        }
        if (method === 'item/plan/delta') {
            return this._append(params, 0, params.delta, 'observation');
        }
        if (method === 'item/commandExecution/outputDelta') {
            return this._append(params, 0, params.delta, 'tool');
        }
        if (method === 'item/reasoning/summaryPartAdded') {
            return this._ensureReasoningPart(params, 'summary', params.summaryIndex);
        }
        if (method === 'item/reasoning/summaryTextDelta') {
            return this._appendReasoning(params, 'summary', params.summaryIndex, params.delta);
        }
        if (method === 'item/reasoning/textDelta') {
            return this._appendReasoning(params, 'content', params.contentIndex, params.delta);
        }
        if (method === 'turn/completed') {
            const session = this.repository.getSessionByThread(params.threadId);
            if (session) this.repository.markReconciled(session.sessionId);
            return Boolean(session);
        }
        return false;
    }

    reconcileThread(sessionId, thread, expectedGeneration = undefined) {
        const session = this.repository.getSession(sessionId);
        if (!session || !thread || String(thread.id || '').trim() !== String(session.threadId || '').trim()) {
            return { applied: false, reason: 'thread-identity-mismatch' };
        }
        const turns = Array.isArray(thread.turns) ? thread.turns : [];
        const hasPartialItems = !turns.every((turn) => turn?.itemsView === 'full');
        // `thread/read(includeTurns=true)` returns stored turns, but the App
        // Server contract does not grant absence-based deletion authority.
        // In 0.146 it can omit live-observed reasoning, tool and intermediate
        // agent-message Items even when an incidental `itemsView=full` field is
        // present. Returned Items remain authoritative for their own supplied
        // fields; missing Items remain durable until an explicit tombstone
        // protocol exists.
        const entries = [];
        for (const turn of turns) {
            for (const item of turn.items || []) {
                const entry = this._itemEntry(
                    { threadId: thread.id, turnId: turn.id, item },
                    true,
                    sessionId,
                    { authoritative: true },
                );
                if (entry) entries.push({ ...entry, authoritativeOrdinals: !hasPartialItems });
            }
        }
        const projection = this.repository.readProjection(sessionId);
        const identityReplacement = !hasPartialItems && hasIdentityReplacementCoverage(projection, entries);
        return {
            ...this.repository.reconcileItems(sessionId, entries, expectedGeneration, {
                // This is identity de-duplication, not generic absence-based
                // deletion. Any incomplete slot coverage remains merge-only.
                deleteMissing: identityReplacement,
            }),
            partial: hasPartialItems,
        };
    }

    _projectItem(params, completed, knownSessionId) {
        const entry = this._itemEntry(params, completed, knownSessionId, { authoritative: completed });
        if (!entry) return false;
        this.repository.upsertItem(
            entry.sessionId, entry.record, entry.blocks || entry.block, { authoritative: completed },
        );
        this._replayBuffered(params.threadId, params.item.id, entry.sessionId);
        if (!completed && entry.itemText !== undefined) {
            this.streaming.seed(this._streamKey(params.threadId, params.item.id, 0, entry.block.kind), entry.itemText);
        }
        return true;
    }

    _itemEntry(params, completed, knownSessionId, options = {}) {
        const item = params.item;
        const threadId = params.threadId || params.thread?.id;
        if (!item?.id || !threadId) return null;
        const session = knownSessionId
            ? this.repository.getSession(knownSessionId)
            : this.repository.getSessionByThread(threadId);
        if (!session) return null;
        if (!ITEM_KIND[item.type]) this._diagnoseUnknownItem(session, params, item);
        const [role, kind] = ITEM_KIND[item.type] || ['system', 'observation'];
        const status = completed ? (item.status || 'completed') : (item.status || 'inProgress');
        const explicitFields = authoritativeContentFields(item);
        // Codex emits the dynamic-tool lifecycle, but the actual invocation and
        // result are owned by the VCPToolBox bridge. App Server 0.146 may omit
        // client-executed dynamicToolCall Items from a later thread/read, so
        // keep their display Blocks outside Codex snapshot deletion.
        const blockAuthority = item.type === 'dynamicToolCall' ? 'toolbox' : 'codex';
        const decorateBlock = (block) => ({
            ...block,
            authority: blockAuthority,
            ...(options.authoritative && explicitFields.replaceContent ? { replaceContent: true } : {}),
            ...(options.authoritative && explicitFields.replaceFields.length ? { replaceFields: explicitFields.replaceFields } : {}),
        });
        return {
            sessionId: session.sessionId,
            record: {
                threadId,
                turnId: params.turnId || null,
                itemId: item.id,
                role,
                status,
            },
            block: decorateBlock({
                kind,
                status,
                ordinal: 0,
                content: itemContent(item),
            }),
            blocks: (() => {
                const content = itemContent(item);
                const primary = decorateBlock({ kind, status, ordinal: 0, content });
                if (item.type !== 'agentMessage' || !Array.isArray(content.observations) || !content.observations.length) return [primary];
                return [primary, ...content.observations.map((marker, ordinal) => decorateBlock({
                    kind: 'observation', status, ordinal: ordinal + 1,
                    content: { marker: { ...marker, source: 'vcp-marker' } },
                }))];
            })(),
            itemText: item.type === 'agentMessage' ? String(itemContent(item).text || '') : undefined,
        };
    }

    _append(params, ordinal, delta, kind) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!params.itemId) return false;
        if (!session) return false;
        try {
            const novel = this.streaming.append(this._streamKey(params.threadId, params.itemId, ordinal, kind), delta);
            if (!novel) return true;
            if (!this.repository.getProjectedMessageByItem(session.sessionId, params.itemId)) {
                this._bufferDelta(params, { field: 'text', index: ordinal, delta: novel, kind });
                return true;
            }
            this.repository.appendBlockText(session.sessionId, params.itemId, ordinal, novel, kind);
            return true;
        } catch (_error) {
            return false;
        }
    }

    _diagnoseUnknownItem(session, params, item) {
        if (!this.onProtocolDiagnostic) return;
        const key = `${String(params.threadId || '')}:${String(item.id || '')}:${String(item.type || '')}`;
        if (this.unknownItemDiagnostics.has(key)) return;
        this.unknownItemDiagnostics.set(key, true);
        while (this.unknownItemDiagnostics.size > this.maxUnknownItemDiagnostics) {
            this.unknownItemDiagnostics.delete(this.unknownItemDiagnostics.keys().next().value);
        }
        this.onProtocolDiagnostic({
            sessionId: session.sessionId,
            threadId: String(params.threadId || ''),
            turnId: params.turnId || null,
            itemId: String(item.id || '').slice(0, 256),
            itemType: String(item.type || 'unknown').slice(0, 128),
            fields: Object.keys(item).slice(0, 32).map((field) => String(field).slice(0, 128)).sort(),
        });
    }

    _ensureReasoningPart(params, field, index) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!params.itemId || !Number.isInteger(index) || index < 0 || index >= LIMITS.reasoningParts) return false;
        if (!session) return false;
        const applied = this.repository.ensureReasoningPart(session.sessionId, params.itemId, field, index);
        return applied || this._bufferDelta(params, { field, index, delta: '', kind: 'reasoning' });
    }

    _appendReasoning(params, field, index, delta) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!params.itemId || !Number.isInteger(index) || index < 0 || index >= LIMITS.reasoningParts) return false;
        if (!session) return false;
        try {
            const novel = this.streaming.append(
                this._streamKey(params.threadId, params.itemId, `${field}:${index}`, 'reasoning'), delta,
            );
            if (!novel) return true;
            const applied = this.repository.appendReasoningText(session.sessionId, params.itemId, field, index, novel);
            if (!applied) this._bufferDelta(params, { field, index, delta: novel, kind: 'reasoning' });
            return true;
        } catch (_error) {
            return false;
        }
    }

    _bufferDelta(params, delta) {
        this.prunePendingDeltas();
        const key = this._deltaKey(params.threadId, params.itemId);
        const session = this.repository.getSessionByThread(params.threadId);
        const receivedAt = this.clock();
        const deltaBytes = Buffer.byteLength(String(delta.delta || ''), 'utf8');
        let bucket = this.pendingDeltas.get(key);
        if (!bucket) {
            while (this.pendingDeltas.size >= this.maxPendingDeltaItems) {
                this._discardOldestPendingDelta('pending delta item limit exceeded');
            }
            bucket = {
                key,
                threadId: String(params.threadId || ''),
                itemId: String(params.itemId || ''),
                sessionId: session?.sessionId || null,
                entries: [],
                bytes: 0,
                createdAt: receivedAt,
                expiresAt: receivedAt + this.pendingDeltaTtlMs,
            };
            this.pendingDeltas.set(key, bucket);
        }
        if (bucket.entries.length >= this.maxPendingDeltasPerItem
            || bucket.bytes + deltaBytes > this.maxPendingDeltaBytesPerItem) {
            this._discardPendingDelta(key, 'pending delta per-item limit exceeded');
            return false;
        }
        while (this.pendingDeltaBytes + deltaBytes > this.maxPendingDeltaBytes
            && this.pendingDeltas.size > 0) {
            const evicted = this._discardOldestPendingDelta('pending delta global byte limit exceeded', key);
            if (!evicted) break;
        }
        if (!this.pendingDeltas.has(key) || this.pendingDeltaBytes + deltaBytes > this.maxPendingDeltaBytes) {
            this._discardPendingDelta(key, 'pending delta global byte limit exceeded');
            return false;
        }
        bucket.entries.push({ ...delta, receivedAt });
        bucket.bytes += deltaBytes;
        this.pendingDeltaBytes += deltaBytes;
        this._schedulePendingDeltaExpiry();
        return true;
    }

    _replayBuffered(threadId, itemId, sessionId) {
        const key = this._deltaKey(threadId, itemId);
        const bucket = this.pendingDeltas.get(key);
        if (!bucket?.entries?.length) return;
        this.pendingDeltas.delete(key);
        this.pendingDeltaBytes = Math.max(0, this.pendingDeltaBytes - bucket.bytes);
        this._schedulePendingDeltaExpiry();
        for (const entry of bucket.entries) {
            if (entry.kind === 'reasoning') {
                if (entry.delta) this.appendReasoningTextSafely(sessionId, itemId, entry.field, entry.index, entry.delta);
                else this.repository.ensureReasoningPart(sessionId, itemId, entry.field, entry.index);
            } else if (entry.delta) {
                this.repository.appendBlockText(sessionId, itemId, entry.index, entry.delta, entry.kind);
            }
        }
    }

    prunePendingDeltas(now = this.clock()) {
        const expired = [...this.pendingDeltas.values()]
            .filter((bucket) => bucket.expiresAt <= now)
            .map((bucket) => bucket.key);
        for (const key of expired) this._discardPendingDelta(key, 'pending delta expired before item/started');
        this._schedulePendingDeltaExpiry();
        return expired.length;
    }

    _discardOldestPendingDelta(reason, excludedKey = null) {
        const bucket = [...this.pendingDeltas.values()]
            .filter((candidate) => candidate.key !== excludedKey)
            .sort((left, right) => left.createdAt - right.createdAt)[0];
        if (!bucket) return false;
        this._discardPendingDelta(bucket.key, reason);
        return true;
    }

    _discardPendingDelta(key, reason) {
        const bucket = this.pendingDeltas.get(key);
        if (!bucket) return false;
        this.pendingDeltas.delete(key);
        this.pendingDeltaBytes = Math.max(0, this.pendingDeltaBytes - bucket.bytes);
        this.streaming.clearItem(bucket.threadId, bucket.itemId);
        const message = `${reason}: ${bucket.itemId}`;
        if (bucket.sessionId) {
            try { this.repository.markProjectionError(bucket.sessionId, message); } catch (_error) { /* read-only */ }
            this._scheduleReconcile(bucket.sessionId, bucket.threadId, bucket.itemId, reason);
        }
        return true;
    }

    _schedulePendingDeltaExpiry() {
        if (this.pendingDeltaTimer) this.clearTimer(this.pendingDeltaTimer);
        this.pendingDeltaTimer = null;
        if (this.pendingDeltas.size === 0) return;
        const expiresAt = Math.min(...[...this.pendingDeltas.values()].map((bucket) => bucket.expiresAt));
        const timer = this.setTimer(() => {
            if (this.pendingDeltaTimer === timer) this.pendingDeltaTimer = null;
            this.prunePendingDeltas();
        }, Math.max(1, expiresAt - this.clock()));
        timer?.unref?.();
        this.pendingDeltaTimer = timer;
    }

    _scheduleReconcile(sessionId, threadId, itemId, reason) {
        if (!this.scheduleReconcile || this.reconcileScheduledSessions.has(sessionId)) return;
        this.reconcileScheduledSessions.add(sessionId);
        Promise.resolve().then(() => this.scheduleReconcile({ sessionId, threadId, itemId, reason }))
            .catch((error) => {
                try { this.repository.markProjectionError(sessionId, error?.message || String(error)); } catch (_ignored) { /* read-only */ }
            })
            .finally(() => this.reconcileScheduledSessions.delete(sessionId));
    }

    appendReasoningTextSafely(sessionId, itemId, field, index, delta) {
        return this.repository.appendReasoningText(sessionId, itemId, field, index, delta);
    }

    _deltaKey(threadId, itemId) { return `${String(threadId || '')}:${String(itemId || '')}`; }

    _streamKey(threadId, itemId, ordinal, kind) {
        return `${kind}:${threadId || ''}:${itemId || ''}:${ordinal}`;
    }
}

function authoritativeContentFields(item = {}) {
    const has = (field) => Object.prototype.hasOwnProperty.call(item, field);
    switch (item.type) {
        case 'userMessage': return { replaceContent: has('content'), replaceFields: [] };
        case 'agentMessage': return { replaceContent: has('text'), replaceFields: [] };
        case 'reasoning': return { replaceContent: false, replaceFields: ['summary', 'content'].filter(has) };
        case 'plan': return { replaceContent: false, replaceFields: has('text') ? ['text'] : [] };
        case 'fileChange': return { replaceContent: false, replaceFields: ['changes', 'status'].filter(has) };
        case 'contextCompaction': return {
            replaceContent: false,
            replaceFields: [
                ...(has('summary') || has('message') ? ['text'] : []),
                ...(has('status') ? ['phase'] : []),
            ],
        };
        default: return { replaceContent: true, replaceFields: [] };
    }
}

module.exports = { CodexProjectionProjector, ITEM_KIND };
