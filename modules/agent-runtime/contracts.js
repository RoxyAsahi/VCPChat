'use strict';

const crypto = require('crypto');
const { fail, ERROR_CODES } = require('./errors');

const PROTOCOL_VERSION = 1;
const EVENT_SCHEMA_VERSION = 1;

const LIMITS = Object.freeze({
    MAX_PROMPT_CHARS: 128 * 1024,
    MAX_TOOL_ARGUMENT_BYTES: 32 * 1024,
    MAX_TOOL_RESULT_BYTES: 64 * 1024,
    MAX_EVENT_PAYLOAD_BYTES: 256 * 1024,
    MAX_EVENTS_PER_SESSION: 2000,
    MAX_SESSIONS: 64,
    MAX_PENDING_APPROVALS: 32,
    MAX_TOOL_NAME_CHARS: 256,
    APPROVAL_TIMEOUT_MS: 120 * 1000,
    WORKER_STARTUP_TIMEOUT_MS: 30 * 1000,
    WORKER_SHUTDOWN_TIMEOUT_MS: 10 * 1000,
    TOOL_DEFAULT_TIMEOUT_MS: 120 * 1000,
    TURN_DEFAULT_TIMEOUT_MS: 5 * 60 * 1000,
    TURN_MAX_TIMEOUT_MS: 30 * 60 * 1000,
    MODEL_DELTA_CHUNK_BYTES: 8 * 1024,
});

const IPC_CHANNELS = Object.freeze({
    GET_STATUS: 'agent-runtime:get-status',
    START: 'agent-runtime:start',
    STOP: 'agent-runtime:stop',
    CREATE_SESSION: 'agent-runtime:create-session',
    CLOSE_SESSION: 'agent-runtime:close-session',
    COMPACT_SESSION: 'agent-runtime:compact-session',
    LIST_TOPICS: 'agent-runtime:list-topics',
    SEARCH_TOPICS: 'agent-runtime:search-topics',
    SEARCH_TOPIC_MESSAGES: 'agent-runtime:search-topic-messages',
    GET_TOPIC_INDEX_STATUS: 'agent-runtime:get-topic-index-status',
    REBUILD_TOPIC_INDEX: 'agent-runtime:rebuild-topic-index',
    READ_TOPIC: 'agent-runtime:read-topic',
    TAKEOVER_TOPIC: 'agent-runtime:takeover-topic',
    RENAME_TOPIC: 'agent-runtime:rename-topic',
    DELETE_TOPIC: 'agent-runtime:delete-topic',
    LIST_INTERACTION_QUEUE: 'agent-runtime:list-interaction-queue',
    REPLACE_INTERACTION_QUEUE: 'agent-runtime:replace-interaction-queue',
    CLEAR_INTERACTION_QUEUE: 'agent-runtime:clear-interaction-queue',
    GET_WORKBENCH_SETTINGS: 'agent-runtime:get-workbench-settings',
    UPDATE_WORKBENCH_SETTINGS: 'agent-runtime:update-workbench-settings',
    SELECT_ATTACHMENTS: 'agent-runtime:select-attachments',
    START_TURN: 'agent-runtime:start-turn',
    STEER_TURN: 'agent-runtime:steer-turn',
    FOLLOW_UP_TURN: 'agent-runtime:follow-up-turn',
    CANCEL_TURN: 'agent-runtime:cancel-turn',
    RESPOND_APPROVAL: 'agent-runtime:respond-approval',
    SET_WORKBENCH_PRESENCE: 'agent-runtime:set-workbench-presence',
    EVENT: 'agent-runtime:event',
});

const WORKER_MESSAGE_TYPES = Object.freeze({
    HELLO: 'hello',
    READY: 'ready',
    START_SESSION: 'start-session',
    START_TURN: 'start-turn',
    CANCEL_TURN: 'cancel-turn',
    APPROVAL_RESPONSE: 'approval-response',
    TOOL_REQUEST: 'tool-request',
    TOOL_RESULT: 'tool-result',
    EVENT: 'event',
    SHUTDOWN: 'shutdown',
    FATAL: 'fatal',
});

const EVENT_TYPES = Object.freeze({
    SESSION_CREATED: 'session.created',
    SESSION_STATE_CHANGED: 'session.state_changed',
    SESSION_CLOSED: 'session.closed',
    TURN_STARTED: 'turn.started',
    TURN_COMPLETED: 'turn.completed',
    TURN_CANCELLED: 'turn.cancelled',
    TURN_FAILED: 'turn.failed',
    USER_MESSAGE: 'user.message',
    ASSISTANT_STARTED: 'assistant.started',
    ASSISTANT_DELTA: 'assistant.delta',
    ASSISTANT_COMPLETED: 'assistant.completed',
    REASONING_STARTED: 'reasoning.started',
    REASONING_DELTA: 'reasoning.delta',
    REASONING_COMPLETED: 'reasoning.completed',
    TOOL_REQUESTED: 'tool.requested',
    TOOL_AWAITING_LOCAL_APPROVAL: 'tool.awaiting_local_approval',
    TOOL_AWAITING_TOOLBOX_APPROVAL: 'tool.awaiting_toolbox_approval',
    TOOL_STARTED: 'tool.started',
    TOOL_PROGRESS: 'tool.progress',
    TOOL_COMPLETED: 'tool.completed',
    TOOL_FAILED: 'tool.failed',
    TOOL_CANCELLED: 'tool.cancelled',
    APPROVAL_REQUESTED: 'approval.requested',
    APPROVAL_RESOLVED: 'approval.resolved',
    APPROVAL_EXPIRED: 'approval.expired',
    PLAN_UPDATED: 'plan.updated',
    CONTEXT_COMPACTION_STARTED: 'context.compaction_started',
    CONTEXT_COMPACTION_COMPLETED: 'context.compaction_completed',
    CONTEXT_USAGE: 'context.usage',
    // Read-only projection of VCPlog / vcpinfo / vcp-distributed-server.
    // It is observability only and can never request a ToolBox execution.
    TOOLBOX_WS: 'toolbox.ws',
    // A model-emitted VCP marker is filtered by Rust Core before projection.
    // It is display-only and is deliberately neither a ToolBox WS event nor a
    // second tool execution path.
    MARKER_OBSERVED: 'marker.observed',
    RUNTIME_STATE_CHANGED: 'runtime.state_changed',
    RUNTIME_INTERRUPT_RESULT: 'runtime.interrupt_result',
    RUNTIME_WARNING: 'runtime.warning',
    RUNTIME_CRASHED: 'runtime.crashed',
});

const EVENT_TYPE_SET = new Set(Object.values(EVENT_TYPES));

const RUNTIME_KINDS = Object.freeze({
    PI: 'pi',
    MOCK: 'mock',
});

const LEGACY_TOOL_NAMES = Object.freeze({
    VCP_DELEGATE: 'vcp_delegate',
    VCP_INVOKE: 'vcp_invoke',
});

function newId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function hashArguments(args) {
    const serialized = stableStringify(args);
    return crypto.createHash('sha256').update(serialized).digest('hex');
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${parts.join(',')}}`;
}

function byteLength(value) {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function assertEventEnvelope(event) {
    if (!event || typeof event !== 'object') {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event must be an object');
    }
    if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
        fail(ERROR_CODES.PROTOCOL_VERSION_MISMATCH,
            `Unsupported event schemaVersion: ${event.schemaVersion}`,
            { expected: EVENT_SCHEMA_VERSION, actual: event.schemaVersion });
    }
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event requires eventId');
    }
    if (!Number.isInteger(event.sequence) || event.sequence < 1) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event requires positive integer sequence');
    }
    if (typeof event.sessionId !== 'string' || event.sessionId.length === 0) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event requires sessionId');
    }
    if (typeof event.timestamp !== 'string' || Number.isNaN(Date.parse(event.timestamp))) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event requires ISO timestamp');
    }
    if (typeof event.runtime !== 'string' || event.runtime.length === 0) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event requires runtime kind');
    }
    if (!EVENT_TYPE_SET.has(event.type)) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, `Unknown event type: ${event.type}`);
    }
    if (!('payload' in event)) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Event requires payload field');
    }
    if (byteLength(event.payload) > LIMITS.MAX_EVENT_PAYLOAD_BYTES) {
        fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Event payload exceeds limit', {
            limit: LIMITS.MAX_EVENT_PAYLOAD_BYTES,
        });
    }
    return event;
}

function assertPrompt(prompt) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        fail(ERROR_CODES.INVALID_EVENT_ENVELOPE, 'Prompt must be a non-empty string');
    }
    if (prompt.length > LIMITS.MAX_PROMPT_CHARS) {
        fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Prompt exceeds limit', {
            limit: LIMITS.MAX_PROMPT_CHARS,
        });
    }
    return prompt;
}

function assertToolName(toolName) {
    if (typeof toolName !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(toolName)) {
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, `Invalid tool name: ${String(toolName).slice(0, 64)}`);
    }
    return toolName;
}

function assertToolArguments(args) {
    if (args === undefined || args === null) {
        return {};
    }
    if (typeof args !== 'object' || Array.isArray(args)) {
        fail(ERROR_CODES.TOOL_PROTOCOL_VIOLATION, 'Tool arguments must be a plain object');
    }
    if (byteLength(args) > LIMITS.MAX_TOOL_ARGUMENT_BYTES) {
        fail(ERROR_CODES.PAYLOAD_TOO_LARGE, 'Tool arguments exceed limit', {
            limit: LIMITS.MAX_TOOL_ARGUMENT_BYTES,
        });
    }
    return args;
}

module.exports = {
    PROTOCOL_VERSION,
    EVENT_SCHEMA_VERSION,
    LIMITS,
    IPC_CHANNELS,
    WORKER_MESSAGE_TYPES,
    EVENT_TYPES,
    EVENT_TYPE_SET,
    RUNTIME_KINDS,
    LEGACY_TOOL_NAMES,
    newId,
    hashArguments,
    stableStringify,
    byteLength,
    assertEventEnvelope,
    assertPrompt,
    assertToolName,
    assertToolArguments,
};
