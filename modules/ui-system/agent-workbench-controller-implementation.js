import { createWorkbenchStore } from './agent-workbench-store.js';
import {
    createAgentSessionUiState,
    reconcileAgentSessionUiState,
    reduceAgentSessionUiState,
} from './agent-session-state.js';
import { createAgentRuntimeEventSubscription, createWorkbenchClients } from './agent-workbench-clients.js';
import { createWorkbenchCommandController } from './agent-workbench-command-controller.js';
import { createProjectionReloadCoordinator } from './agent-workbench-projection-reload.js';
import { selectedSessionIdentity, selectedSessionId as selectedSessionIdFromState } from './agent-selected-session.js';
import {
    applyProjectionPatch,
    sessionProjectionFromState,
} from './agent-normalized-store.js';
import { createAgentProjectionHydrationCoordinator } from './agent-projection-hydration-coordinator.js';

function codexTurnEvent(event) {
    if (event?.method === 'turn/started') return { ...event, type: 'turn.started' };
    if (event?.method !== 'turn/completed') return event;
    const status = String(event.turnStatus || '').trim().toLowerCase();
    const type = ['failed', 'error'].includes(status) ? 'turn.failed'
        : ['interrupted', 'cancelled', 'canceled'].includes(status) ? 'turn.cancelled'
            : 'turn.completed';
    return {
        ...event,
        type,
        payload: {
            ...(event.payload || {}),
            ...(event.turnError ? { error: event.turnError } : {}),
            turnStatus: status || 'completed',
        },
    };
}

function createWorkbenchController(runtimeApi) {
    const clients = createWorkbenchClients(runtimeApi);
    const store = createWorkbenchStore();
    let projectionHydration = null;
    const sessionWarmPromises = new Map();

    function requireApi(name) {
        return clients.require(name);
    }

    function optionalApi(name) {
        return clients.optional(name);
    }

    function runtimeForTopic(sessionId, state = store.getState()) {
        if (!sessionId) return null;
        if (!(state.activeRuntimes instanceof Map)) return null;
        return state.activeRuntimes.get(sessionId) || null;
    }

    function selectedRuntime(state = store.getState()) {
        return runtimeForTopic(selectedSessionIdFromState(state), state);
    }

    function selectedSessionId(state = store.getState()) {
        return selectedSessionIdFromState(state);
    }

    function selectedTurnId(state = store.getState()) {
        return selectedRuntime(state)?.activeTurnId || null;
    }

    function projectRuntimeActivity(event) {
        if (!event?.sessionId) return;
        const current = store.getState();
        const activeRuntimes = new Map(current.activeRuntimes);
        const runtime = activeRuntimes.get(event.sessionId);
        if (!runtime || runtime.sessionId !== event.sessionId) return;
        let activity = null;
        if (event.type === 'turn.started') activity = 'running';
        else if (event.type === 'approval.requested') {
            if (!event.turnId || runtime.activeTurnId !== event.turnId) return;
            activity = 'awaiting-approval';
        }
        else if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) {
            if (!event.turnId || runtime.activeTurnId !== event.turnId) return;
            activity = 'idle';
        }
        if (!activity) return;
        activeRuntimes.set(event.sessionId, {
            ...runtime,
            activity,
            activeTurnId: activity === 'running' ? event.turnId
                : activity === 'idle' ? null : runtime.activeTurnId,
        });
        store.setState({ activeRuntimes });
    }

    async function refreshStatus() {
        const status = await requireApi('agentRuntimeGetStatus')();
        const projection = {
            runtime: {
                state: status?.state || 'unknown',
                runtime: status?.runtime || 'unknown',
                worker: status?.worker || null,
                lastError: status?.lastError || null,
                generation: Number(status?.generation || 0),
                toolbox: status?.toolbox || { configured: false, endpoint: null },
                storage: status?.storage || { readOnly: false, degradedReason: null },
                capabilities: status?.capabilities || null,
            },
            activeRuntimes: new Map((Array.isArray(status?.runtimes) ? status.runtimes : [])
                .filter((runtime) => typeof runtime?.sessionId === 'string' && runtime.sessionId.trim())
                .map((runtime) => [runtime.sessionId, runtime])),
            sessionUi: reconcileAgentSessionUiState(
                store.getState().sessionUi,
                Array.isArray(status?.sessions) ? status.sessions : [],
            ),
        };
        // Approvals are a Renderer-only live projection. Runtime events add and
        // remove them; Main must never manufacture an empty list that erases
        // a visible approval during an unrelated status refresh.
        // These lists are independently optional during restart/compatibility
        // refreshes.  Never let a status response that merely adds interaction
        // identities erase an approval already delivered as a live event.
        if (Array.isArray(status?.pendingApprovals)) projection.approvals = status.pendingApprovals;
        if (Array.isArray(status?.pendingInteractions)) projection.interactions = status.pendingInteractions;
        store.setState(projection);
        return status;
    }

    function ensureSessionRuntime(sessionId, reason = 'selection') {
        const id = String(sessionId || '').trim();
        if (!id) return Promise.reject(new Error('Session runtime warm requires sessionId'));
        if (sessionWarmPromises.has(id)) return sessionWarmPromises.get(id);
        const call = requireApi('agentRuntimeEnsureSessionRuntime')({ sessionId: id, reason });
        const promise = Promise.resolve(call)
            .then(async (runtime) => {
                if (runtime?.sessionId) {
                    const current = store.getState();
                    const activeRuntimes = new Map(current.activeRuntimes);
                    activeRuntimes.set(runtime.sessionId, {
                        ...activeRuntimes.get(runtime.sessionId),
                        ...runtime,
                        sessionId: runtime.sessionId,
                    });
                    store.setState({
                        activeRuntimes,
                        selectedTopic: current.selectedTopic?.sessionId === runtime.sessionId
                            ? { ...current.selectedTopic, mode: 'runtime-active' }
                            : current.selectedTopic,
                    });
                }
                await refreshStatus().catch(() => null);
                return runtime;
            })
            .finally(() => sessionWarmPromises.delete(id));
        sessionWarmPromises.set(id, promise);
        return promise;
    }

    const runtimeSubscription = createAgentRuntimeEventSubscription({
        subscribe: clients.optional('onAgentRuntimeEvent'),
        snapshotBarrier: () => projectionHydration?.activeBarrier() || null,
        store, applyCodexRuntimeEvent: (event) => applyCodexRuntimeEvent(event),
        applySessionUiEvent: (event) => applySessionUiEvent(event), projectRuntimeActivity,
        refreshStatus: () => refreshStatus(),
    });

    function pruneConfirmedEphemeralProjection(sessionId) {
        const current = store.getState();
        const selected = sessionProjectionFromState(current, sessionId)?.projection;
        if (!selected) return false;
        const ephemeralStateBySession = current.ephemeralStateBySession instanceof Map
            ? new Map(current.ephemeralStateBySession) : new Map();
        const ephemeral = ephemeralStateBySession.get(sessionId);
        const pendingMessages = Array.isArray(ephemeral?.pendingMessages) ? ephemeral.pendingMessages : [];
        if (!pendingMessages.length) return true;
        const confirmedTurns = new Set(selected.messages
            .filter((message) => message.role === 'user' && message.turnId)
            .map((message) => message.turnId));
        const remaining = pendingMessages.filter((message) => !confirmedTurns.has(message.turnId));
        if (remaining.length !== pendingMessages.length) {
            if (remaining.length) ephemeralStateBySession.set(sessionId, { ...ephemeral, pendingMessages: remaining });
            else ephemeralStateBySession.delete(sessionId);
            store.setState({ ephemeralStateBySession });
        }
        return true;
    }

    const projectionReloader = createProjectionReloadCoordinator({
        store,
        readProjection: (sessionId) => requireApi('agentSessionReadProjection')({ sessionId }),
        onApplied: (sessionId) => pruneConfirmedEphemeralProjection(sessionId),
    });

    function applyCodexRuntimeEvent(event) {
        const current = store.getState();
        const runtimes = new Map(current.activeRuntimes);
        const runtime = runtimes.get(event.sessionId);
        if (runtime && runtime.sessionId === event.sessionId) {
            runtimes.set(event.sessionId, {
                ...runtime,
                activity: event.activity || runtime.activity,
                activeTurnId: event.activity === 'running'
                    ? (event.turnId || runtime.activeTurnId)
                    : null,
            });
        }
        const selected = event.sessionId === selectedSessionIdentity(current)?.sessionId;
        store.setState({
            activeRuntimes: runtimes,
            ...(selected ? { activeTurnId: event.activity === 'running' ? event.turnId : null } : {}),
        });
        if (event.projectionPatch && event.sessionId) {
            const result = applyProjectionPatch(store.getState(), event.projectionPatch);
            if (result.applied) {
                store.setState(result.state, event);
                pruneConfirmedEphemeralProjection(event.sessionId);
            } else {
                void projectionReloader.reload(event.sessionId, event.projectionPatch.projectionRevision);
            }
        }
        const sessionEvent = codexTurnEvent(event);
        if (sessionEvent !== event) store.applyEphemeralEvent(sessionEvent);
        applySessionUiEvent(sessionEvent);
    }

    function applySessionUiEvent(event) {
        const current = store.getState();
        const sessionEvent = {
            ...event,
            requestId: event?.payload?.approval?.approvalId || event?.approvalId || null,
        };
        const reduced = reduceAgentSessionUiState(current.sessionUi || createAgentSessionUiState(), sessionEvent);
        if (reduced !== current.sessionUi) store.setState({ sessionUi: reduced });
    }

    projectionHydration = createAgentProjectionHydrationCoordinator({
        store,
        requireApi,
        runtimeForSession: runtimeForTopic,
        applyProjectionEvent: applyCodexRuntimeEvent,
        applySessionUiEvent,
        projectRuntimeActivity,
    });
    const {
        beginSnapshotBarrier,
        releaseSnapshotBarrier,
        hydrateTopic,
        previewTopic,
        clearSelection,
    } = projectionHydration;

    const commands = createWorkbenchCommandController({
        store,
        requireApi,
        refreshStatus,
        selectedRuntime,
        selectedSessionId,
        selectedTurnId,
        ensureSessionRuntime,
        previewTopic,
        hydrateTopic,
        beginSnapshotBarrier,
        releaseSnapshotBarrier,
    });
    const {
        startRuntime, stopRuntime, createSession, createSessionPreview, forkSession, compactSession,
        listSessions, searchTopics, searchTopicMessages, getTopicIndexStatus, rebuildTopicIndex,
        readSession, renameSession, archiveSession, restoreSession, permanentlyDeleteSession,
        exportSession, listRecoveryOperations, listRecoveryCandidates, resolveRecoveryOperation, setSessionPinned,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue, resolvePendingInput,
        getWorkbenchSettings, updateWorkbenchSettings, readSessionConfig, readSessionDiagnostics,
        reapplySessionConfig, applyAgentProfile, selectAttachments,
        startTurn, cancelTurn, cancelTool, steerTurn, followUpTurn,
        respondApproval, respondInteraction, respondToolboxApproval,
        workspaceListDirectory, workspaceReadPreview, workspaceSearchFiles,
        workspaceStatPath, workspacePerformPathAction, workspaceCancel,
        listAgentProfiles, getCachedModels, saveAgentProfile, saveAgentAvatar,
        openExternal, launchVchatApp, openThemes, openImageViewer, showImageContextMenu,
    } = commands;

    async function initialize() {
        // Subscribe before reading the SQLite projection. The barrier belongs
        // to the Renderer and buffers any live Runtime frame that arrives
        // while `read-topic` establishes the durable snapshot waterline.
        const barrier = beginSnapshotBarrier();
        subscribeRuntime();
        optionalApi('agentRuntimeSetWorkbenchPresence')?.(true);
        const status = await refreshStatus().catch(() => null);
        // Ctrl+R restores only an actual selected runtime. A list of active
        // Topic Hosts is not a request to pick one or replay its transcript.
        const current = store.getState();
        const selected = current.selectedTopic;
        const runtime = selectedRuntime();
        const sessionId = selectedSessionIdFromState(current);
        if (sessionId && runtime) {
            await hydrateTopic(sessionId, runtime, barrier, selected?.agentId || runtime.agentId);
        } else {
            releaseSnapshotBarrier(barrier, null, runtime);
        }
        return store.getState();
    }

    function subscribeRuntime() {
        runtimeSubscription.start();
    }

    function dispose() {
        projectionHydration.dispose();
        projectionReloader.dispose();
        void optionalApi('agentRuntimeSetWorkbenchPresence')?.(false);
        runtimeSubscription.dispose();
    }

    return {
        store, initialize, subscribeRuntime, dispose, refreshStatus, startRuntime, stopRuntime,
        createSession, createSessionPreview, forkSession, compactSession, hydrateTopic, previewTopic, ensureSessionRuntime, clearSelection,
        listSessions, searchTopics, searchTopicMessages, getTopicIndexStatus, rebuildTopicIndex,
        readSession, renameSession, archiveSession, restoreSession, permanentlyDeleteSession,
        exportSession, listRecoveryOperations, listRecoveryCandidates, resolveRecoveryOperation, setSessionPinned,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue, resolvePendingInput,
        getWorkbenchSettings, updateWorkbenchSettings, readSessionConfig, readSessionDiagnostics,
        reapplySessionConfig, applyAgentProfile, selectAttachments,
        startTurn, steerTurn, followUpTurn, cancelTurn, cancelTool, respondApproval, respondInteraction,
        respondToolboxApproval,
        workspaceListDirectory, workspaceReadPreview, workspaceSearchFiles,
        workspaceStatPath, workspacePerformPathAction,
        workspaceCancel,
        listAgentProfiles, getCachedModels, saveAgentProfile, saveAgentAvatar,
        openExternal, launchVchatApp, openThemes, openImageViewer, showImageContextMenu,
    };
}

export { createWorkbenchController };
