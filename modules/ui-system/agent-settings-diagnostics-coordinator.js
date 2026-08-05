import { selectedSessionId } from './agent-selected-session.js';
import { buildAgentConfigDiagnostics, normalizeDiagnosticError } from './agent-config-diagnostics.js';
import { sessionSettingsTarget } from './agent-settings-state.js';

function createAgentSettingsDiagnosticsCoordinator({
    state,
    store,
    controller,
    settingsState = null,
    refreshControlPlane = async () => {},
    refresh = () => {},
} = {}) {
    let disposed = false;

    function selectedId() {
        return selectedSessionId(store.getState()) || '';
    }

    function current() {
        const currentState = store.getState();
        const sessionId = selectedSessionId(currentState) || '';
        const request = state.settingsDiagnostics?.sessionId === sessionId
            ? state.settingsDiagnostics : { sessionId, state: 'idle', config: null, error: null };
        const saveStatus = sessionId && settingsState
            ? settingsState.status(sessionSettingsTarget(sessionId))
            : state.settingsSaveByScope.get('session');
        return {
            model: buildAgentConfigDiagnostics({
                runtime: currentState.runtime,
                session: currentState.selectedTopic || {},
                authoritative: request.config,
                saveStatus,
            }),
            request: {
                loading: request.state === 'loading',
                applying: request.state === 'applying',
                error: request.error,
                readAt: request.readAt || 0,
            },
        };
    }

    async function load({ reapply = false } = {}) {
        const sessionId = selectedId();
        const requestId = Number(state.settingsDiagnostics?.requestId || 0) + 1;
        if (!sessionId) {
            state.settingsDiagnostics = {
                sessionId: '', state: 'idle', config: null, error: null, requestId, readAt: 0,
            };
            refresh();
            return null;
        }
        state.settingsDiagnostics = {
            sessionId,
            state: reapply ? 'applying' : 'loading',
            config: state.settingsDiagnostics?.sessionId === sessionId ? state.settingsDiagnostics.config : null,
            error: null,
            requestId,
            readAt: state.settingsDiagnostics?.sessionId === sessionId ? state.settingsDiagnostics.readAt : 0,
        };
        refresh();
        try {
            if (reapply) {
                await controller.reapplySessionConfig(sessionId);
                await refreshControlPlane();
            }
            const config = await controller.readSessionDiagnostics(sessionId);
            if (disposed || selectedId() !== sessionId
                || state.settingsDiagnostics?.requestId !== requestId) return null;
            state.settingsDiagnostics = {
                sessionId, state: 'ready', config, error: null, requestId, readAt: Date.now(),
            };
            refresh();
            return config;
        } catch (error) {
            if (!disposed && selectedId() === sessionId
                && state.settingsDiagnostics?.requestId === requestId) {
                state.settingsDiagnostics = {
                    ...state.settingsDiagnostics,
                    state: 'error',
                    error: normalizeDiagnosticError(error, reapply
                        ? 'SESSION_CONFIG_REAPPLY_ERROR' : 'SESSION_CONFIG_READ_ERROR'),
                };
                refresh();
            }
            throw error;
        }
    }

    function syncSelection({ event = null, visible = false } = {}) {
        if (disposed) return null;
        const sessionId = selectedId();
        const requestSessionId = String(state.settingsDiagnostics?.sessionId || '');
        const selectionChanged = requestSessionId !== sessionId;
        if (selectionChanged) {
            state.settingsDiagnostics = {
                sessionId,
                state: 'idle',
                config: null,
                error: null,
                requestId: Number(state.settingsDiagnostics?.requestId || 0) + 1,
                readAt: 0,
            };
        }
        const eventSessionId = String(event?.sessionId || event?.payload?.sessionId || '');
        const configChanged = String(event?.type || '').startsWith('session.config.')
            && eventSessionId === sessionId;
        if (!visible || !sessionId || (!selectionChanged && !configChanged)) return null;
        return load().catch(() => null);
    }

    function subscribe(render = () => {}, isVisible = () => false) {
        return store.subscribe((_nextState, event) => {
            void syncSelection({ event, visible: isVisible() });
            render(event);
        });
    }

    function dispose() {
        disposed = true;
        if (state.settingsDiagnostics) {
            state.settingsDiagnostics = {
                ...state.settingsDiagnostics,
                requestId: Number(state.settingsDiagnostics.requestId || 0) + 1,
            };
        }
    }

    return Object.freeze({ current, load, syncSelection, subscribe, dispose });
}

export { createAgentSettingsDiagnosticsCoordinator };
