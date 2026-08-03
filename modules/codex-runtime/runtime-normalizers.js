'use strict';

const crypto = require('crypto');
const path = require('path');
const { CodexAppServerError } = require('./appServerTransport');

function submissionDedupeKey(prompt, attachments = []) {
    const descriptors = (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
        attachmentId: attachment?.attachmentId || null,
        displayName: attachment?.displayName || null,
        byteLen: Number(attachment?.byteLen) || 0,
        kind: attachment?.kind || null,
    }));
    return crypto.createHash('sha256')
        .update(JSON.stringify({ prompt: String(prompt || '').trim(), attachments: descriptors }))
        .digest('hex');
}

function explicitAgent(value) {
    const result = String(value || '').trim();
    return result || null;
}

function sameIdentity(left, right) {
    const a = String(left || '').trim().toLocaleLowerCase();
    const b = String(right || '').trim().toLocaleLowerCase();
    return Boolean(a && b && a === b);
}

function requireSessionId(sessionId, { required = true } = {}) {
    const resolved = String(sessionId || '').trim();
    if (required && !resolved) throw new CodexAppServerError('INVALID_INPUT', 'sessionId is required');
    return resolved || null;
}

const INSTRUCTION_MODES = new Set(['vchat-identity', 'codex-managed']);
const PERSONALITIES = new Set(['none', 'friendly', 'pragmatic']);

function normalizeInstructionMode(value, baseInstructions = '') {
    const mode = String(value || '').trim();
    if (INSTRUCTION_MODES.has(mode)) return mode;
    return String(baseInstructions || '').trim() ? 'vchat-identity' : 'codex-managed';
}

function normalizePersonality(value) {
    const personality = String(value || '').trim();
    return PERSONALITIES.has(personality) ? personality : 'none';
}

function normalizeReasoningEffort(value) {
    const effort = String(value || '').trim();
    return effort && effort !== 'default' ? effort : null;
}

function reasoningEffortsFromModel(model) {
    if (!model || typeof model !== 'object') return [];
    const candidates = [
        model.reasoningEfforts, model.reasoning_efforts,
        model.supportedReasoningEfforts, model.supported_reasoning_efforts,
        model.capabilities?.reasoningEfforts, model.capabilities?.reasoning_efforts,
        model.metadata?.reasoningEfforts, model.metadata?.reasoning_efforts,
    ];
    const source = candidates.find(Array.isArray);
    return source ? [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))] : [];
}

function vcpInvokeTool() {
    return {
        type: 'function',
        name: 'vcp_invoke',
        description: 'Invoke one named VCPToolBox capability through the VCP bridge. '
            + '`tool` is the exact catalog capability name. `arguments` is forwarded losslessly to that capability: '
            + 'include every target-specific field exactly as documented, and use an empty object only when the target truly takes no arguments. '
            + 'Do not replace this call with a native filesystem, shell, web, or MCP tool.',
        inputSchema: {
            type: 'object',
            properties: {
                tool: { type: 'string', description: 'Exact ToolBox catalog capability name.' },
                arguments: {
                    type: 'object',
                    description: 'Complete target-specific argument object. Preserve all documented field names and values.',
                    additionalProperties: true,
                },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
        },
    };
}

const MAX_DYNAMIC_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const TOOLBOX_TARGET_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function decodeVcpInvokeCall(params) {
    if (!isPlainObject(params)) throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'params must be an object');
    for (const field of ['threadId', 'turnId', 'callId']) {
        if (!String(params[field] || '').trim()) {
            throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', `${field} is required`);
        }
    }
    const wrapperToolName = String(params.tool || '').trim();
    if (wrapperToolName !== 'vcp_invoke') {
        throw new CodexAppServerError('UNSUPPORTED_DYNAMIC_TOOL', `unsupported dynamic tool: ${wrapperToolName || '(empty)'}`);
    }
    if (!isPlainObject(params.arguments)) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments must be an object');
    }
    const targetToolName = String(params.arguments.tool || '').trim();
    if (!TOOLBOX_TARGET_NAME.test(targetToolName)) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.tool is not a valid ToolBox target name');
    }
    const targetArguments = params.arguments.arguments;
    if (!isPlainObject(targetArguments)) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.arguments must be an object');
    }
    let serialized;
    try {
        serialized = JSON.stringify(targetArguments);
    } catch (_error) {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.arguments must be JSON serializable');
    }
    if (typeof serialized !== 'string') {
        throw new CodexAppServerError('INVALID_DYNAMIC_TOOL_CALL', 'vcp_invoke arguments.arguments must serialize to JSON');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DYNAMIC_TOOL_ARGUMENT_BYTES) {
        throw new CodexAppServerError('DYNAMIC_TOOL_ARGUMENTS_TOO_LARGE', 'vcp_invoke arguments exceed 1 MiB');
    }
    return { wrapperToolName, targetToolName, targetArguments };
}

function serializeError(error) {
    return {
        code: error?.code || 'RUNTIME_ERROR',
        message: error?.message || String(error),
        details: error?.details || null,
    };
}

function isConfirmedThreadNotFound(error) {
    const message = String(error?.message || '');
    return /(?:no rollout found|thread\s+(?:was\s+)?not found|unknown thread|thread id .* not found)/i.test(message);
}

function hasDurableProjection(projection) {
    return Array.isArray(projection?.messages) && projection.messages.length > 0;
}

function hasToolboxConfiguration(settings) {
    return Boolean(String(settings?.vcpServerUrl || '').trim() && String(settings?.vcpApiKey || '').trim());
}

function toolboxConfigFingerprint(settings) {
    const url = String(settings?.vcpServerUrl || '').trim();
    const key = String(settings?.vcpApiKey || '');
    return crypto.createHash('sha256').update(`${url}\u0000${key}`).digest('hex');
}

function safeAvatarFile(value) {
    const file = String(value || '').trim();
    if (!file || path.basename(file) !== file || !/^avatar-r\d+\.(?:png|jpe?g|gif|webp)$/i.test(file)) return '';
    return file;
}

function sessionProjection(session) {
    return { ...session, model: session.configSnapshot?.model || null, runtime: 'codex' };
}

function sessionConfigResult(session) {
    return {
        sessionId: session.sessionId,
        threadId: session.threadId || null,
        desiredConfig: session.configSnapshot || {},
        appliedRuntimeConfig: session.appliedRuntimeConfig || {},
        configRevision: Number(session.configRevision || 1),
        appliedRuntimeConfigRevision: Number(session.appliedRuntimeConfigRevision || 0),
        applyState: session.configApplyState || (session.threadId ? 'pending' : 'unmaterialized'),
        applyError: session.configApplyError || null,
    };
}

function pendingInputProjection(input) {
    return {
        interactionId: input.inputId,
        inputId: input.inputId,
        sessionId: input.sessionId,
        kind: 'follow-up',
        prompt: input.prompt,
        state: input.state,
        clientUserMessageId: input.clientMessageId,
        turnId: input.turnId || null,
        attempt: Number(input.attemptCount || 0),
        error: input.lastError || null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
    };
}

function runtimeProjection(session, state = {}) {
    return {
        sessionId: session.sessionId,
        threadId: session.threadId,
        agentId: session.agentId,
        title: session.title,
        model: session.configSnapshot?.model || null,
        configSnapshot: session.configSnapshot || {},
        workspaceRoot: session.workspaceRoot,
        activity: state?.activity || (session.state === 'running' ? 'running' : 'idle'),
        activeTurnId: state?.activeTurnId || null,
        runtime: 'codex',
    };
}

function buildTurnInput(text, attachments) {
    const input = [];
    if (text) input.push({ type: 'text', text, text_elements: [] });
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
        const filePath = String(attachment?.path || '').trim();
        const url = String(attachment?.url || '').trim();
        const kind = attachment?.kind;
        if (kind === 'image' && filePath) input.push({ type: 'localImage', path: filePath });
        else if (kind === 'image' && url) input.push({ type: 'image', url });
        else if (kind === 'audio' && filePath) input.push({ type: 'localAudio', path: filePath });
        else if (kind === 'audio' && url) input.push({ type: 'audio', url });
        else if (filePath) input.push({ type: 'mention', name: path.basename(filePath), path: filePath });
    }
    return input;
}

function notificationItemId(message) {
    return message?.params?.itemId || message?.params?.item?.id || null;
}

function approvalProjection(requestId, request, repository) {
    const params = request?.params || {};
    const session = params.threadId ? repository?.getSessionByThread(params.threadId) : null;
    return {
        approvalId: String(requestId),
        requestId: String(requestId),
        scope: 'codex-native',
        method: request?.method || '',
        sessionId: session?.sessionId || null,
        threadId: params.threadId || null,
        turnId: params.turnId || null,
        toolCallId: params.itemId || params.callId || null,
        reason: params.reason || null,
        command: params.command || null,
        cwd: params.cwd || null,
        params,
        generation: Number(request?.runtimeGeneration || 0),
    };
}

function approvalEvent(requestId, request, repository) {
    const approval = approvalProjection(requestId, request, repository);
    return {
        type: 'approval.requested',
        sessionId: approval.sessionId,
        turnId: approval.turnId,
        toolCallId: approval.toolCallId,
        payload: { approval },
    };
}

function normalizeApprovalDecision(decision) {
    if (decision && typeof decision === 'object' && 'decision' in decision) return decision.decision;
    const value = String(decision || '').trim();
    if (['accept', 'acceptForSession', 'decline', 'cancel'].includes(value)) return value;
    if (['allow', 'approve', 'approved', 'yes'].includes(value)) return 'accept';
    if (['always-allow', 'allow-session'].includes(value)) return 'acceptForSession';
    if (['cancelled', 'interrupt'].includes(value)) return 'cancel';
    return 'decline';
}

function isUncertainRemoteMutation(error) {
    return ['REQUEST_TIMEOUT', 'PROCESS_EXITED', 'STOPPED', 'NOT_RUNNING', 'RUNTIME_CRASHED', 'STALE_GENERATION']
        .includes(String(error?.code || ''));
}

function normalizeApprovalPolicy(value) {
    const policy = String(value || '').trim();
    if (['untrusted', 'on-failure', 'on-request', 'never'].includes(policy)) return policy;
    if (['always-approve', 'alwaysApprove'].includes(policy)) return 'never';
    return 'on-request';
}

function normalizePermissionMode(value) {
    const mode = String(value || '').trim();
    if (mode === 'always-approve' || mode === 'alwaysApprove' || mode === 'never') return 'always-approve';
    return 'ask';
}

function normalizeSandboxMode(value) {
    const mode = String(value || '').trim();
    if (['read-only', 'workspace-write', 'danger-full-access'].includes(mode)) return mode;
    if (mode === 'readOnly') return 'read-only';
    if (mode === 'dangerFullAccess') return 'danger-full-access';
    return 'workspace-write';
}

function approvalResponse(method, decision) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        return { decision: normalizeApprovalDecision(decision) };
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') {
        const normalized = normalizeApprovalDecision(decision);
        return { decision: normalized === 'accept' || normalized === 'acceptForSession' ? 'approved' : 'abort' };
    }
    return failClosedApprovalResponse(method);
}

function failClosedApprovalResponse(method) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        return { decision: 'decline' };
    }
    if (method === 'applyPatchApproval' || method === 'execCommandApproval') return { decision: 'abort' };
    return null;
}

function interactionExpiry(message) {
    const autoResolutionMs = Number(message?.params?.autoResolutionMs);
    if (!Number.isFinite(autoResolutionMs) || autoResolutionMs <= 0) return null;
    return Date.now() + Math.min(15 * 60 * 1000, Math.max(1_000, autoResolutionMs));
}

function sanitizeInteractionPayload(value, depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 16_384);
    if (depth >= 6) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitizeInteractionPayload(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 16_384);
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 128)) {
        result[key] = /token|secret|password|api.?key|authorization/i.test(key)
            ? '[redacted]'
            : sanitizeInteractionPayload(child, depth + 1);
    }
    return result;
}

function normalizeInteractionResponse(request, response) {
    const method = request?.method;
    const params = request?.params || {};
    if (method === 'item/tool/requestUserInput') {
        const questions = Array.isArray(params.questions) ? params.questions : [];
        const submitted = response?.answers && typeof response.answers === 'object' ? response.answers : {};
        const answers = {};
        for (const question of questions.slice(0, 16)) {
            const id = String(question?.id || '').trim();
            if (!id) continue;
            const raw = submitted[id]?.answers ?? submitted[id] ?? [];
            const values = (Array.isArray(raw) ? raw : [raw])
                .map((value) => String(value ?? '').slice(0, 16_384))
                .filter((value) => value.length > 0)
                .slice(0, 8);
            if (values.length) answers[id] = { answers: values };
        }
        return { answers };
    }
    if (method === 'item/permissions/requestApproval') {
        if (response?.decision !== 'accept') return { permissions: {}, scope: 'turn' };
        const requested = params.permissions && typeof params.permissions === 'object' ? params.permissions : {};
        const permissions = {};
        if (requested.network) permissions.network = sanitizeInteractionPayload(requested.network);
        if (requested.fileSystem) permissions.fileSystem = sanitizeInteractionPayload(requested.fileSystem);
        return {
            permissions,
            scope: response?.scope === 'session' ? 'session' : 'turn',
            strictAutoReview: response?.strictAutoReview === true ? true : undefined,
        };
    }
    if (method === 'mcpServer/elicitation/request') {
        const action = ['accept', 'decline', 'cancel'].includes(response?.action) ? response.action : 'cancel';
        const content = action === 'accept' && params.mode !== 'url' && response?.content && typeof response.content === 'object'
            ? validateMcpElicitationContent(params.requestedSchema, response.content)
            : null;
        return { action, content, _meta: null };
    }
    throw new CodexAppServerError('UNSUPPORTED_INTERACTION', `Unsupported Codex interaction: ${method || '(empty)'}`);
}

function validateMcpElicitationContent(schema, input) {
    if (!schema || typeof schema !== 'object' || !schema.properties || typeof schema.properties !== 'object') {
        return sanitizeInteractionPayload(input);
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    const content = {};
    for (const [key, definition] of Object.entries(schema.properties).slice(0, 64)) {
        if (!(key in input)) {
            if (required.has(key)) throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `Missing required MCP field: ${key}`);
            continue;
        }
        const value = input[key];
        const type = Array.isArray(definition?.type) ? definition.type[0] : definition?.type;
        if (type === 'boolean' && typeof value !== 'boolean') throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `MCP field ${key} must be boolean`);
        if ((type === 'number' || type === 'integer') && !Number.isFinite(Number(value))) {
            throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `MCP field ${key} must be numeric`);
        }
        if (Array.isArray(definition?.enum) && !definition.enum.includes(value)) {
            throw new CodexAppServerError('INVALID_INTERACTION_RESPONSE', `MCP field ${key} is outside the allowed values`);
        }
        content[key] = sanitizeInteractionPayload(value);
    }
    return content;
}

function bridgeResultContentItems(result) {
    const items = [];
    const text = result.output || result.error || result.message;
    if (text) items.push({ type: 'inputText', text: String(text) });
    for (const resource of Array.isArray(result.resources) ? result.resources : []) {
        const url = String(resource?.url || resource?.imageUrl || resource?.audioUrl || '').trim();
        if (!url) continue;
        if (resource.type === 'audio' || resource.mimeType?.startsWith('audio/')) items.push({ type: 'inputAudio', audioUrl: url });
        else if (resource.type === 'image' || resource.mimeType?.startsWith('image/')) items.push({ type: 'inputImage', imageUrl: url });
    }
    if (!items.length) items.push({ type: 'inputText', text: JSON.stringify(result) });
    return items;
}

function classifyToolboxEvent(channel, value) {
    if (channel === 'info') {
        const type = String(value?.type || value?.data?.type || value?.kind || '').trim();
        if (/RAG_RETRIEVAL_DETAILS/i.test(type)) return 'rag-retrieval';
        if (/META_THINKING_CHAIN/i.test(type)) return 'meta-thinking';
        if (/AI_MEMO_RETRIEVAL/i.test(type)) return 'memory';
        if (/AGENT_PRIVATE_CHAT_PREVIEW/i.test(type)) return 'private-chat-preview';
        if (/DailyNote/i.test(type)) return 'daily-note';
        if (/AGENT_DREAM_/i.test(type)) return 'dream';
        return 'notification';
    }
    if (channel === 'log') return 'log';
    if (channel?.endsWith('-status')) return 'connection-status';
    return 'notification';
}

function sanitizeToolboxValue(value, depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return value.slice(0, 16_384);
    if (depth >= 5) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeToolboxValue(item, depth + 1));
    if (typeof value !== 'object') return String(value).slice(0, 16_384);
    const result = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
        result[key] = /api[-_]?key|authorization|cookie|secret|token/i.test(key)
            ? '[redacted]'
            : sanitizeToolboxValue(child, depth + 1);
    }
    return result;
}

module.exports = {
    approvalEvent,
    approvalProjection,
    approvalResponse,
    bridgeResultContentItems,
    buildTurnInput,
    classifyToolboxEvent,
    runtimeProjection,
    sessionProjection,
    decodeVcpInvokeCall,
    explicitAgent,
    hasDurableProjection,
    hasToolboxConfiguration,
    interactionExpiry,
    isConfirmedThreadNotFound,
    isUncertainRemoteMutation,
    normalizeApprovalDecision,
    normalizeApprovalPolicy,
    normalizeInteractionResponse,
    normalizeInstructionMode,
    normalizePersonality,
    normalizePermissionMode,
    normalizeReasoningEffort,
    normalizeSandboxMode,
    notificationItemId,
    pendingInputProjection,
    reasoningEffortsFromModel,
    requireSessionId,
    safeAvatarFile,
    sanitizeInteractionPayload,
    sanitizeToolboxValue,
    serializeError,
    sessionConfigResult,
    sameIdentity,
    submissionDedupeKey,
    toolboxConfigFingerprint,
    vcpInvokeTool,
};
