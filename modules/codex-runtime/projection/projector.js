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
                const entry = this._itemEntry(
                    { threadId: thread.id, turnId: turn.id, item },
                    true,
                    sessionId,
                    { authoritative: true },
                );
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
