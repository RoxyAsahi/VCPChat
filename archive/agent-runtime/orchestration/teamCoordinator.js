'use strict';

const crypto = require('crypto');
const path = require('path');

const RUN_STATES = Object.freeze({
    CREATED: 'created',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLING: 'cancelling',
    CANCELLED: 'cancelled',
});

const WAVE_STRATEGIES = new Set(['sequential', 'parallel', 'adaptive']);

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function nonNegative(value, fallback, name) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} must be a non-negative number`);
    return number;
}

function normalizeArtifactRef(ref) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new TypeError('artifact ref must be an object');
    const id = String(ref.id || '').trim();
    const uri = String(ref.uri || '').trim();
    if (!id || !uri) throw new TypeError('artifact ref requires id and uri');
    return Object.freeze({ id, uri, mediaType: ref.mediaType ? String(ref.mediaType) : null, hash: ref.hash ? String(ref.hash) : null });
}

function normalizeBlackboardEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('blackboard entry must be a structured object');
    const kind = String(entry.kind || '').trim();
    const key = String(entry.key || '').trim();
    if (!kind || !key) throw new TypeError('blackboard entry requires kind and key');
    if (entry.value !== undefined && (entry.value === null || typeof entry.value !== 'object')) {
        throw new TypeError('blackboard value must be a structured object or array');
    }
    const artifactRefs = (entry.artifactRefs || []).map(normalizeArtifactRef);
    if (entry.value === undefined && artifactRefs.length === 0) {
        throw new TypeError('blackboard entry requires structured value or artifactRefs');
    }
    return Object.freeze({ kind, key, value: entry.value === undefined ? null : clone(entry.value), artifactRefs });
}

class Blackboard {
    constructor(entries = []) {
        this.entries = new Map();
        for (const entry of entries) this.put(entry);
    }

    put(entry) {
        const normalized = normalizeBlackboardEntry(entry);
        this.entries.set(`${normalized.kind}:${normalized.key}`, normalized);
        return clone(normalized);
    }

    get(kind, key) {
        return clone(this.entries.get(`${kind}:${key}`) || null);
    }

    list() {
        return [...this.entries.values()].map(clone);
    }
}

function canonicalOwnershipPath(value) {
    const resolved = path.resolve(String(value || ''));
    if (!value) throw new TypeError('ownership path is required');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ownershipOverlaps(left, right) {
    const a = canonicalOwnershipPath(left);
    const b = canonicalOwnershipPath(right);
    const relativeAB = path.relative(a, b);
    const relativeBA = path.relative(b, a);
    const inside = (relative) => relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    return inside(relativeAB) || inside(relativeBA);
}

class OwnershipRegistry {
    constructor(records = []) {
        this.records = [];
        for (const record of records) this.claim(record);
    }

    claim(input) {
        const memberId = String(input && input.memberId || '').trim();
        const ownedPath = canonicalOwnershipPath(input && input.path);
        if (!memberId) throw new TypeError('ownership memberId is required');
        const conflict = this.records.find((record) => record.memberId !== memberId && ownershipOverlaps(record.path, ownedPath));
        if (conflict) {
            const error = new Error(`OWNERSHIP_CONFLICT: ${ownedPath} overlaps ${conflict.path}`);
            error.code = 'OWNERSHIP_CONFLICT';
            error.conflict = clone(conflict);
            throw error;
        }
        const existing = this.records.find((record) => record.memberId === memberId && record.path === ownedPath);
        if (existing) return clone(existing);
        const record = Object.freeze({ memberId, path: ownedPath, claimedAt: new Date().toISOString() });
        this.records.push(record);
        return clone(record);
    }

    releaseMember(memberId) {
        const before = this.records.length;
        this.records = this.records.filter((record) => record.memberId !== memberId);
        return before - this.records.length;
    }

    list() {
        return this.records.map(clone);
    }
}

class TeamCoordinator {
    constructor(options = {}) {
        if (typeof options.executeMember !== 'function') throw new TypeError('TeamCoordinator requires executeMember adapter');
        this.executeMember = options.executeMember;
        this.cancelMember = typeof options.cancelMember === 'function' ? options.cancelMember : async () => {};
        this.persistence = options.persistence || null;
        this.onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
        this.clock = options.clock || (() => new Date());
        this.runs = new Map();
    }

    #emit(type, run, detail = {}) {
        this.onEvent(Object.freeze({ type, timestamp: this.clock().toISOString(), runId: run.id, detail: clone(detail) }));
    }

    async #save(run) {
        if (this.persistence && typeof this.persistence.saveRun === 'function') {
            await this.persistence.saveRun(this.snapshot(run.id));
        }
    }

    createRun(spec = {}) {
        const members = (spec.members || []).map((member, index) => {
            const id = String(member.id || `member-${index + 1}`);
            return {
                id,
                role: Object.freeze({ id: String(member.role && member.role.id || member.role || 'worker'), instructions: String(member.role && member.role.instructions || '') }),
                task: clone(member.task || {}),
                state: 'pending',
                result: null,
                error: null,
                usage: { tokens: 0, cost: 0 },
            };
        });
        const memberIds = new Set(members.map((member) => member.id));
        if (memberIds.size !== members.length) throw new Error('Team member ids must be unique');
        const waves = (spec.waves || [{ strategy: 'sequential', memberIds: members.map((member) => member.id) }]).map((wave, index) => {
            const strategy = String(wave.strategy || 'sequential');
            if (!WAVE_STRATEGIES.has(strategy)) throw new TypeError(`Unknown wave strategy: ${strategy}`);
            const ids = (wave.memberIds || []).map(String);
            if (ids.some((id) => !memberIds.has(id))) throw new Error(`Wave ${index + 1} references unknown member`);
            return { id: String(wave.id || `wave-${index + 1}`), strategy, memberIds: ids, state: 'pending' };
        });
        const run = {
            id: String(spec.id || `teamrun_${crypto.randomUUID()}`),
            state: RUN_STATES.CREATED,
            createdAt: this.clock().toISOString(),
            startedAt: null,
            endedAt: null,
            members,
            waves,
            budget: {
                timeMs: nonNegative(spec.budget && spec.budget.timeMs, 10 * 60 * 1000, 'timeMs'),
                tokens: nonNegative(spec.budget && spec.budget.tokens, 200000, 'tokens'),
                cost: nonNegative(spec.budget && spec.budget.cost, 20, 'cost'),
                concurrency: Math.max(1, nonNegative(spec.budget && spec.budget.concurrency, 4, 'concurrency')),
            },
            usage: { tokens: 0, cost: 0 },
            ownership: new OwnershipRegistry(),
            handoffs: [],
            blackboard: new Blackboard(),
            cancelled: false,
        };
        for (const claim of spec.ownership || []) run.ownership.claim(claim);
        this.runs.set(run.id, run);
        this.#emit('team.created', run);
        return this.snapshot(run.id);
    }

    async restore(runId) {
        if (!this.persistence || typeof this.persistence.loadRun !== 'function') throw new Error('Persistence adapter does not support loadRun');
        const data = await this.persistence.loadRun(runId);
        if (!data) return null;
        const run = {
            ...clone(data),
            ownership: new OwnershipRegistry(data.ownership || []),
            blackboard: new Blackboard(data.blackboard || []),
            cancelled: data.state === RUN_STATES.CANCELLED,
        };
        this.runs.set(run.id, run);
        return this.snapshot(run.id);
    }

    claimOwnership(runId, claim) {
        const run = this.#requireRun(runId);
        const value = run.ownership.claim(claim);
        this.#emit('team.ownership.claimed', run, value);
        return value;
    }

    addHandoff(runId, input) {
        const run = this.#requireRun(runId);
        const handoff = Object.freeze({
            id: String(input.id || `handoff_${crypto.randomUUID()}`),
            fromMemberId: String(input.fromMemberId || ''),
            toMemberId: String(input.toMemberId || ''),
            summary: clone(input.summary || {}),
            artifactRefs: (input.artifactRefs || []).map(normalizeArtifactRef),
            createdAt: this.clock().toISOString(),
        });
        if (!handoff.fromMemberId || !handoff.toMemberId || handoff.summary === null || typeof handoff.summary !== 'object') {
            throw new TypeError('handoff requires members and structured summary');
        }
        run.handoffs.push(handoff);
        this.#emit('team.handoff.created', run, handoff);
        return clone(handoff);
    }

    putBlackboard(runId, entry) {
        const run = this.#requireRun(runId);
        const value = run.blackboard.put(entry);
        this.#emit('team.blackboard.updated', run, { kind: value.kind, key: value.key, artifactRefs: value.artifactRefs });
        return value;
    }

    async run(runId) {
        const run = this.#requireRun(runId);
        if (run.state !== RUN_STATES.CREATED) throw new Error(`Run cannot start from ${run.state}`);
        run.state = RUN_STATES.RUNNING;
        run.startedAt = this.clock().toISOString();
        this.#emit('team.running', run);
        await this.#save(run);
        let timer;
        if (run.budget.timeMs > 0) timer = setTimeout(() => this.cancel(run.id, 'time-budget-exceeded').catch(() => {}), run.budget.timeMs);
        try {
            for (const wave of run.waves) {
                if (run.cancelled) break;
                wave.state = 'running';
                this.#emit('team.wave.started', run, { waveId: wave.id, strategy: wave.strategy });
                await this.#executeWave(run, wave);
                wave.state = run.cancelled ? 'cancelled' : 'completed';
                await this.#save(run);
            }
            if (run.cancelled) {
                run.state = RUN_STATES.CANCELLED;
            } else if (run.members.some((member) => member.state === 'failed')) {
                run.state = RUN_STATES.FAILED;
            } else {
                run.state = RUN_STATES.COMPLETED;
            }
        } catch (error) {
            run.state = run.cancelled ? RUN_STATES.CANCELLED : RUN_STATES.FAILED;
            this.#emit('team.failed', run, { code: error.code || 'TEAM_RUN_FAILED', message: error.message });
        } finally {
            if (timer) clearTimeout(timer);
            run.endedAt = this.clock().toISOString();
            this.#emit(`team.${run.state}`, run);
            await this.#save(run);
        }
        return this.snapshot(run.id);
    }

    async #executeWave(run, wave) {
        const members = wave.memberIds.map((id) => run.members.find((member) => member.id === id));
        if (wave.strategy === 'sequential') {
            for (const member of members) {
                if (run.cancelled) break;
                await this.#executeOne(run, wave, member);
            }
            return;
        }
        const concurrency = wave.strategy === 'parallel'
            ? run.budget.concurrency
            : Math.max(1, Math.min(run.budget.concurrency, Math.ceil(members.length / 2)));
        let cursor = 0;
        const workers = Array.from({ length: Math.min(concurrency, members.length) }, async () => {
            while (!run.cancelled) {
                const index = cursor++;
                if (index >= members.length) return;
                await this.#executeOne(run, wave, members[index]);
            }
        });
        await Promise.all(workers);
    }

    async #executeOne(run, wave, member) {
        if (run.usage.tokens >= run.budget.tokens) throw Object.assign(new Error('TEAM_TOKEN_BUDGET_EXCEEDED'), { code: 'TEAM_TOKEN_BUDGET_EXCEEDED' });
        if (run.usage.cost >= run.budget.cost) throw Object.assign(new Error('TEAM_COST_BUDGET_EXCEEDED'), { code: 'TEAM_COST_BUDGET_EXCEEDED' });
        member.state = 'running';
        this.#emit('team.member.started', run, { memberId: member.id, waveId: wave.id });
        try {
            const output = await this.executeMember({
                runId: run.id,
                wave: clone(wave),
                member: clone(member),
                ownership: run.ownership.list().filter((claim) => claim.memberId === member.id),
                handoffs: run.handoffs.filter((handoff) => handoff.toMemberId === member.id).map(clone),
                blackboard: run.blackboard.list(),
                remainingBudget: { tokens: run.budget.tokens - run.usage.tokens, cost: run.budget.cost - run.usage.cost },
            });
            const usage = output && output.usage || {};
            member.usage = { tokens: nonNegative(usage.tokens, 0, 'usage.tokens'), cost: nonNegative(usage.cost, 0, 'usage.cost') };
            run.usage.tokens += member.usage.tokens;
            run.usage.cost += member.usage.cost;
            if (run.usage.tokens > run.budget.tokens) throw Object.assign(new Error('TEAM_TOKEN_BUDGET_EXCEEDED'), { code: 'TEAM_TOKEN_BUDGET_EXCEEDED' });
            if (run.usage.cost > run.budget.cost) throw Object.assign(new Error('TEAM_COST_BUDGET_EXCEEDED'), { code: 'TEAM_COST_BUDGET_EXCEEDED' });
            member.result = output && Object.hasOwn(output, 'result') ? output.result : output;
            member.state = run.cancelled ? 'cancelled' : 'completed';
        } catch (error) {
            member.state = run.cancelled ? 'cancelled' : 'failed';
            member.error = { code: error.code || 'MEMBER_FAILED', message: error.message };
            if (error.code === 'TEAM_TOKEN_BUDGET_EXCEEDED' || error.code === 'TEAM_COST_BUDGET_EXCEEDED') throw error;
        } finally {
            this.#emit(`team.member.${member.state}`, run, { memberId: member.id, usage: member.usage, error: member.error });
        }
    }

    async cancel(runId, reason = 'cancelled') {
        const run = this.#requireRun(runId);
        if ([RUN_STATES.COMPLETED, RUN_STATES.FAILED, RUN_STATES.CANCELLED].includes(run.state)) return false;
        run.cancelled = true;
        run.state = RUN_STATES.CANCELLING;
        this.#emit('team.cancelling', run, { reason });
        const active = run.members.filter((member) => member.state === 'running');
        await Promise.allSettled(active.map((member) => this.cancelMember({ runId, memberId: member.id, reason })));
        for (const member of active) member.state = 'cancelled';
        return true;
    }

    #requireRun(runId) {
        const run = this.runs.get(runId);
        if (!run) throw new Error(`Unknown team run: ${runId}`);
        return run;
    }

    snapshot(runId) {
        const run = this.#requireRun(runId);
        return clone({
            id: run.id,
            state: run.state,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            members: run.members,
            waves: run.waves,
            budget: run.budget,
            usage: run.usage,
            ownership: run.ownership.list(),
            handoffs: run.handoffs,
            blackboard: run.blackboard.list(),
        });
    }
}

module.exports = {
    TeamCoordinator,
    Blackboard,
    OwnershipRegistry,
    RUN_STATES,
    WAVE_STRATEGIES,
    ownershipOverlaps,
};
