'use strict';

const fs = require('fs');
const path = require('path');
const { CodexAppServerError } = require('./appServerTransport');
const { normalizeSessionConfig } = require('./dataContracts');
const {
    normalizeApprovalPolicy,
    normalizeInstructionMode,
    normalizePermissionMode,
    normalizePersonality,
    normalizeReasoningEffort,
    requireSessionId,
    sessionProjection,
    serializeError,
    sessionConfigResult,
} = require('./runtime-normalizers');
const {
    hasConfigField,
    normalizeConfigField,
} = require('../agent-config-descriptors.js');

function normalizeApproval(permissionMode, approvalPolicy) {
    if (permissionMode === 'always-approve' || approvalPolicy === 'never') return 'never';
    return 'on-request';
}

function instructionShape(config = {}) {
    return {
        instructionMode: config.instructionMode || 'vchat-identity',
        baseInstructions: String(config.baseInstructions || ''),
        developerInstructions: String(config.developerInstructions || ''),
    };
}

function instructionConfigChanged(desired = {}, applied = {}) {
    return JSON.stringify(instructionShape(desired)) !== JSON.stringify(instructionShape(applied));
}

function requiresFreshCodexManagedSession(desired = {}, applied = {}) {
    return applied.instructionMode !== 'codex-managed'
        && desired.instructionMode === 'codex-managed'
        && Boolean(String(applied.baseInstructions || '').trim());
}

function threadSettingsPatch(session, desired = {}) {
    return {
        threadId: session.threadId,
        cwd: session.workspaceRoot || undefined,
        model: desired.model || undefined,
        approvalPolicy: normalizeApproval(desired.permissionMode, desired.approvalPolicy),
        ...(desired.reasoningEffort ? { effort: desired.reasoningEffort } : {}),
        ...(desired.instructionMode === 'codex-managed' && desired.personality && desired.personality !== 'none'
            ? { personality: desired.personality } : {}),
    };
}

function runtimeSettingsTarget(session, config = {}) {
    return {
        cwd: config.workspaceRoot || session.workspaceRoot || undefined,
        model: config.model || undefined,
        approvalPolicy: normalizeApproval(config.permissionMode, config.approvalPolicy),
        effort: config.reasoningEffort || null,
        personality: config.instructionMode === 'codex-managed'
            && config.personality && config.personality !== 'none' ? config.personality : null,
    };
}

function sameRuntimeSettings(left = {}, right = {}) {
    return ['cwd', 'model', 'approvalPolicy', 'effort', 'personality']
        .every((field) => (left[field] ?? null) === (right[field] ?? null));
}

function resolveRequestedWorkspace(context, settings, hasWorkspaceUpdate) {
    if (!hasWorkspaceUpdate) return null;
    const requested = path.resolve(String(settings.workspaceRoot || '').trim() || context.projectRoot());
    let workspaceStat = null;
    try { workspaceStat = fs.statSync(requested); } catch { /* validated below */ }
    if (!workspaceStat?.isDirectory()) {
        throw new CodexAppServerError('INVALID_WORKSPACE', 'Workspace directory does not exist');
    }
    return requested;
}

function settingsMutationRequest(context, settings) {
    const hasPermissionUpdate = hasConfigField(settings, 'permissionMode');
    const hasReasoningUpdate = hasConfigField(settings, 'reasoningEffort');
    const hasSystemPromptUpdate = Object.prototype.hasOwnProperty.call(settings, 'systemPrompt');
    const hasBaseInstructionsUpdate = hasConfigField(settings, 'baseInstructions');
    const hasWorkspaceUpdate = hasConfigField(settings, 'workspaceRoot');
    return {
        settings,
        sessionId: String(settings.sessionId || '').trim(),
        hasPermissionUpdate,
        permissionMode: hasPermissionUpdate
            ? normalizeConfigField('permissionMode', settings.permissionMode).value : null,
        requestedModel: hasConfigField(settings, 'model')
            ? normalizeConfigField('model', settings.model).value || null : null,
        hasReasoningUpdate,
        hasInstructionModeUpdate: hasConfigField(settings, 'instructionMode'),
        hasDeveloperInstructionsUpdate: Object.prototype.hasOwnProperty.call(settings, 'developerInstructions'),
        hasPersonalityUpdate: Object.prototype.hasOwnProperty.call(settings, 'personality'),
        hasPromptUpdate: hasSystemPromptUpdate || hasBaseInstructionsUpdate,
        requestedSystemPrompt: (hasSystemPromptUpdate || hasBaseInstructionsUpdate)
            ? normalizeConfigField('baseInstructions', settings.baseInstructions ?? settings.systemPrompt).value : null,
        hasWorkspaceUpdate,
        requestedWorkspaceRoot: resolveRequestedWorkspace(context, settings, hasWorkspaceUpdate),
    };
}

function requestedSessionConfig(current, request) {
    const currentConfig = current.configSnapshot || {};
    const instructionMode = request.hasInstructionModeUpdate
        ? normalizeInstructionMode(request.settings.instructionMode, request.requestedSystemPrompt)
        : normalizeInstructionMode(currentConfig.instructionMode, currentConfig.baseInstructions);
    return {
        ...currentConfig,
        instructionMode,
        baseInstructions: request.hasPromptUpdate
            ? request.requestedSystemPrompt : String(currentConfig.baseInstructions || ''),
        developerInstructions: request.hasDeveloperInstructionsUpdate
            ? String(request.settings.developerInstructions || '').trim()
            : String(currentConfig.developerInstructions || ''),
        personality: request.hasPersonalityUpdate
            ? normalizePersonality(request.settings.personality)
            : normalizePersonality(currentConfig.personality),
    };
}

function requireExpectedConfigRevision(settings) {
    const expected = Number(settings.expectedConfigRevision);
    if (!Number.isInteger(expected) || expected < 1) {
        throw new CodexAppServerError(
            'SESSION_CONFIG_REVISION_REQUIRED', 'Session settings require expectedConfigRevision',
        );
    }
    return expected;
}

function configUpdateResult(defaults, session, request) {
    const permissionMode = session
        ? normalizePermissionMode(session.configSnapshot?.permissionMode || session.configSnapshot?.approvalPolicy)
        : (request.permissionMode || defaults.permissionMode);
    const model = session?.configSnapshot?.model || request.requestedModel || defaults.model || null;
    return {
        ...defaults,
        settings: {
            permissionMode,
            ...(model ? { model } : {}),
            reasoningEffort: normalizeReasoningEffort(session?.configSnapshot?.reasoningEffort),
        },
        session: session ? sessionProjection(session) : null,
        desiredConfig: session?.configSnapshot || null,
        appliedRuntimeConfig: session?.appliedRuntimeConfig || null,
        configRevision: session?.configRevision || null,
        appliedRuntimeConfigRevision: session?.appliedRuntimeConfigRevision || 0,
        applyState: session?.configApplyState || null,
        applyError: session?.configApplyError || null,
        appliesTo: session ? 'next-turn' : 'new-sessions',
    };
}

class RuntimeConfigService {
    constructor(context) {
        this.context = Object.freeze(context);
        this.scheduledApplies = new Map();
    }

    _repository(generation) {
        if (generation) this.context.assertGeneration(generation);
        const repository = this.context.repository();
        if (!repository) throw new CodexAppServerError('RUNTIME_STOPPED', 'Agent projection store is closed');
        return repository;
    }

    _operation(identity = {}) { return this.context.createOperationContext(identity); }
    _operationRepository(operation) {
        this.context.assertOperationContext(operation);
        return this._repository(operation.generation);
    }

    getWorkbenchSettings() {
        const settings = this.context.getSettings() || {};
        return {
            runtime: 'codex-app-server',
            driver: 'codex',
            permissionMode: normalizePermissionMode(
                settings.agentRuntime?.codex?.permissionMode || settings.agentRuntime?.codex?.approvalPolicy,
            ),
            model: settings.agentRuntime?.codex?.model || settings.agentRuntime?.tui?.defaultModel || null,
        };
    }

    async updateWorkbenchSettings(settings = {}) {
        this.context.ensureProjectionStore();
        this.context.assertProjectionWritable();
        const request = settingsMutationRequest(this.context, settings);
        const session = request.sessionId
            ? await this._updateSessionSettings(request)
            : await this._updateGlobalSettings(request);
        if (session?.createdDerivedSession) return session;
        return configUpdateResult(this.getWorkbenchSettings(), session, request);
    }

    async _updateGlobalSettings(request) {
        const setSettings = this.context.setSettings();
        if ((!request.requestedModel && !request.hasPermissionUpdate) || !setSettings) return null;
        await setSettings((current) => ({
            ...current,
            agentRuntime: {
                ...(current?.agentRuntime || {}),
                codex: {
                    ...(current?.agentRuntime?.codex || {}),
                    ...(request.requestedModel ? { model: request.requestedModel } : {}),
                    ...(request.hasPermissionUpdate ? { permissionMode: request.permissionMode } : {}),
                },
            },
        }));
        return null;
    }

    async _updateSessionSettings(request) {
        const repository = this.context.repository();
        const current = repository.getSession(request.sessionId);
        if (!current) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        const expectedRevision = requireExpectedConfigRevision(request.settings);
        const requestedConfig = requestedSessionConfig(current, request);
        const derived = await this._deriveSessionIfRequired(current, requestedConfig, request);
        if (derived) return derived;
        if (requestedConfig.instructionMode === 'vchat-identity' && !requestedConfig.baseInstructions) {
            throw new CodexAppServerError('AGENT_IDENTITY_MISSING', 'VChat identity mode requires baseInstructions');
        }
        const currentPermissionMode = normalizePermissionMode(
            current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
        );
        const permissionMode = request.permissionMode || currentPermissionMode;
        const model = request.requestedModel || current.configSnapshot?.model || '';
        const reasoning = request.hasReasoningUpdate
            ? this.context.validateReasoningEffort(model, request.settings.reasoningEffort)
            : {
                effort: normalizeReasoningEffort(current.configSnapshot?.reasoningEffort),
                supported: Array.isArray(current.configSnapshot?.reasoningEfforts)
                    ? current.configSnapshot.reasoningEfforts : this.context.reasoningEffortsForModel(model),
            };
        const updated = repository.updateSessionConfig(request.sessionId, expectedRevision, {
            workspaceRoot: request.hasWorkspaceUpdate ? request.requestedWorkspaceRoot : current.workspaceRoot,
            configSnapshot: {
                ...requestedConfig,
                permissionMode,
                approvalPolicy: normalizeApprovalPolicy(permissionMode),
                ...(request.requestedModel ? { model: request.requestedModel } : {}),
                reasoningEffort: reasoning.effort,
                reasoningEfforts: reasoning.supported,
            },
        });
        if (!updated.updated) {
            throw new CodexAppServerError('SESSION_CONFIG_CONFLICT', 'Session settings changed in another view', {
                current: updated.session,
            });
        }
        this.sendSessionConfigEvent('session.config.saved', updated.session);
        this.scheduleApply(updated.session.sessionId);
        return updated.session;
    }

    async _deriveSessionIfRequired(current, requestedConfig, request) {
        if (!current.threadId || !requiresFreshCodexManagedSession(
            requestedConfig, current.appliedRuntimeConfig || current.configSnapshot || {},
        )) return null;
        if (request.settings.createDerivedSession !== true) {
            throw new CodexAppServerError(
                'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                'Codex 0.146 cannot clear persisted baseInstructions on this Thread; create a derived Session',
                { requiresDerivedSession: true, requestedConfig },
            );
        }
        const permissionMode = request.permissionMode || normalizePermissionMode(
            current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
        );
        const derived = await this.context.createSession({
            ...current.configSnapshot,
            ...requestedConfig,
            agentId: current.agentId,
            title: `${current.title || 'Agent Session'} (Codex managed)`,
            workspaceRoot: request.hasWorkspaceUpdate ? request.requestedWorkspaceRoot : current.workspaceRoot,
            permissionMode,
            approvalPolicy: normalizeApprovalPolicy(permissionMode),
            ...(request.requestedModel ? { model: request.requestedModel } : {}),
        });
        return {
            ...this.getWorkbenchSettings(),
            settings: {
                permissionMode,
                model: derived.configSnapshot?.model || null,
                reasoningEffort: normalizeReasoningEffort(derived.configSnapshot?.reasoningEffort),
            },
            session: sessionProjection(derived),
            ...sessionConfigResult(derived),
            appliesTo: 'derived-session',
            createdDerivedSession: true,
            sourceSessionId: current.sessionId,
        };
    }

    updateSessionConfig({ sessionId, expectedConfigRevision, patch } = {}) {
        const resolvedSessionId = requireSessionId(sessionId);
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new CodexAppServerError('INVALID_INPUT', 'Session config patch must be an object');
        }
        const allowedFields = new Set([
            'instructionMode', 'baseInstructions', 'systemPrompt', 'developerInstructions', 'personality',
            'model', 'reasoningEffort', 'workspaceRoot', 'permissionMode', 'createDerivedSession',
        ]);
        const unknownFields = Object.keys(patch).filter((field) => !allowedFields.has(field));
        if (unknownFields.length) {
            throw new CodexAppServerError(
                'INVALID_INPUT', `Unsupported Session config fields: ${unknownFields.join(', ')}`,
            );
        }
        return this.updateWorkbenchSettings({ ...patch, sessionId: resolvedSessionId, expectedConfigRevision });
    }

    readSessionConfig({ sessionId } = {}) {
        this.context.ensureProjectionStore();
        const session = this.context.repository().getSession(String(sessionId || '').trim());
        if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
        return sessionConfigResult(session);
    }

    sendSessionConfigEvent(type, session, error = null) {
        if (!session) return;
        this.context.sendUiEvent({
            type,
            sessionId: session.sessionId,
            threadId: session.threadId || null,
            payload: { ...sessionConfigResult(session), ...(error ? { error: String(error) } : {}) },
        });
    }

    scheduleApply(sessionId) {
        const idValue = String(sessionId || '').trim();
        const existing = this.scheduledApplies.get(idValue);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.scheduledApplies.delete(idValue);
            void this.applySessionRuntimeConfig(sessionId).catch((error) => {
                this.context.setLastError(serializeError(error));
            });
        }, 0);
        timer.unref?.();
        this.scheduledApplies.set(idValue, timer);
    }

    clearScheduledApplies() {
        for (const timer of this.scheduledApplies.values()) clearTimeout(timer);
        this.scheduledApplies.clear();
    }

    _assertApplicableInstructionMode(repository, session, desired, applied) {
        if (!requiresFreshCodexManagedSession(desired, applied)) return;
        const error = new CodexAppServerError(
            'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
            'Codex-managed instructions require a derived Session for this Thread',
        );
        const failed = repository.markSessionConfigFailed(
            session.sessionId, session.configRevision, error.message,
        );
        this.sendSessionConfigEvent('session.config.failed', failed, error.message);
        throw error;
    }

    async _recoverConfirmationTimeout({ error, operation, session, sessionId }) {
        if (error?.code !== 'SESSION_CONFIG_CONFIRMATION_TIMEOUT') return null;
        if (this.context.threadStates().get(session.threadId)?.activity !== 'idle') return null;
        let repository = this._operationRepository(operation);
        const current = repository.getSession(sessionId);
        if (!current || current.configRevision !== session.configRevision) {
            throw new CodexAppServerError(
                'SESSION_CONFIG_CONFLICT', 'Session config changed during Runtime confirmation recovery',
            );
        }
        await this.context.transport().request('thread/unsubscribe', { threadId: session.threadId });
        repository = this._operationRepository(operation);
        this.context.resumedThreadIds().delete(session.threadId);
        const rebound = await this.context.resumeSession(repository.getSession(sessionId));
        return rebound?.appliedRuntimeConfigRevision === session.configRevision ? rebound : null;
    }

    async _requestSettingsUpdate({ barrier, desired, operation, session, sessionId, targetSettings }) {
        let resolveConfirmation;
        let rejectConfirmation;
        const confirmation = barrier ? new Promise((resolve, reject) => {
            resolveConfirmation = resolve;
            rejectConfirmation = reject;
        }) : null;
        const timeout = setTimeout(() => {
            const target = this.context.configApplyTargets().get(session.threadId);
            if (target?.revision !== session.configRevision) return;
            this.context.configApplyTargets().delete(session.threadId);
            const error = new CodexAppServerError(
                'SESSION_CONFIG_CONFIRMATION_TIMEOUT', 'Codex did not confirm the requested Thread settings',
            );
            if (rejectConfirmation) rejectConfirmation(error);
            else {
                const failed = this.context.repository()?.markSessionConfigFailed(
                    sessionId, session.configRevision, error.message,
                );
                if (failed) this.sendSessionConfigEvent('session.config.failed', failed, error.message);
            }
        }, this.context.configApplyConfirmationTimeoutMs?.() || 5_000);
        timeout.unref?.();
        this.context.configApplyTargets().set(session.threadId, {
            sessionId,
            revision: session.configRevision,
            snapshot: desired,
            settings: targetSettings,
            runtimeGeneration: this.context.runtimeGeneration(),
            resolve: resolveConfirmation,
            reject: rejectConfirmation,
            timeout,
        });
        await this.context.transport().request('thread/settings/update', threadSettingsPatch(session, desired));
        if (!confirmation) return null;
        try {
            await confirmation;
            return null;
        } catch (error) {
            const rebound = await this._recoverConfirmationTimeout({ error, operation, session, sessionId });
            if (!rebound) throw error;
            return rebound;
        }
    }

    async applySessionRuntimeConfig(sessionId, { barrier = false } = {}) {
        const idValue = String(sessionId || '').trim();
        const applyPromises = this.context.configApplyPromises();
        if (applyPromises.has(idValue)) return applyPromises.get(idValue);
        const apply = (async () => {
            let repository = this.context.repository();
            let session = repository.getSession(idValue);
            if (!session) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            if (!session.threadId) return session;
            if (session.appliedRuntimeConfigRevision === session.configRevision
                && session.configApplyState === 'applied') return session;
            const desired = normalizeSessionConfig(session.configSnapshot || {});
            const applied = normalizeSessionConfig(session.appliedRuntimeConfig || {});
            this._assertApplicableInstructionMode(repository, session, desired, applied);
            session = repository.markSessionConfigApplying(idValue, session.configRevision);
            this.sendSessionConfigEvent('session.config.pending', session);
            let operation = null;
            try {
                await this.context.start();
                operation = this._operation({ sessionId: idValue, threadId: session.threadId });
                repository = operation ? this._operationRepository(operation) : this.context.repository();
                if (!this.context.resumedThreadIds().has(session.threadId)) {
                    await this.context.resumeSession(session);
                    return this._operationRepository(operation).getSession(idValue);
                }
                if (instructionConfigChanged(desired, applied)) {
                    const activity = this.context.threadStates().get(session.threadId)?.activity;
                    if (activity === 'running') {
                        if (barrier) throw new CodexAppServerError(
                            'SESSION_CONFIG_PENDING', 'Instruction changes will be applied after the active Turn finishes',
                        );
                        return repository.getSession(idValue);
                    }
                    await this.context.transport().request('thread/unsubscribe', { threadId: session.threadId });
                    repository = this._operationRepository(operation);
                    this.context.resumedThreadIds().delete(session.threadId);
                    await this.context.resumeSession(repository.getSession(idValue));
                    return this._operationRepository(operation).getSession(idValue);
                }
                const targetSettings = runtimeSettingsTarget(session, desired);
                const appliedSettings = runtimeSettingsTarget({
                    ...session,
                    workspaceRoot: applied.workspaceRoot || session.appliedRuntimeConfig?.workspaceRoot,
                }, applied);
                if (sameRuntimeSettings(targetSettings, appliedSettings)) {
                    const confirmed = repository.markSessionConfigApplied(idValue, session.configRevision, desired);
                    this.sendSessionConfigEvent('session.config.applied', confirmed);
                    return confirmed;
                }
                const rebound = await this._requestSettingsUpdate({
                    barrier, desired, operation, session, sessionId: idValue, targetSettings,
                });
                if (rebound) return rebound;
                return this._operationRepository(operation).getSession(idValue);
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.context.repository()) throw error;
                repository = this._operationRepository(operation);
                const target = this.context.configApplyTargets().get(session.threadId);
                if (target?.revision === session.configRevision) {
                    clearTimeout(target.timeout);
                    this.context.configApplyTargets().delete(session.threadId);
                }
                const current = repository.getSession(idValue);
                if (current?.configRevision === session.configRevision && error?.code !== 'SESSION_CONFIG_PENDING') {
                    const failed = repository.markSessionConfigFailed(idValue, session.configRevision, error.message);
                    this.sendSessionConfigEvent('session.config.failed', failed, error.message);
                }
                throw error;
            }
        })().finally(() => applyPromises.delete(idValue));
        applyPromises.set(idValue, apply);
        return apply;
    }
}

module.exports = { RuntimeConfigService };
