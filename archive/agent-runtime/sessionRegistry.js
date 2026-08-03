'use strict';

const { fail, ERROR_CODES } = require('./errors');
const { LIMITS, newId } = require('./contracts');
const {
    SESSION_STATES,
    TURN_STATES,
    TERMINAL_TURN_STATES,
    transition,
} = require('./runtimeState');
const { SessionEventSequencer } = require('./eventFactory');
const { BoundedEventBuffer } = require('./eventBuffer');

class SessionRecord {
    constructor(sessionId, runtime, options = {}) {
        this.sessionId = sessionId;
        this.runtime = runtime;
        this.state = options.state || SESSION_STATES.CREATED;
        this.createdAt = options.createdAt || Date.now();
        this.updatedAt = options.updatedAt || this.createdAt;
        this.closedAt = options.closedAt || null;
        this.title = options.title || null;
        this.parentSessionId = options.parentSessionId || null;
        this.workspaceRoot = options.workspaceRoot || null;
        this.metadata = options.metadata || {};
        this.summaryText = options.summaryText || null;
        this.contextUsage = options.contextUsage || null;
        this.sequencer = new SessionEventSequencer(sessionId, runtime, {
            sequence: options.lastSequence || 0,
        });
        this.buffer = new BoundedEventBuffer(sessionId, options.eventCapacity || LIMITS.MAX_EVENTS_PER_SESSION);
        this.turns = new Map();
        this.activeTurnId = null;
        for (const turn of options.turns || []) {
            this.turns.set(turn.turnId, { ...turn });
            if (!TERMINAL_TURN_STATES.has(turn.state)) this.activeTurnId = turn.turnId;
        }
        for (const event of options.events || []) this.buffer.push(event);
        this.sequencer.restore(options.events || []);
    }

    setState(next) {
        transition('session', this.state, next);
        this.state = next;
        this.updatedAt = Date.now();
        if (next === SESSION_STATES.CLOSED) this.closedAt = this.updatedAt;
        return next;
    }

    startTurn(prompt) {
        if (this.state === SESSION_STATES.CLOSED || this.state === SESSION_STATES.CLOSING) {
            fail(ERROR_CODES.INVALID_STATE_TRANSITION, `Cannot start turn on ${this.state} session`);
        }
        if (this.activeTurnId) {
            const active = this.turns.get(this.activeTurnId);
            if (active && !TERMINAL_TURN_STATES.has(active.state)) {
                fail(ERROR_CODES.INVALID_STATE_TRANSITION,
                    `Session already has active turn: ${this.activeTurnId}`);
            }
        }
        const turnId = newId('turn');
        this.turns.set(turnId, {
            turnId,
            prompt,
            state: TURN_STATES.QUEUED,
            turnIndex: this.turns.size + 1,
            startedAt: Date.now(),
        });
        this.activeTurnId = turnId;
        if (this.state === SESSION_STATES.IDLE || this.state === SESSION_STATES.CREATED) {
            this.setState(SESSION_STATES.ACTIVE);
        }
        return turnId;
    }

    transitionTurn(turnId, next) {
        const turn = this.turns.get(turnId);
        if (!turn) {
            fail(ERROR_CODES.TURN_NOT_FOUND, `Turn not found: ${turnId}`);
        }
        transition('turn', turn.state, next);
        turn.state = next;
        this.updatedAt = Date.now();
        if (TERMINAL_TURN_STATES.has(next)) {
            turn.completedAt = Date.now();
            if (this.activeTurnId === turnId) {
                this.activeTurnId = null;
            }
            if (this.state === SESSION_STATES.ACTIVE) {
                this.state = SESSION_STATES.IDLE;
            }
        }
        return turn;
    }

    getTurn(turnId) {
        return this.turns.get(turnId) || null;
    }

    activeTurn() {
        return this.activeTurnId ? this.turns.get(this.activeTurnId) : null;
    }

    emit(type, payload, correlation = {}) {
        const event = this.sequencer.next(type, payload, correlation);
        this.buffer.push(event);
        return event;
    }

    summary() {
        return {
            sessionId: this.sessionId,
            parentSessionId: this.parentSessionId,
            runtime: this.runtime,
            state: this.state,
            title: this.title,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            closedAt: this.closedAt,
            workspaceRoot: this.workspaceRoot,
            activeTurnId: this.activeTurnId,
            turnCount: this.turns.size,
            lastSequence: this.sequencer.sequence,
            summary: this.summaryText,
            contextUsage: this.contextUsage,
        };
    }
}

class SessionRegistry {
    constructor(options = {}) {
        this.maxSessions = options.maxSessions || LIMITS.MAX_SESSIONS;
        this.sessions = new Map();
    }

    create(runtime, options = {}) {
        if (this.sessions.size >= this.maxSessions) {
            fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Too many sessions', { limit: this.maxSessions });
        }
        const sessionId = options.sessionId || newId('sess');
        const record = new SessionRecord(sessionId, runtime, options);
        this.sessions.set(sessionId, record);
        return record;
    }

    restore(snapshot) {
        return this.create(snapshot.runtime, { ...snapshot, sessionId: snapshot.sessionId });
    }

    get(sessionId) {
        const record = this.sessions.get(sessionId);
        if (!record) {
            fail(ERROR_CODES.SESSION_NOT_FOUND, `Session not found: ${sessionId}`);
        }
        return record;
    }

    maybeGet(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    remove(sessionId) {
        return this.sessions.delete(sessionId);
    }

    list() {
        return Array.from(this.sessions.values()).map((record) => record.summary());
    }

    count() {
        return this.sessions.size;
    }
}

module.exports = {
    SessionRecord,
    SessionRegistry,
};
