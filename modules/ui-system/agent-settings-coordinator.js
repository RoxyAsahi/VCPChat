import { profileSettingsTarget, sessionSettingsTarget } from './agent-settings-state.js';

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
        const result = await saveAgentProfile({
            agentId: profile.id || profile.name,
            expectedProfileRevision: Number(profile.profileRevision || profile.revision || 1),
            name: Object.prototype.hasOwnProperty.call(payload, 'name')
                ? payload.name : profile.name || profile.id,
            instructionMode: Object.prototype.hasOwnProperty.call(payload, 'instructionMode')
                ? payload.instructionMode : profile.instructionMode || 'vchat-identity',
            baseInstructions: Object.prototype.hasOwnProperty.call(payload, 'baseInstructions')
                ? payload.baseInstructions
                : Object.prototype.hasOwnProperty.call(payload, 'systemPrompt')
                    ? payload.systemPrompt : profile.baseInstructions || profile.systemPrompt || '',
            developerInstructions: Object.prototype.hasOwnProperty.call(payload, 'developerInstructions')
                ? payload.developerInstructions : profile.developerInstructions || '',
            personality: Object.prototype.hasOwnProperty.call(payload, 'personality')
                ? payload.personality : profile.personality || 'none',
            model: Object.prototype.hasOwnProperty.call(payload, 'model') ? payload.model : profile.model,
            reasoningEffort: Object.prototype.hasOwnProperty.call(payload, 'reasoningEffort')
                ? payload.reasoningEffort : profile.reasoningEffort,
            workspaceRoot: Object.prototype.hasOwnProperty.call(payload, 'workspaceRoot')
                ? payload.workspaceRoot : profile.workspaceRoot,
            permissionMode: Object.prototype.hasOwnProperty.call(payload, 'permissionMode')
                ? payload.permissionMode : profile.permissionMode,
        });
        if (!result?.success || !result.profile?.id) throw new Error(result?.error || 'Build Agent Profile 保存失败');
        const savedProfile = {
            ...result.profile,
            instructionMode: result.profile.instructionMode === 'codex-managed'
                ? 'codex-managed' : 'vchat-identity',
            baseInstructions: result.profile.baseInstructions || result.profile.systemPrompt || '',
            systemPrompt: result.profile.systemPrompt || '',
            developerInstructions: result.profile.developerInstructions || '',
            personality: result.profile.personality || 'none',
            reasoningEffort: result.profile.reasoningEffort || null,
            reasoningEfforts: Array.isArray(result.profile.reasoningEfforts) ? result.profile.reasoningEfforts : [],
            model: result.profile.model || '',
            workspaceRoot: result.profile.workspaceRoot || '',
            permissionMode: result.profile.permissionMode === 'always-approve' ? 'always-approve' : 'ask',
            configurationRequired: result.profile.instructionMode !== 'codex-managed'
                && !String(result.profile.baseInstructions || result.profile.systemPrompt || '').trim(),
        };
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
            ].some((key) => Object.prototype.hasOwnProperty.call(payload, key));
            const saved = profileUpdate
                ? await persistAgentProfileDefaults(payload)
                : await controller.updateWorkbenchSettings(request);
            if (disposed) return saved;
            if (saved?.profile && !saved.profile.configurationRequired) state.profileConfigurationNotice = '';
            if (saved?.createdDerivedSession && saved?.session?.sessionId) {
                await refreshTopicsForAgent(saved.session.agentId || state.selectedAgent, false);
                if (disposed) return saved;
                await controller.hydrateTopic(saved.session.sessionId, saved.session, null,
                    saved.session.agentId || state.selectedAgent);
                if (!disposed) notify('已保留原会话，并创建 Codex 管理指令派生会话。', 'success');
            }
            if (saved?.session?.configRevision) {
                sessionConfigRevisions.set(saved.session.sessionId, Number(saved.session.configRevision));
            }
            const stillSelected = !selectedSession || store.getState().selectedSessionId === selectedSession;
            if (stillSelected && Object.prototype.hasOwnProperty.call(payload, 'permissionMode')) {
                state.permissionMode = saved?.settings?.permissionMode === 'always-approve' ? 'always-approve' : 'ask';
            }
            if (stillSelected && Object.prototype.hasOwnProperty.call(payload, 'model')) {
                state.model = saved?.settings?.model || saved?.session?.configSnapshot?.model || payload.model;
                state.modelDraft = null;
            }
            if (Object.prototype.hasOwnProperty.call(payload, 'budget')) state.budget = { ...state.budget, ...payload.budget };
            if (stillSelected && selectedSession && saved?.session?.configSnapshot) {
                const current = store.getState();
                if (current.selectedSessionId === selectedSession) {
                    store.setState({
                        selectedTopic: {
                            ...current.selectedTopic,
                            configSnapshot: saved.session.configSnapshot,
                            configRevision: saved.session.configRevision,
                            workspaceRef: saved.session.workspaceRoot || current.selectedTopic.workspaceRef,
                            workspaceRoot: saved.session.workspaceRoot || current.selectedTopic.workspaceRoot,
                        },
                    });
                }
            }
            state.settingsSaveState = 'saved';
            state.settingsSaveMessage = successMessage || '已自动保存';
            state.settingsSaveByScope.set(saveScope, { state: 'saved', message: successMessage || '已自动保存' });
            return saved;
        }, successMessage || '已自动保存').catch((error) => {
            if (!disposed) {
                state.settingsSaveState = 'error';
                state.settingsSaveMessage = error?.message || String(error);
                state.settingsSaveByScope.set(saveScope, { state: 'error', message: state.settingsSaveMessage });
                notify(state.settingsSaveMessage, 'error');
            }
            return null;
        }).finally(() => {
            if (!disposed && !state.disposed) refreshViews();
        });
    }

    function dispose() { disposed = true; }

    return Object.freeze({ persist, sessionConfigRevisions, dispose });
}

export { createAgentSettingsCoordinator };
