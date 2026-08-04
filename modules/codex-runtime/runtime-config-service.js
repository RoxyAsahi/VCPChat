'use strict';

const fs = require('fs');
const path = require('path');
const { CodexAppServerError } = require('./appServerTransport');
const { normalizeSessionConfig } = require('./dataContracts');
const {
    instructionConfigChanged,
    requiresFreshCodexManagedSession,
    threadSettingsPatch,
} = require('./runtimeConfig');
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
        const hasPermissionUpdate = hasConfigField(settings, 'permissionMode');
        const permissionMode = hasPermissionUpdate
            ? normalizeConfigField('permissionMode', settings.permissionMode).value : null;
        const requestedModel = hasConfigField(settings, 'model')
            ? normalizeConfigField('model', settings.model).value || null : null;
        const hasReasoningUpdate = hasConfigField(settings, 'reasoningEffort');
        const hasSystemPromptUpdate = Object.prototype.hasOwnProperty.call(settings, 'systemPrompt');
        const hasBaseInstructionsUpdate = hasConfigField(settings, 'baseInstructions');
        const requestedSystemPrompt = (hasSystemPromptUpdate || hasBaseInstructionsUpdate)
            ? normalizeConfigField('baseInstructions', settings.baseInstructions ?? settings.systemPrompt).value : null;
        const hasInstructionModeUpdate = hasConfigField(settings, 'instructionMode');
        const hasDeveloperInstructionsUpdate = Object.prototype.hasOwnProperty.call(settings, 'developerInstructions');
        const hasPersonalityUpdate = Object.prototype.hasOwnProperty.call(settings, 'personality');
        const hasWorkspaceUpdate = hasConfigField(settings, 'workspaceRoot');
        let requestedWorkspaceRoot = null;
        if (hasWorkspaceUpdate) {
            requestedWorkspaceRoot = path.resolve(
                String(settings.workspaceRoot || '').trim() || this.context.projectRoot(),
            );
            let workspaceStat = null;
            try { workspaceStat = fs.statSync(requestedWorkspaceRoot); } catch { /* validated below */ }
            if (!workspaceStat?.isDirectory()) {
                throw new CodexAppServerError('INVALID_WORKSPACE', 'Workspace directory does not exist');
            }
        }
        const sessionId = String(settings.sessionId || '').trim();
        let session = null;
        if (sessionId) {
            const repository = this.context.repository();
            const current = repository.getSession(sessionId);
            if (!current) throw new CodexAppServerError('NOT_FOUND', 'Agent Session was not found');
            const expectedRevision = Number(settings.expectedConfigRevision);
            if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
                throw new CodexAppServerError(
                    'SESSION_CONFIG_REVISION_REQUIRED', 'Session settings require expectedConfigRevision',
                );
            }
            const nextInstructionMode = hasInstructionModeUpdate
                ? normalizeInstructionMode(settings.instructionMode, requestedSystemPrompt)
                : normalizeInstructionMode(current.configSnapshot?.instructionMode, current.configSnapshot?.baseInstructions);
            const nextBaseInstructions = (hasSystemPromptUpdate || hasBaseInstructionsUpdate)
                ? requestedSystemPrompt : String(current.configSnapshot?.baseInstructions || '');
            const nextDeveloperInstructions = hasDeveloperInstructionsUpdate
                ? String(settings.developerInstructions || '').trim()
                : String(current.configSnapshot?.developerInstructions || '');
            const nextPersonality = hasPersonalityUpdate
                ? normalizePersonality(settings.personality)
                : normalizePersonality(current.configSnapshot?.personality);
            const requestedConfig = {
                ...(current.configSnapshot || {}),
                instructionMode: nextInstructionMode,
                baseInstructions: nextBaseInstructions,
                developerInstructions: nextDeveloperInstructions,
                personality: nextPersonality,
            };
            if (current.threadId && requiresFreshCodexManagedSession(
                requestedConfig, current.appliedRuntimeConfig || current.configSnapshot || {},
            )) {
                if (settings.createDerivedSession === true) {
                    const derivedPermissionMode = permissionMode || normalizePermissionMode(
                        current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
                    );
                    const derived = await this.context.createSession({
                        ...current.configSnapshot,
                        ...requestedConfig,
                        agentId: current.agentId,
                        title: `${current.title || 'Agent Session'} (Codex managed)`,
                        workspaceRoot: hasWorkspaceUpdate ? requestedWorkspaceRoot : current.workspaceRoot,
                        permissionMode: derivedPermissionMode,
                        approvalPolicy: normalizeApprovalPolicy(derivedPermissionMode),
                        ...(requestedModel ? { model: requestedModel } : {}),
                    });
                    return {
                        ...this.getWorkbenchSettings(),
                        settings: {
                            permissionMode: derivedPermissionMode,
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
                throw new CodexAppServerError(
                    'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                    'Codex 0.146 cannot clear persisted baseInstructions on this Thread; create a derived Session',
                    { requiresDerivedSession: true, requestedConfig },
                );
            }
            if (nextInstructionMode === 'vchat-identity' && !nextBaseInstructions) {
                throw new CodexAppServerError('AGENT_IDENTITY_MISSING', 'VChat identity mode requires baseInstructions');
            }
            const currentPermissionMode = normalizePermissionMode(
                current.configSnapshot?.permissionMode || current.configSnapshot?.approvalPolicy,
            );
            const nextModel = requestedModel || current.configSnapshot?.model || '';
            const reasoning = hasReasoningUpdate
                ? this.context.validateReasoningEffort(nextModel, settings.reasoningEffort)
                : {
                    effort: normalizeReasoningEffort(current.configSnapshot?.reasoningEffort),
                    supported: Array.isArray(current.configSnapshot?.reasoningEfforts)
                        ? current.configSnapshot.reasoningEfforts : this.context.reasoningEffortsForModel(nextModel),
                };
            const updated = repository.updateSessionConfig(sessionId, expectedRevision, {
                workspaceRoot: hasWorkspaceUpdate ? requestedWorkspaceRoot : current.workspaceRoot,
                configSnapshot: {
                    ...(current.configSnapshot || {}),
                    permissionMode: permissionMode || currentPermissionMode,
                    approvalPolicy: normalizeApprovalPolicy(permissionMode || currentPermissionMode),
                    ...(requestedModel ? { model: requestedModel } : {}),
                    instructionMode: nextInstructionMode,
                    baseInstructions: nextBaseInstructions,
                    developerInstructions: nextDeveloperInstructions,
                    personality: nextPersonality,
                    reasoningEffort: reasoning.effort,
                    reasoningEfforts: reasoning.supported,
                },
            });
            if (!updated.updated) {
                throw new CodexAppServerError('SESSION_CONFIG_CONFLICT', 'Session settings changed in another view', {
                    current: updated.session,
                });
            }
            session = updated.session;
            this.sendSessionConfigEvent('session.config.saved', session);
            this.scheduleApply(session.sessionId);
        } else if ((requestedModel || hasPermissionUpdate) && this.context.setSettings()) {
            await this.context.setSettings()((current) => ({
                ...current,
                agentRuntime: {
                    ...(current?.agentRuntime || {}),
                    codex: {
                        ...(current?.agentRuntime?.codex || {}),
                        ...(requestedModel ? { model: requestedModel } : {}),
                        ...(hasPermissionUpdate ? { permissionMode } : {}),
                    },
                },
            }));
        }
        const defaults = this.getWorkbenchSettings();
        const effectivePermissionMode = session
            ? normalizePermissionMode(session.configSnapshot?.permissionMode || session.configSnapshot?.approvalPolicy)
            : (permissionMode || defaults.permissionMode);
        const effectiveModel = session?.configSnapshot?.model || requestedModel || defaults.model || null;
        return {
            ...defaults,
            settings: {
                permissionMode: effectivePermissionMode,
                ...(effectiveModel ? { model: effectiveModel } : {}),
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
            if (requiresFreshCodexManagedSession(desired, applied)) {
                const error = new CodexAppServerError(
                    'IDENTITY_CHANGE_REQUIRES_NEW_SESSION',
                    'Codex-managed instructions require a derived Session for this Thread',
                );
                session = repository.markSessionConfigFailed(idValue, session.configRevision, error.message);
                this.sendSessionConfigEvent('session.config.failed', session, error.message);
                throw error;
            }
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
                this.context.configApplyTargets().set(session.threadId, {
                    sessionId: idValue,
                    revision: session.configRevision,
                    snapshot: desired,
                    runtimeGeneration: this.context.runtimeGeneration(),
                });
                await this.context.transport().request('thread/settings/update', threadSettingsPatch(session, desired));
                return this._operationRepository(operation).getSession(idValue);
            } catch (error) {
                if (error?.code === 'STALE_RUNTIME_GENERATION' || !this.context.repository()) throw error;
                repository = this._operationRepository(operation);
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
