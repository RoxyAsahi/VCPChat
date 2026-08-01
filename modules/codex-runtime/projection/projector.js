'use strict';

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
        case 'agentMessage': return { text: item.text || '' };
        case 'reasoning': return { summary: item.summary || [], content: item.content || [] };
        case 'plan': return { text: item.text || '' };
        default: return { item };
    }
}

class CodexProjectionProjector {
    constructor(repository) {
        this.repository = repository;
    }

    projectNotification(message) {
        const method = message?.method;
        const params = message?.params || {};
        if (!method) return false;
        if (method === 'item/started' || method === 'item/completed') {
            return this._projectItem(params, method === 'item/completed');
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
        this.repository.upsertItem(entry.sessionId, entry.record, entry.block);
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
        };
    }

    _append(params, ordinal, delta, kind) {
        const session = this.repository.getSessionByThread(params.threadId);
        if (!session || !params.itemId) return false;
        try {
            this.repository.appendBlockText(session.sessionId, params.itemId, ordinal, delta, kind);
            return true;
        } catch (_error) {
            return false;
        }
    }
}

module.exports = { CodexProjectionProjector, ITEM_KIND };
