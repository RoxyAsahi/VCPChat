'use strict';

const { StreamingAccumulatorRegistry } = require('../streamingAccumulator');
const { normalizeCodexFileChanges } = require('../diffModel');
const { projectVcpContent } = require('../vcpContentProjection');

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

function itemContent(item) {
    switch (item.type) {
        case 'userMessage': return { parts: item.content || [] };
        case 'agentMessage': return projectVcpContent(item.text || '');
        case 'reasoning': return { summary: item.summary || [], content: item.content || [] };
        case 'plan': return { text: item.text || '' };
        case 'contextCompaction': {
            const summary = typeof item.summary === 'string' ? item.summary
                : typeof item.message === 'string' ? item.message
                    : item.status === 'failed' ? '上下文压缩失败。'
                        : item.status === 'completed' ? '上下文压缩完成。'
                            : '正在整理上下文。';
            return { text: summary.slice(0, 2_000), phase: item.status || 'inProgress' };
        }
        case 'fileChange': return { changes: normalizeCodexFileChanges(item.changes), status: item.status || 'inProgress' };
        default: return { item };
    }
}

class CodexProjectionProjector {
    constructor(repository) {
        this.repository = repository;
        this.streaming = new StreamingAccumulatorRegistry();
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
        if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
            const ordinal = Number.isInteger(params.summaryIndex)
                ? params.summaryIndex
                : (Number.isInteger(params.contentIndex) ? params.contentIndex : 0);
            return this._append(params, ordinal, params.delta, 'reasoning');
        }
        if (method === 'turn/completed') {
            const session = this.repository.getSessionByThread(params.threadId);
            if (session) this.repository.markReconciled(session.sessionId);
            return Boolean(session);
        }
        return false;
    }

    reconcileThread(sessionId, thread, expectedGeneration = undefined) {
        const entries = [];
        for (const turn of thread?.turns || []) {
            for (const item of turn.items || []) {
                const entry = this._itemEntry({ threadId: thread.id, turnId: turn.id, item }, true, sessionId);
                if (entry) entries.push(entry);
            }
        }
        return this.repository.reconcileItems(sessionId, entries, expectedGeneration);
    }

    _projectItem(params, completed, knownSessionId) {
        const entry = this._itemEntry(params, completed, knownSessionId);
        if (!entry) return false;
        this.repository.upsertItem(entry.sessionId, entry.record, entry.blocks || entry.block);
        if (!completed && entry.itemText !== undefined) {
            this.streaming.seed(this._streamKey(params.threadId, params.item.id, 0, entry.block.kind), entry.itemText);
        }
        return true;
    }

    _itemEntry(params, completed, knownSessionId) {
        const item = params.item;
        const threadId = params.threadId || params.thread?.id;
        if (!item?.id || !threadId) return null;
        const session = knownSessionId
            ? this.repository.getSession(knownSessionId)
            : this.repository.getSessionByThread(threadId);
        if (!session) return null;
        const [role, kind] = ITEM_KIND[item.type] || ['system', 'observation'];
        const status = completed ? (item.status || 'completed') : (item.status || 'inProgress');
        return {
            sessionId: session.sessionId,
            record: {
                threadId,
                turnId: params.turnId || null,
                itemId: item.id,
                role,
                status,
            },
            block: {
                kind,
                status,
                ordinal: 0,
                content: itemContent(item),
            },
            blocks: (() => {
                const content = itemContent(item);
                const primary = { kind, status, ordinal: 0, content };
                if (item.type !== 'agentMessage' || !Array.isArray(content.observations) || !content.observations.length) return [primary];
                return [primary, ...content.observations.map((marker, ordinal) => ({
                    kind: 'observation', status, ordinal: ordinal + 1,
                    content: { marker: { ...marker, source: 'vcp-marker' } },
                }))];
            })(),
            itemText: item.type === 'agentMessage' ? String(itemContent(item).text || '') : undefined,
        };
    }

    _append(params, ordinal, delta, kind) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!session || !params.itemId) return false;
        try {
            const novel = this.streaming.append(this._streamKey(params.threadId, params.itemId, ordinal, kind), delta);
            if (novel) this.repository.appendBlockText(session.sessionId, params.itemId, ordinal, novel, kind);
            return true;
        } catch (_error) {
            return false;
        }
    }

    _streamKey(threadId, itemId, ordinal, kind) {
        return `${kind}:${threadId || ''}:${itemId || ''}:${ordinal}`;
    }
}

module.exports = { CodexProjectionProjector, ITEM_KIND };
