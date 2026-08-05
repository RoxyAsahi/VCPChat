import { profileSettingsTarget, sessionSettingsTarget } from './agent-settings-state.js';
import { PROFILE_CONFIG_FIELDS, normalizeAgentConfig } from '../agent-config-descriptors.js';
import { normalizeDiagnosticError } from './agent-config-diagnostics.js';

function normalizedSavedProfile(profile) {
    const instructionMode = profile.instructionMode === 'codex-managed' ? 'codex-managed' : 'vchat-identity';
    const baseInstructions = profile.baseInstructions || profile.systemPrompt || '';
    return {
        ...profile,
        instructionMode,
        baseInstructions,
        systemPrompt: profile.systemPrompt || '',
        developerInstructions: profile.developerInstructions || '',
        personality: profile.personality || 'none',
        reasoningEffort: profile.reasoningEffort || null,
        reasoningEfforts: Array.isArray(profile.reasoningEfforts) ? profile.reasoningEfforts : [],
        model: profile.model || '',
        workspaceRoot: profile.workspaceRoot || '',
        permissionMode: profile.permissionMode === 'always-approve' ? 'always-approve' : 'ask',
        toolPolicy: profile.toolPolicy || { schemaVersion: 1, preset: 'full', enabledCodexCapabilities: [], enabledVcpTools: [] },
        configurationRequired: instructionMode !== 'codex-managed' && !String(baseInstructions).trim(),
    };
}

function profileSavePayload(payload, profile, values) {
    const own = (key) => Object.prototype.hasOwnProperty.call(payload, key);
    return {
        agentId: profile.id || profile.name,
        expectedProfileRevision: Number(profile.profileRevision || profile.revision || 1),
        name: own('name') ? payload.name : profile.name || profile.id,
        instructionMode: values.instructionMode,
        baseInstructions: values.baseInstructions,
        developerInstructions: own('developerInstructions') ? payload.developerInstructions : profile.developerInstructions || '',
        personality: own('personality') ? payload.personality : profile.personality || 'none',
        model: values.model,
        reasoningEffort: values.reasoningEffort,
        workspaceRoot: values.workspaceRoot,
        permissionMode: values.permissionMode,
        toolPolicy: values.toolPolicy,
    };
}

async function applySavedSettings(context, saved, payload, selectedSession, saveScope,
    projectionAtEnqueue, successMessage) {
    const { state, store, controller, refreshTopicsForAgent, notify, sessionConfigRevisions } = context;
    if (context.isDisposed()) return saved;
    if (saved?.profile && !saved.profile.configurationRequired) state.profileConfigurationNotice = '';
    await applyDerivedSession(context, saved);
    if (saved?.session?.configRevision) {
        sessionConfigRevisions.set(saved.session.sessionId, Number(saved.session.configRevision));
    }
    applyScalarSettings(context, saved, payload, selectedSession);
    updateSelectedSession(context, saved, selectedSession);
    state.settingsSaveState = 'saved';
    state.settingsSaveMessage = successMessage || '已自动保存';
    state.settingsSaveByScope.set(saveScope, { state: 'saved', message: successMessage || '已自动保存' });
    return saved;
}

async function applyDerivedSession(context, saved) {
    if (!saved?.createdDerivedSession || !saved?.session?.sessionId) return;
    const { state, controller, refreshTopicsForAgent, notify } = context;
    await refreshTopicsForAgent(saved.session.agentId || state.selectedAgent, false);
    if (context.isDisposed()) return;
    await controller.hydrateTopic(saved.session.sessionId, saved.session, null,
        saved.session.agentId || state.selectedAgent);
    if (!context.isDisposed()) notify('已保留原会话，并创建 Codex 管理指令派生会话。', 'success');
}

function applyScalarSettings(context, saved, payload, selectedSession) {
    const { state, store } = context;
    const stillSelected = !selectedSession || store.getState().selectedSessionId === selectedSession;
    if (stillSelected && Object.prototype.hasOwnProperty.call(payload, 'permissionMode')) {
        state.permissionMode = saved?.settings?.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
    }
    if (stillSelected && Object.prototype.hasOwnProperty.call(payload, 'model')) {
        state.model = saved?.settings?.model || saved?.session?.configSnapshot?.model || payload.model;
        state.modelDraft = null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'budget')) state.budget = { ...state.budget, ...payload.budget };
}

function updateSelectedSession(context, saved, selectedSession) {
    if (!selectedSession || !saved?.session?.configSnapshot) return;
    const current = context.store.getState();
    if (current.selectedSessionId !== selectedSession) return;
    context.store.setState({ selectedTopic: {
        ...current.selectedTopic,
        configSnapshot: saved.session.configSnapshot,
        configRevision: saved.session.configRevision,
        workspaceRef: saved.session.workspaceRoot || current.selectedTopic.workspaceRef,
        workspaceRoot: saved.session.workspaceRoot || current.selectedTopic.workspaceRoot,
    } });
}

function createAgentSettingsCoordinator({
    state,
    store,
    settingsState,
    controller,
    selectedAgentProfile,
    selectAgent,
    saveAgentProfile,
    refreshTopicsForAgent,
    notify,
    refreshViews,
}) {
    const sessionConfigRevisions = new Map();
    let disposed = false;

    async function persistAgentProfileDefaults(payload) {
        const profile = selectedAgentProfile();
        if (!profile) throw new Error('请先选择 Build Agent');
        const normalized = normalizeAgentConfig(payload, {
            fallback: profile,
            fields: PROFILE_CONFIG_FIELDS,
            context: { reasoningEfforts: profile.reasoningEfforts || [] },
        });
        if (normalized.errors.length) throw new Error(normalized.errors[0].message);
        const values = normalized.values;
        const result = await saveAgentProfile(profileSavePayload(payload, profile, values));
        if (!result?.success || !result.profile?.id) throw new Error(result?.error || 'Build Agent Profile 保存失败');
        const savedProfile = normalizedSavedProfile(result.profile);
        if (!disposed) {
            Object.assign(profile, savedProfile);
            selectAgent(savedProfile.id);
        }
        return {
            profile: savedProfile,
            settings: { model: savedProfile.model, permissionMode: savedProfile.permissionMode },
        };
    }

    function persist(payload, selectedSession, successMessage) {
        const saveScope = selectedSession ? 'session'
            : (Object.prototype.hasOwnProperty.call(payload, 'budget') ? 'advanced' : 'profile');
        const profile = selectedAgentProfile();
        const targetKey = selectedSession
            ? sessionSettingsTarget(selectedSession)
            : saveScope === 'advanced' ? 'advanced:global' : profileSettingsTarget(profile?.id || profile?.name);
        state.settingsSaveState = 'saving';
        state.settingsSaveMessage = '正在自动保存…';
        state.settingsSaveByScope.set(saveScope, { state: 'saving', message: '正在自动保存…' });
        refreshViews?.({ phase: 'saving', payload, selectedSession, saveScope });
        const projectionAtEnqueue = store.getState().selectedTopic;
        if (selectedSession && projectionAtEnqueue?.sessionId === selectedSession) {
            sessionConfigRevisions.set(selectedSession, Number(projectionAtEnqueue.configRevision || 1));
        }
        return settingsState.enqueue(targetKey, payload, async () => {
            const request = {
                ...payload,
                ...(selectedSession ? {
                    sessionId: selectedSession,
                    expectedConfigRevision: sessionConfigRevisions.get(selectedSession)
                        || Number(projectionAtEnqueue?.configRevision || 1),
                } : {}),
            };
            const profileUpdate = !selectedSession && [
                'name', 'systemPrompt', 'baseInstructions', 'instructionMode', 'developerInstructions',
                'personality', 'model', 'reasoningEffort', 'workspaceRoot', 'permissionMode',
                'toolPolicy',
            ].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
            const saved = profileUpdate
                ? await persistAgentProfileDefaults(payload)
                : await controller.updateWorkbenchSettings(request);
            return applySavedSettings({
                state, store, controller, refreshTopicsForAgent, notify, sessionConfigRevisions,
                isDisposed: () => disposed,
            }, saved, payload, selectedSession, saveScope, projectionAtEnqueue, successMessage);
        }, successMessage || '已自动保存').catch((error) => {
            if (!disposed) {
                state.settingsSaveState = 'error';
                state.settingsSaveMessage = error?.message || String(error);
                state.settingsSaveByScope.set(saveScope, {
                    state: error?.code === 'SESSION_CONFIG_CONFLICT' || error?.code === 'PROFILE_CONFIG_CONFLICT'
                        ? 'conflict' : 'error',
                    message: state.settingsSaveMessage,
                    error: normalizeDiagnosticError(error, 'SETTINGS_SAVE_ERROR'),
                });
                notify(state.settingsSaveMessage, 'error');
            }
            return null;
        }).finally(() => {
            if (!disposed && !state.disposed) {
                refreshViews?.({ phase: 'settled', payload, selectedSession, saveScope });
            }
        });
    }

    function dispose() { disposed = true; }

    return Object.freeze({ persist, sessionConfigRevisions, dispose });
}

export { createAgentSettingsCoordinator };
