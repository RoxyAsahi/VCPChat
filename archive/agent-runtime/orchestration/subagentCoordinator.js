'use strict';

const crypto = require('crypto');

const SUBAGENT_STATES = Object.freeze({
    SPAWNING: 'spawning',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLING: 'cancelling',
    CANCELLED: 'cancelled',
});

const TERMINAL_STATES = new Set([SUBAGENT_STATES.COMPLETED, SUBAGENT_STATES.FAILED, SUBAGENT_STATES.CANCELLED]);

function positive(value, fallback, name) {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(result) || result < 0) throw new TypeError(`${name} must be a non-negative number`);
    return result;
}

function normalizeBudget(budget = {}) {
    return Object.freeze({
        maxDepth: positive(budget.maxDepth, 2, 'maxDepth'),
        maxConcurrency: positive(budget.maxConcurrency, 2, 'maxConcurrency'),
        timeMs: positive(budget.timeMs, 5 * 60 * 1000, 'timeMs'),
        tokens: positive(budget.tokens, 100000, 'tokens'),
        cost: positive(budget.cost, 10, 'cost'),
    });
}

function publicRecord(record) {
    if (!record) return null;
    return JSON.parse(JSON.stringify({
        taskId: record.taskId,
        parentSessionId: record.parentSessionId,
        childSessionId: record.childSessionId,
        depth: record.depth,
        state: record.state,
        createdAt: record.createdAt,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        budget: record.budget,
        usage: record.usage,
        result: record.result,
        error: record.error,
        cancelReason: record.cancelReason,
    }));
}

class SubagentCoordinator {
    constructor(options = {}) {
        for (const name of ['createChild', 'runChild', 'cancelChild']) {
            if (typeof options[name] !== 'function') throw new TypeError(`SubagentCoordinator requires ${name} adapter`);
        }
        this.createChild = options.createChild;
        this.runChild = options.runChild;
        this.cancelChild = options.cancelChild;
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
        this.clock = options.clock || (() => new Date());
        this.budget = normalizeBudget(options.budget);
        this.records = new Map();
        this.sessionDepths = new Map();
        this.childrenByParent = new Map();
        this.usedTokens = 0;
        this.usedCost = 0;
        this.reservedTokens = 0;
        this.reservedCost = 0;
    }

    #emit(type, record, detail = {}) {
        this.onEvent(Object.freeze({
            type,
            timestamp: this.clock().toISOString(),
            task: publicRecord(record),
            detail: JSON.parse(JSON.stringify(detail)),
        }));
    }

    #activeCount() {
        return [...this.records.values()].filter((record) => !TERMINAL_STATES.has(record.state)).length;
    }

    #assertBudget(parentSessionId, requested) {
        const depth = (this.sessionDepths.get(parentSessionId) || 0) + 1;
        if (depth > this.budget.maxDepth) throw new Error('SUBAGENT_MAX_DEPTH_EXCEEDED');
        if (this.#activeCount() >= this.budget.maxConcurrency) throw new Error('SUBAGENT_CONCURRENCY_EXCEEDED');
        if (this.usedTokens + this.reservedTokens + requested.tokens > this.budget.tokens) throw new Error('SUBAGENT_TOKEN_BUDGET_EXCEEDED');
        if (this.usedCost + this.reservedCost + requested.cost > this.budget.cost) throw new Error('SUBAGENT_COST_BUDGET_EXCEEDED');
        return depth;
    }

    async spawn(request = {}) {
        const parentSessionId = String(request.parentSessionId || '');
        if (!parentSessionId) throw new TypeError('parentSessionId is required');
        const requested = {
            timeMs: Math.min(positive(request.budget && request.budget.timeMs, this.budget.timeMs, 'timeMs'), this.budget.timeMs),
            tokens: positive(request.budget && request.budget.tokens, 0, 'tokens'),
            cost: positive(request.budget && request.budget.cost, 0, 'cost'),
        };
        const depth = this.#assertBudget(parentSessionId, requested);
        const taskId = `subtask_${crypto.randomUUID()}`;
        const record = {
            taskId,
            parentSessionId,
            childSessionId: null,
            depth,
            state: SUBAGENT_STATES.SPAWNING,
            createdAt: this.clock().toISOString(),
            startedAt: null,
            endedAt: null,
            budget: requested,
            usage: { tokens: 0, cost: 0, elapsedMs: 0 },
            result: null,
            error: null,
            cancelReason: null,
            promise: null,
            timeout: null,
        };
        this.records.set(taskId, record);
        this.reservedTokens += requested.tokens;
        this.reservedCost += requested.cost;
        if (!this.childrenByParent.has(parentSessionId)) this.childrenByParent.set(parentSessionId, new Set());
        this.childrenByParent.get(parentSessionId).add(taskId);
        this.#emit('subagent.spawning', record);
        try {
            const child = await this.createChild({
                taskId,
                parentSessionId,
                depth,
                task: request.task,
                metadata: request.metadata || {},
                budget: requested,
            });
            const childSessionId = String(child && (child.sessionId || child.childSessionId) || '');
            if (!childSessionId) throw new Error('createChild adapter did not return a sessionId');
            record.childSessionId = childSessionId;
            this.sessionDepths.set(childSessionId, depth);
            record.state = SUBAGENT_STATES.RUNNING;
            record.startedAt = this.clock().toISOString();
            this.#emit('subagent.running', record);
            record.promise = this.#execute(record, request);
            return publicRecord(record);
        } catch (error) {
            this.reservedTokens -= requested.tokens;
            this.reservedCost -= requested.cost;
            record.state = SUBAGENT_STATES.FAILED;
            record.endedAt = this.clock().toISOString();
            record.error = { code: 'CREATE_CHILD_FAILED', message: error.message };
            this.#emit('subagent.failed', record);
            throw error;
        }
    }

    async #execute(record, request) {
        const started = Date.parse(record.startedAt);
        let timeoutPromise;
        if (record.budget.timeMs > 0) {
            timeoutPromise = new Promise((_, reject) => {
                record.timeout = setTimeout(() => reject(Object.assign(new Error('SUBAGENT_TIME_BUDGET_EXCEEDED'), { code: 'SUBAGENT_TIME_BUDGET_EXCEEDED' })), record.budget.timeMs);
            });
        }
        try {
            const run = Promise.resolve(this.runChild({
                taskId: record.taskId,
                parentSessionId: record.parentSessionId,
                childSessionId: record.childSessionId,
                task: request.task,
                metadata: request.metadata || {},
                budget: record.budget,
            }));
            const output = await (timeoutPromise ? Promise.race([run, timeoutPromise]) : run);
            if (record.state === SUBAGENT_STATES.CANCELLING || record.state === SUBAGENT_STATES.CANCELLED) {
                record.state = SUBAGENT_STATES.CANCELLED;
            } else {
                const usage = output && output.usage || {};
                record.usage.tokens = positive(usage.tokens, 0, 'usage.tokens');
                record.usage.cost = positive(usage.cost, 0, 'usage.cost');
                this.usedTokens += record.usage.tokens;
                this.usedCost += record.usage.cost;
                if (record.budget.tokens > 0 && record.usage.tokens > record.budget.tokens) {
                    throw Object.assign(new Error('SUBAGENT_TASK_TOKEN_BUDGET_EXCEEDED'), { code: 'SUBAGENT_TASK_TOKEN_BUDGET_EXCEEDED' });
                }
                if (record.budget.cost > 0 && record.usage.cost > record.budget.cost) {
                    throw Object.assign(new Error('SUBAGENT_TASK_COST_BUDGET_EXCEEDED'), { code: 'SUBAGENT_TASK_COST_BUDGET_EXCEEDED' });
                }
                if (this.usedTokens > this.budget.tokens) throw Object.assign(new Error('SUBAGENT_TOKEN_BUDGET_EXCEEDED'), { code: 'SUBAGENT_TOKEN_BUDGET_EXCEEDED' });
                if (this.usedCost > this.budget.cost) throw Object.assign(new Error('SUBAGENT_COST_BUDGET_EXCEEDED'), { code: 'SUBAGENT_COST_BUDGET_EXCEEDED' });
                record.result = output && Object.hasOwn(output, 'result') ? output.result : output;
                record.state = SUBAGENT_STATES.COMPLETED;
            }
        } catch (error) {
            if (record.state === SUBAGENT_STATES.CANCELLING || error.name === 'AbortError') {
                record.state = SUBAGENT_STATES.CANCELLED;
            } else {
                record.state = SUBAGENT_STATES.FAILED;
                record.error = { code: error.code || 'RUN_CHILD_FAILED', message: error.message };
                if (error.code === 'SUBAGENT_TIME_BUDGET_EXCEEDED') {
                    await this.cancelChild({ taskId: record.taskId, childSessionId: record.childSessionId, reason: 'time-budget-exceeded' }).catch(() => {});
                }
            }
        } finally {
            if (record.timeout) clearTimeout(record.timeout);
            this.reservedTokens -= record.budget.tokens;
            this.reservedCost -= record.budget.cost;
            record.endedAt = this.clock().toISOString();
            record.usage.elapsedMs = Math.max(0, Date.parse(record.endedAt) - started);
            this.#emit(`subagent.${record.state}`, record);
        }
        return publicRecord(record);
    }

    async await(taskId) {
        const record = this.records.get(taskId);
        if (!record) throw new Error(`Unknown subagent task: ${taskId}`);
        if (record.promise) await record.promise;
        return publicRecord(record);
    }

    async cancel(taskId, reason = 'cancelled') {
        const record = this.records.get(taskId);
        if (!record) return false;
        if (TERMINAL_STATES.has(record.state)) return false;
        record.state = SUBAGENT_STATES.CANCELLING;
        record.cancelReason = String(reason);
        this.#emit('subagent.cancelling', record);
        if (record.childSessionId) {
            await Promise.allSettled([
                this.cancelChild({ taskId, childSessionId: record.childSessionId, reason: record.cancelReason }),
                this.cancelByParent(record.childSessionId, record.cancelReason),
            ]);
        }
        record.state = SUBAGENT_STATES.CANCELLED;
        if (!record.promise) {
            record.endedAt = this.clock().toISOString();
            this.#emit('subagent.cancelled', record);
        }
        return true;
    }

    async cancelByParent(parentSessionId, reason = 'parent-cancelled') {
        const ids = [...(this.childrenByParent.get(parentSessionId) || [])];
        await Promise.allSettled(ids.map((id) => this.cancel(id, reason)));
        return ids.length;
    }

    get(taskId) {
        return publicRecord(this.records.get(taskId));
    }

    list() {
        return [...this.records.values()].map(publicRecord);
    }

    usage() {
        return {
            tokens: this.usedTokens,
            cost: this.usedCost,
            reservedTokens: this.reservedTokens,
            reservedCost: this.reservedCost,
            active: this.#activeCount(),
        };
    }
}

module.exports = {
    SubagentCoordinator,
    SUBAGENT_STATES,
    normalizeBudget,
};
