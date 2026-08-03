'use strict';

class AgentRuntimeError extends Error {
    constructor(code, message, details) {
        super(message);
        this.name = 'AgentRuntimeError';
        this.code = code;
        if (details !== undefined) {
            this.details = details;
        }
    }

    toJSON() {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            details: this.details,
        };
    }
}

const ERROR_CODES = Object.freeze({
    PROTOCOL_VERSION_MISMATCH: 'PROTOCOL_VERSION_MISMATCH',
    INVALID_EVENT_ENVELOPE: 'INVALID_EVENT_ENVELOPE',
    INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
    DUPLICATE_EVENT: 'DUPLICATE_EVENT',
    STALE_EVENT: 'STALE_EVENT',
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    TURN_NOT_FOUND: 'TURN_NOT_FOUND',
    TOOL_CALL_NOT_FOUND: 'TOOL_CALL_NOT_FOUND',
    APPROVAL_NOT_FOUND: 'APPROVAL_NOT_FOUND',
    APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
    APPROVAL_DENIED: 'APPROVAL_DENIED',
    APPROVAL_ARGUMENT_MISMATCH: 'APPROVAL_ARGUMENT_MISMATCH',
    RUNTIME_NOT_READY: 'RUNTIME_NOT_READY',
    WORKER_CRASHED: 'WORKER_CRASHED',
    WORKER_TIMEOUT: 'WORKER_TIMEOUT',
    WORKER_PROTOCOL_ERROR: 'WORKER_PROTOCOL_ERROR',
    PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
    WORKSPACE_OUTSIDE_ROOT: 'WORKSPACE_OUTSIDE_ROOT',
    WORKSPACE_INVALID: 'WORKSPACE_INVALID',
    TOOL_PROTOCOL_VIOLATION: 'TOOL_PROTOCOL_VIOLATION',
    TOOLBOX_REQUEST_FAILED: 'TOOLBOX_REQUEST_FAILED',
    TOOLBOX_INTERRUPT_FAILED: 'TOOLBOX_INTERRUPT_FAILED',
    UNAUTHORIZED_SENDER: 'UNAUTHORIZED_SENDER',
    SHUTDOWN_IN_PROGRESS: 'SHUTDOWN_IN_PROGRESS',
});

function fail(code, message, details) {
    throw new AgentRuntimeError(code, message, details);
}

module.exports = {
    AgentRuntimeError,
    ERROR_CODES,
    fail,
};
