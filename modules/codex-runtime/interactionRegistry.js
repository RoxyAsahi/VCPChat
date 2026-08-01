'use strict';

// Clean-room state model informed by Harnss permission-queue (MIT, dc1dfd8).
// It deliberately namespaces source/request IDs: a ToolBox requestId must
// never be accepted as a Codex JSON-RPC requestId (or vice versa).
function interactionKey(source, requestId) {
    const normalizedSource = String(source || '').trim();
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedSource || !normalizedRequestId) throw new TypeError('Interaction requires source and requestId');
    return `${normalizedSource}:${normalizedRequestId}`;
}

class InteractionRegistry {
    constructor() {
        this.records = new Map();
    }

    enqueue(input) {
        const key = interactionKey(input?.source, input?.requestId);
        if (this.records.has(key)) return { accepted: false, record: this.records.get(key) };
        const record = Object.freeze({
            key,
            source: String(input.source),
            requestId: String(input.requestId),
            sessionId: input.sessionId || null,
            threadId: input.threadId || null,
            turnId: input.turnId || null,
            kind: input.kind || 'approval',
            method: input.method || null,
            payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
            createdAt: Number(input.createdAt) || Date.now(),
            expiresAtMs: Number(input.expiresAtMs) || null,
            state: 'pending',
        });
        this.records.set(key, record);
        return { accepted: true, record };
    }

    begin(source, requestId, now = Date.now()) {
        const key = interactionKey(source, requestId);
        const current = this.records.get(key);
        if (!current || current.state !== 'pending') return null;
        if (current.expiresAtMs && current.expiresAtMs <= now) {
            const expired = Object.freeze({ ...current, state: 'expired' });
            this.records.set(key, expired);
            return null;
        }
        const responding = Object.freeze({ ...current, state: 'responding' });
        this.records.set(key, responding);
        return responding;
    }

    rollback(source, requestId) {
        const key = interactionKey(source, requestId);
        const current = this.records.get(key);
        if (!current || current.state !== 'responding') return null;
        const pending = Object.freeze({ ...current, state: 'pending' });
        this.records.set(key, pending);
        return pending;
    }

    complete(source, requestId, state = 'completed') {
        const key = interactionKey(source, requestId);
        const current = this.records.get(key);
        if (!current || !['pending', 'responding'].includes(current.state)) return null;
        const terminal = Object.freeze({ ...current, state });
        this.records.set(key, terminal);
        return terminal;
    }

    active() {
        return [...this.records.values()].filter((record) => ['pending', 'responding'].includes(record.state));
    }

    clear() {
        this.records.clear();
    }
}

module.exports = { InteractionRegistry, interactionKey };
