'use strict';

const {
    requireSessionId,
    sanitizedToolboxEndpoint,
    sessionConfigResult,
} = require('./runtime-normalizers');

const SENSITIVE_KEY = /(?:api.?key|authorization|bearer|secret|password|prompt|instruction|content|attachment|absolute.?path)/i;
const ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\|\/)/i;
const DIAGNOSTIC_CONFIG_FIELDS = Object.freeze([
    'instructionMode', 'baseInstructions', 'developerInstructions', 'personality',
    'model', 'reasoningEffort', 'workspaceRoot', 'permissionMode', 'executionProfile', 'provider',
]);

function boundedText(value, limit = 320) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safePath(value) {
    const pieces = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    return pieces.length ? `…/${boundedText(pieces.at(-1), 96)}` : '[redacted-path]';
}

function safeDetail(value, key = '', depth = 0) {
    if (SENSITIVE_KEY.test(key)) return '[redacted]';
    if (depth > 3) return '[truncated]';
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return ABSOLUTE_PATH.test(value.trim()) ? safePath(value) : boundedText(value);
    if (Array.isArray(value)) return value.slice(0, 12).map((entry) => safeDetail(entry, key, depth + 1));
    if (typeof value !== 'object') return boundedText(value);
    return Object.fromEntries(Object.entries(value).slice(0, 24)
        .map(([entryKey, entry]) => [boundedText(entryKey, 80), safeDetail(entry, entryKey, depth + 1)]));
}

function safeError(error, fallbackCode = 'RUNTIME_ERROR') {
    if (!error) return null;
    if (typeof error === 'string') return { code: fallbackCode, message: boundedText(error), details: null };
    return {
        code: boundedText(error.code || fallbackCode, 96),
        message: boundedText(error.message || error.error || String(error)),
        details: error.details ? safeDetail(error.details) : null,
    };
}

function diagnosticConfigValue(field, value) {
    if (field === 'baseInstructions' || field === 'developerInstructions') {
        const text = String(value || '');
        return { redactedType: 'instruction', configured: Boolean(text), length: text.length };
    }
    if (field === 'workspaceRoot') {
        const text = String(value || '').trim();
        return {
            redactedType: 'workspace',
            configured: Boolean(text),
            display: text ? safePath(text) : '',
        };
    }
    return typeof value === 'string' ? boundedText(value, 160) : value ?? null;
}

function diagnosticConfigSnapshot(config = {}) {
    return Object.fromEntries(DIAGNOSTIC_CONFIG_FIELDS
        .filter((field) => Object.prototype.hasOwnProperty.call(config, field))
        .map((field) => [field, diagnosticConfigValue(field, config[field])]));
}

function configDifferenceFields(desired = {}, applied = {}) {
    return DIAGNOSTIC_CONFIG_FIELDS.filter((field) => (
        JSON.stringify(desired?.[field] ?? null) !== JSON.stringify(applied?.[field] ?? null)
    ));
}

function diagnosticConfigState(session) {
    const state = sessionConfigResult(session);
    return {
        sessionId: state.sessionId,
        threadId: state.threadId,
        desiredConfig: diagnosticConfigSnapshot(state.desiredConfig),
        appliedRuntimeConfig: diagnosticConfigSnapshot(state.appliedRuntimeConfig),
        configDifferenceFields: configDifferenceFields(state.desiredConfig, state.appliedRuntimeConfig),
        configRevision: state.configRevision,
        appliedRuntimeConfigRevision: state.appliedRuntimeConfigRevision,
        applyState: state.applyState,
        applyError: safeError(state.applyError, 'SESSION_CONFIG_APPLY_ERROR'),
    };
}

function modelId(model) {
    if (typeof model === 'string') return model;
    return String(model?.id || model?.name || '').trim();
}

function requireSession(repository, sessionId) {
    const session = repository.getSession(sessionId);
    if (session) return session;
    const error = new Error('Agent Session was not found');
    error.code = 'NOT_FOUND';
    throw error;
}

function adapterSnapshot(context, session) {
    const adapter = context.responsesAdapter();
    if (!adapter?.getDiagnostics) {
        return { state: adapter ? 'ready' : 'not-started', activeRequestCount: 0, recentRequests: [] };
    }
    const threadId = String(session.threadId || '').trim();
    const snapshot = adapter.getDiagnostics({
        threadId: threadId || `unmaterialized:${session.sessionId}`,
    });
    if (!threadId) return { ...snapshot, activeRequestCount: 0, recentRequests: [] };
    return {
        ...snapshot,
        recentRequests: (snapshot.recentRequests || [])
            .filter((request) => !request.threadId || request.threadId === threadId)
            .map((request) => ({
                ...request,
                sessionId: session.sessionId,
                threadId,
            })),
    };
}

function runtimeSnapshot(context, repository, session) {
    const threadState = session.threadId ? context.threadStates().get(session.threadId) : null;
    const projection = repository.readProjection(session.sessionId)?.projection || null;
    return {
        state: context.state(),
        generation: context.runtimeGeneration(),
        protocol: 'codex-app-server-jsonl',
        lastError: safeError(context.lastError()),
        thread: {
            activity: threadState?.activity || session.state || 'idle',
            observedStatus: threadState?.observedThreadStatus || null,
            activeTurnId: threadState?.activeTurnId || null,
            recoveryState: threadState?.recoveryState || 'confirmed',
        },
        storage: {
            schemaVersion: Number(repository.schemaVersion || 0),
            readOnly: repository.readOnly === true,
            error: safeError(repository.degradedReason, 'PROJECTION_READ_ONLY'),
        },
        projection: {
            lastReconciledAt: projection?.lastReconciledAt || null,
            error: safeError(projection?.lastError, 'PROJECTION_RECONCILE_ERROR'),
        },
    };
}

function toolboxSnapshot(context, settings, session) {
    return {
        configured: Boolean(settings.vcpServerUrl && settings.vcpApiKey),
        endpoint: sanitizedToolboxEndpoint(settings.vcpServerUrl),
        adapter: adapterSnapshot(context, session),
    };
}

function modelCatalogSnapshot(context, session) {
    const models = (context.getModels() || []).map(modelId).filter(Boolean);
    const selectedModel = String(session.configSnapshot?.model || '').trim();
    return {
        cachedCount: models.length,
        selectedModel: selectedModel || null,
        selectedModelAvailable: selectedModel ? models.includes(selectedModel) : null,
    };
}

function applyBarrierSnapshot(context, session) {
    const target = session.threadId ? context.configApplyTargets().get(session.threadId) : null;
    const settings = target?.settings || null;
    return {
        waiting: Boolean(target),
        revision: Number(target?.revision || 0),
        runtimeGeneration: Number(target?.runtimeGeneration || 0),
        fields: settings ? Object.entries(settings)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([field]) => field).sort() : [],
    };
}

class RuntimeDiagnosticsService {
    constructor(context) {
        this.context = Object.freeze(context);
    }

    readSessionDiagnostics({ sessionId } = {}) {
        const id = requireSessionId(sessionId);
        this.context.ensureProjectionStore();
        const repository = this.context.repository();
        const session = requireSession(repository, id);
        const settings = this.context.getSettings() || {};
        return {
            schemaVersion: 1,
            ...diagnosticConfigState(session),
            runtime: runtimeSnapshot(this.context, repository, session),
            toolbox: toolboxSnapshot(this.context, settings, session),
            modelCatalog: modelCatalogSnapshot(this.context, session),
            applyBarrier: applyBarrierSnapshot(this.context, session),
        };
    }
}

module.exports = { RuntimeDiagnosticsService, safeDiagnosticError: safeError };
