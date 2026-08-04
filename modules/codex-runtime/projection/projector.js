'use strict';

const { StreamingAccumulatorRegistry } = require('../streamingAccumulator');
const { normalizeCodexFileChanges } = require('../diffModel');
const { projectVcpContent } = require('../vcpContentProjection');
const { sanitizeUnknownItem } = require('./v2');

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

function boundedJson(value, depth = 0) {
    if (depth > 6) return '[truncated]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 16_384);
    if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundedJson(entry, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 1_024);
    return Object.fromEntries(Object.entries(value).slice(0, 100)
        .map(([key, entry]) => [String(key).slice(0, 256), boundedJson(entry, depth + 1)]));
}

function normalizedToolItem(item, fields) {
    return { type: item.type, id: item.id, ...Object.fromEntries(fields
        .filter((field) => Object.prototype.hasOwnProperty.call(item, field))
        .map((field) => [field, boundedJson(item[field])])) };
}

function normalizedDynamicToolItem(item) {
    const wrapped = item.tool === 'vcp_invoke' && item.arguments && typeof item.arguments === 'object';
    return {
        ...normalizedToolItem(item, ['namespace', 'status', 'contentItems', 'success', 'durationMs']),
        tool: wrapped ? String(item.arguments.tool || 'vcp_invoke').slice(0, 256) : String(item.tool || 'vcp_invoke').slice(0, 256),
        wrapperTool: String(item.tool || 'vcp_invoke').slice(0, 256),
        arguments: boundedJson(wrapped ? item.arguments.arguments : item.arguments),
    };
}

function itemContent(item) {
    switch (item.type) {
        case 'userMessage': return { parts: item.content || [] };
        case 'agentMessage': return projectVcpContent(item.text || '');
        case 'reasoning': return {
            summary: Array.isArray(item.summary) ? item.summary : [],
            content: Array.isArray(item.content) ? item.content : [],
        };
        case 'plan': return { text: item.text || '' };
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
            return { text: summary, phase: hasStatus ? item.status : 'inProgress' };
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
        case 'imageView': return { item: normalizedToolItem(item, ['path']) };
        default: return { unknown: sanitizeUnknownItem(item) };
    }
}

class CodexProjectionProjector {
    constructor(repository) {
        this.repository = repository;
        this.streaming = new StreamingAccumulatorRegistry();
        this.pendingDeltas = new Map();
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
        const hasPartialItems = turns.some((turn) => turn && turn.itemsView && turn.itemsView !== 'full');
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
        return {
            ...this.repository.reconcileItems(sessionId, entries, expectedGeneration, {
                deleteMissing: !hasPartialItems,
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

    _ensureReasoningPart(params, field, index) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!params.itemId || !Number.isInteger(index) || index < 0) return false;
        if (!session) return false;
        return this.repository.ensureReasoningPart(session.sessionId, params.itemId, field, index);
    }

    _appendReasoning(params, field, index, delta) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!params.itemId || !Number.isInteger(index) || index < 0) return false;
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
        const key = this._deltaKey(params.threadId, params.itemId);
        const list = this.pendingDeltas.get(key) || [];
        if (list.length >= 32 || list.reduce((sum, entry) => sum + String(entry.delta || '').length, 0) > 64_000) return false;
        list.push({ ...delta, receivedAt: Date.now() });
        this.pendingDeltas.set(key, list);
        return true;
    }

    _replayBuffered(threadId, itemId, sessionId) {
        const key = this._deltaKey(threadId, itemId);
        const list = this.pendingDeltas.get(key);
        if (!list?.length) return;
        this.pendingDeltas.delete(key);
        for (const entry of list) {
            if (entry.kind === 'reasoning') {
                if (entry.delta) this.appendReasoningTextSafely(sessionId, itemId, entry.field, entry.index, entry.delta);
                else this.repository.ensureReasoningPart(sessionId, itemId, entry.field, entry.index);
            } else if (entry.delta) {
                this.repository.appendBlockText(sessionId, itemId, entry.index, entry.delta, entry.kind);
            }
        }
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
