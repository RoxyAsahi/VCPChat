'use strict';

const { fail, ERROR_CODES } = require('./errors');

const RUNTIME_STATES = Object.freeze({
    STOPPED: 'stopped',
    STARTING: 'starting',
    READY: 'ready',
    DEGRADED: 'degraded',
    STOPPING: 'stopping',
});

const SESSION_STATES = Object.freeze({
    CREATED: 'created',
    ACTIVE: 'active',
    IDLE: 'idle',
    CLOSING: 'closing',
    CLOSED: 'closed',
    FAILED: 'failed',
});

const TURN_STATES = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    AWAITING_APPROVAL: 'awaiting-approval',
    CANCELLING: 'cancelling',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    FAILED: 'failed',
});

const TOOL_STATES = Object.freeze({
    REQUESTED: 'requested',
    AWAITING_LOCAL_APPROVAL: 'awaiting-local-approval',
    AWAITING_TOOLBOX_APPROVAL: 'awaiting-toolbox-approval',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    DENIED: 'denied',
});

const APPROVAL_STATES = Object.freeze({
    PENDING: 'pending',
    APPROVED: 'approved',
    DENIED: 'denied',
    EXPIRED: 'expired',
    CANCELLED: 'cancelled',
});

const TERMINAL_TURN_STATES = new Set([
    TURN_STATES.COMPLETED,
    TURN_STATES.CANCELLED,
    TURN_STATES.FAILED,
]);

const TERMINAL_TOOL_STATES = new Set([
    TOOL_STATES.COMPLETED,
    TOOL_STATES.FAILED,
    TOOL_STATES.CANCELLED,
    TOOL_STATES.DENIED,
]);

const TERMINAL_APPROVAL_STATES = new Set([
    APPROVAL_STATES.APPROVED,
    APPROVAL_STATES.DENIED,
    APPROVAL_STATES.EXPIRED,
    APPROVAL_STATES.CANCELLED,
]);

const LEGAL_TRANSITIONS = Object.freeze({
    runtime: Object.freeze({
        [RUNTIME_STATES.STOPPED]: [RUNTIME_STATES.STARTING],
        [RUNTIME_STATES.STARTING]: [RUNTIME_STATES.READY, RUNTIME_STATES.DEGRADED, RUNTIME_STATES.STOPPING, RUNTIME_STATES.STOPPED],
        [RUNTIME_STATES.READY]: [RUNTIME_STATES.DEGRADED, RUNTIME_STATES.STOPPING],
        [RUNTIME_STATES.DEGRADED]: [RUNTIME_STATES.READY, RUNTIME_STATES.STOPPING, RUNTIME_STATES.STOPPED],
        [RUNTIME_STATES.STOPPING]: [RUNTIME_STATES.STOPPED],
    }),
    session: Object.freeze({
        [SESSION_STATES.CREATED]: [SESSION_STATES.ACTIVE, SESSION_STATES.CLOSING, SESSION_STATES.FAILED],
        [SESSION_STATES.ACTIVE]: [SESSION_STATES.IDLE, SESSION_STATES.CLOSING, SESSION_STATES.FAILED],
        [SESSION_STATES.IDLE]: [SESSION_STATES.ACTIVE, SESSION_STATES.CLOSING, SESSION_STATES.FAILED],
        [SESSION_STATES.CLOSING]: [SESSION_STATES.CLOSED, SESSION_STATES.FAILED],
        [SESSION_STATES.CLOSED]: [],
        [SESSION_STATES.FAILED]: [SESSION_STATES.CLOSING],
    }),
    turn: Object.freeze({
        [TURN_STATES.QUEUED]: [TURN_STATES.RUNNING, TURN_STATES.CANCELLED, TURN_STATES.FAILED],
        [TURN_STATES.RUNNING]: [TURN_STATES.AWAITING_APPROVAL, TURN_STATES.CANCELLING, TURN_STATES.COMPLETED, TURN_STATES.FAILED],
        [TURN_STATES.AWAITING_APPROVAL]: [TURN_STATES.RUNNING, TURN_STATES.CANCELLING, TURN_STATES.COMPLETED, TURN_STATES.FAILED],
        [TURN_STATES.CANCELLING]: [TURN_STATES.CANCELLED, TURN_STATES.FAILED],
        [TURN_STATES.COMPLETED]: [],
        [TURN_STATES.CANCELLED]: [],
        [TURN_STATES.FAILED]: [],
    }),
    tool: Object.freeze({
        [TOOL_STATES.REQUESTED]: [TOOL_STATES.AWAITING_LOCAL_APPROVAL, TOOL_STATES.RUNNING, TOOL_STATES.CANCELLED, TOOL_STATES.DENIED, TOOL_STATES.FAILED],
        [TOOL_STATES.AWAITING_LOCAL_APPROVAL]: [TOOL_STATES.RUNNING, TOOL_STATES.AWAITING_TOOLBOX_APPROVAL, TOOL_STATES.DENIED, TOOL_STATES.CANCELLED],
        [TOOL_STATES.AWAITING_TOOLBOX_APPROVAL]: [TOOL_STATES.RUNNING, TOOL_STATES.DENIED, TOOL_STATES.CANCELLED, TOOL_STATES.FAILED],
        [TOOL_STATES.RUNNING]: [TOOL_STATES.AWAITING_TOOLBOX_APPROVAL, TOOL_STATES.COMPLETED, TOOL_STATES.FAILED, TOOL_STATES.CANCELLED],
        [TOOL_STATES.COMPLETED]: [],
        [TOOL_STATES.FAILED]: [],
        [TOOL_STATES.CANCELLED]: [],
        [TOOL_STATES.DENIED]: [],
    }),
    approval: Object.freeze({
        [APPROVAL_STATES.PENDING]: [APPROVAL_STATES.APPROVED, APPROVAL_STATES.DENIED, APPROVAL_STATES.EXPIRED, APPROVAL_STATES.CANCELLED],
        [APPROVAL_STATES.APPROVED]: [],
        [APPROVAL_STATES.DENIED]: [],
        [APPROVAL_STATES.EXPIRED]: [],
        [APPROVAL_STATES.CANCELLED]: [],
    }),
});

function transition(domain, from, to) {
    const table = LEGAL_TRANSITIONS[domain];
    if (!table) {
        fail(ERROR_CODES.INVALID_STATE_TRANSITION, `Unknown state domain: ${domain}`);
    }
    const allowed = table[from];
    if (!allowed || !allowed.includes(to)) {
        fail(
            ERROR_CODES.INVALID_STATE_TRANSITION,
            `Illegal ${domain} transition: ${from} -> ${to}`,
            { domain, from, to },
        );
    }
    return to;
}

function isLegalTransition(domain, from, to) {
    const table = LEGAL_TRANSITIONS[domain];
    if (!table) {
        return false;
    }
    const allowed = table[from];
    return Array.isArray(allowed) && allowed.includes(to);
}

module.exports = {
    RUNTIME_STATES,
    SESSION_STATES,
    TURN_STATES,
    TOOL_STATES,
    APPROVAL_STATES,
    TERMINAL_TURN_STATES,
    TERMINAL_TOOL_STATES,
    TERMINAL_APPROVAL_STATES,
    LEGAL_TRANSITIONS,
    transition,
    isLegalTransition,
};
