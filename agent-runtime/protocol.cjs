'use strict';

// Sidecar wire protocol shared by the Electron main process and the agent worker.
// Messages travel over the Node IPC channel created by child_process.fork().

const PROTOCOL_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
    HELLO: 'hello',
    READY: 'ready',
    START_SESSION: 'start-session',
    SESSION_STARTED: 'session-started',
    CLOSE_SESSION: 'close-session',
    START_TURN: 'start-turn',
    CANCEL_TURN: 'cancel-turn',
    MODEL_REQUEST: 'model-request',
    MODEL_DELTA: 'model-delta',
    MODEL_DONE: 'model-done',
    MODEL_ERROR: 'model-error',
    MODEL_ABORT: 'model-abort',
    MODEL_RESULT: 'model-result',
    TOOL_REQUEST: 'tool-request',
    TOOL_RESULT: 'tool-result',
    EVENT: 'event',
    SHUTDOWN: 'shutdown',
    ACK: 'ack',
    FATAL: 'fatal',
});

const REQUIRED_FIELDS = Object.freeze({
    [MESSAGE_TYPES.HELLO]: ['protocolVersion'],
    [MESSAGE_TYPES.READY]: ['protocolVersion', 'probe'],
    [MESSAGE_TYPES.START_SESSION]: ['requestId', 'sessionId', 'options'],
    [MESSAGE_TYPES.SESSION_STARTED]: ['requestId', 'sessionId', 'ok'],
    [MESSAGE_TYPES.CLOSE_SESSION]: ['requestId', 'sessionId'],
    [MESSAGE_TYPES.START_TURN]: ['requestId', 'sessionId', 'turnId', 'prompt'],
    [MESSAGE_TYPES.CANCEL_TURN]: ['requestId', 'sessionId'],
    [MESSAGE_TYPES.MODEL_REQUEST]: ['requestId', 'sessionId', 'turnId', 'body'],
    [MESSAGE_TYPES.MODEL_DELTA]: ['requestId', 'delta'],
    [MESSAGE_TYPES.MODEL_DONE]: ['requestId'],
    [MESSAGE_TYPES.MODEL_ERROR]: ['requestId', 'error'],
    [MESSAGE_TYPES.MODEL_ABORT]: ['requestId'],
    [MESSAGE_TYPES.MODEL_RESULT]: ['requestId', 'ok'],
    [MESSAGE_TYPES.TOOL_REQUEST]: ['sessionId', 'turnId', 'toolCallId', 'toolName', 'arguments'],
    [MESSAGE_TYPES.TOOL_RESULT]: ['sessionId', 'turnId', 'toolCallId', 'ok'],
    [MESSAGE_TYPES.EVENT]: ['sessionId', 'event'],
    [MESSAGE_TYPES.SHUTDOWN]: ['requestId'],
    [MESSAGE_TYPES.ACK]: ['requestId', 'ok'],
    [MESSAGE_TYPES.FATAL]: ['error'],
});

function validateMessage(message) {
    if (!message || typeof message !== 'object') {
        return { ok: false, error: 'message must be an object' };
    }
    if (typeof message.type !== 'string' || !REQUIRED_FIELDS[message.type]) {
        return { ok: false, error: `unknown message type: ${String(message.type)}` };
    }
    for (const field of REQUIRED_FIELDS[message.type]) {
        if (!(field in message)) {
            return { ok: false, error: `message ${message.type} missing field: ${field}` };
        }
    }
    return { ok: true };
}

function makeAck(requestId, ok, extra = {}) {
    return { type: MESSAGE_TYPES.ACK, requestId, ok, ...extra };
}

module.exports = {
    PROTOCOL_VERSION,
    MESSAGE_TYPES,
    validateMessage,
    makeAck,
};
