'use strict';

// Clean-room state model informed by Harnss permission-queue (MIT, dc1dfd8).
// It deliberately namespaces source/request IDs: a ToolBox requestId must
// never be accepted as a Codex JSON-RPC requestId (or vice versa).
function interactionKey(source, requestId, generation = 0) {
    const normalizedSource = String(source || '').trim();
    const normalizedRequestId = String(requestId || '').trim();
    if (!normalizedSource || !normalizedRequestId) throw new TypeError('Interaction requires source and requestId');
    const normalizedGeneration = Number.isInteger(Number(generation)) ? Number(generation) : 0;
    return `${normalizedSource}:${normalizedGeneration}:${normalizedRequestId}`;
}

class InteractionRegistry {
    constructor(options = {}) {
        this.records = new Map();
        this.generations = new Map();
        this.terminalTtlMs = Number.isFinite(options.terminalTtlMs) ? Math.max(1, options.terminalTtlMs) : 5 * 60_000;
        this.maxRecords = Number.isInteger(options.maxRecords) ? Math.max(16, options.maxRecords) : 1024;
        this.now = options.now || (() => Date.now());
    }

    setGeneration(source, generation) {
        const value = Number(generation);
        if (!Number.isInteger(value) || value < 0) throw new TypeError('Interaction generation must be a non-negative integer');
        this.generations.set(String(source), value);
        this.prune();
        return value;
    }

    generation(source) {
        return this.generations.get(String(source)) || 0;
    }

    enqueue(input) {
        this.prune();
        const generation = Number.isInteger(Number(input?.generation))
            ? Number(input.generation)
            : this.generation(input?.source);
        const key = interactionKey(input?.source, input?.requestId, generation);
        if (this.records.has(key)) return { accepted: false, record: this.records.get(key) };
        const record = Object.freeze({
            key,
            source: String(input.source),
            requestId: String(input.requestId),
            generation,
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

    begin(source, requestId, generation = this.generation(source), now = this.now()) {
        const key = interactionKey(source, requestId, generation);
        const current = this.records.get(key);
        if (!current || current.state !== 'pending') return null;
        if (current.expiresAtMs && current.expiresAtMs <= now) {
            const expired = Object.freeze({ ...current, state: 'expired', terminalAt: now });
            this.records.set(key, expired);
            return null;
        }
        const responding = Object.freeze({ ...current, state: 'responding' });
        this.records.set(key, responding);
        return responding;
    }

    rollback(source, requestId, generation = this.generation(source)) {
        const key = interactionKey(source, requestId, generation);
        const current = this.records.get(key);
        if (!current || current.state !== 'responding') return null;
        const pending = Object.freeze({ ...current, state: 'pending' });
        this.records.set(key, pending);
        return pending;
    }

    complete(source, requestId, state = 'completed', generation = this.generation(source)) {
        const key = interactionKey(source, requestId, generation);
        const current = this.records.get(key);
        if (!current || !['pending', 'responding'].includes(current.state)) return null;
        const terminal = Object.freeze({ ...current, state, terminalAt: this.now() });
        this.records.set(key, terminal);
        this.prune();
        return terminal;
    }

    active() {
        this.prune();
        return [...this.records.values()].filter((record) => ['pending', 'responding'].includes(record.state));
    }

    prune(now = this.now()) {
        for (const [key, record] of this.records) {
            if (!['pending', 'responding'].includes(record.state)
                && Number(record.terminalAt || record.createdAt) + this.terminalTtlMs <= now) {
                this.records.delete(key);
            }
        }
        if (this.records.size <= this.maxRecords) return;
        const terminal = [...this.records.values()]
            .filter((record) => !['pending', 'responding'].includes(record.state))
            .sort((left, right) => Number(left.terminalAt || left.createdAt) - Number(right.terminalAt || right.createdAt));
        for (const record of terminal) {
            if (this.records.size <= this.maxRecords) break;
            this.records.delete(record.key);
        }
    }

    clear({ source, generation } = {}) {
        if (!source && generation === undefined) {
            this.records.clear();
            return;
        }
        for (const [key, record] of this.records) {
            if (source && record.source !== source) continue;
            if (generation !== undefined && record.generation !== Number(generation)) continue;
            this.records.delete(key);
        }
    }
}

module.exports = { InteractionRegistry, interactionKey };
