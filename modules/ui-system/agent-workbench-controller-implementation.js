import { createWorkbenchStore } from './agent-workbench-store.js';
import {
    createAgentSessionUiState,
    reconcileAgentSessionUiState,
    reduceAgentSessionUiState,
    requireMatchingProjectionSession,
    requireSnapshotSession,
} from './agent-session-state.js';
import { createAgentRuntimeEventSubscription, createWorkbenchClients } from './agent-workbench-clients.js';
import { codexSnapshotToProjection } from './agent-workbench-snapshot-projection.js';
import { createWorkbenchCommandController } from './agent-workbench-command-controller.js';
import { createProjectionReloadCoordinator } from './agent-workbench-projection-reload.js';
import { selectedSessionIdentity, selectedSessionId as selectedSessionIdFromState } from './agent-selected-session.js';
import {
    applyProjectionPatch,
    applyProjectionSnapshot,
    sessionProjectionFromState,
} from './agent-normalized-store.js';
import {
    durableSnapshotState,
    hydratedRuntime,
    hydratedTopicProjection,
    snapshotAgentId,
} from './agent-workbench-controller-hydration.js';
function createWorkbenchController(runtimeApi) {
    const clients = createWorkbenchClients(runtimeApi);
    const store = createWorkbenchStore();
    let selectionVersion = 0;
    let snapshotBarrier = null;
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
        snapshotBarrier: () => snapshotBarrier,
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
        if (event.method === 'turn/started' || event.method === 'turn/completed') {
            store.applyEphemeralEvent({
                type: event.method === 'turn/started' ? 'turn.started' : 'turn.completed',
                sessionId: event.sessionId,
                turnId: event.turnId,
            });
        }
        applySessionUiEvent(event);
    }

    function applySessionUiEvent(event) {
        const current = store.getState();
        const method = event?.method;
        const mappedType = method === 'turn/started' ? 'turn.started'
            : method === 'turn/completed' ? 'turn.completed'
                : event?.type;
        const sessionEvent = {
            ...event,
            type: mappedType,
            requestId: event?.payload?.approval?.approvalId || event?.approvalId || null,
        };
        const reduced = reduceAgentSessionUiState(current.sessionUi || createAgentSessionUiState(), sessionEvent);
        if (reduced !== current.sessionUi) store.setState({ sessionUi: reduced });
    }

    function cachedProjection(sessionId) {
        return sessionProjectionFromState(store.getState(), sessionId)?.projection || null;
    }

    function canReconcileSession(sessionId, state = store.getState()) {
        const runtime = runtimeForTopic(sessionId, state);
        if (runtime?.activeTurnId) return false;
        if (['running', 'awaiting-approval', 'starting', 'reconnecting', 'unknown']
            .includes(String(runtime?.activity || '').trim())) return false;
        const sessionState = state.sessionUi?.bySessionId?.[sessionId]?.state;
        return ![
            'warming', 'starting', 'streaming', 'waiting-native-approval',
            'waiting-vcp-approval', 'waiting-user-input', 'interrupting', 'reconnecting',
        ].includes(sessionState);
    }

    function applyPreviewProjection(projection, selectedTopic, projectionSessionId) {
        const current = store.getState();
        const selectedSessionId = requireMatchingProjectionSession(
            selectedTopic?.sessionId, projectionSessionId,
        );
        store.setState({
            ...projection,
            selectedTopic,
            selectedSessionId,
            activeTurnId: null,
            context: projection.context || current.context,
            plan: projection.plan || null,
        });
    }

    function beginSnapshotBarrier() {
        const barrier = { events: [] };
        snapshotBarrier = barrier;
        return barrier;
    }

    function eventBelongsToTopicRuntime(event, runtime) {
        if (!event || typeof event !== 'object') return false;
        if (event.type?.startsWith('runtime.')) return true;
        return Boolean(runtime?.sessionId
            && event.sessionId === runtime.sessionId
            && event.sessionId === runtime.sessionId);
    }

    function releaseSnapshotBarrier(barrier, snapshot, runtime) {
        if (snapshotBarrier !== barrier) return;
        snapshotBarrier = null;
        // `snapshotSequence` is supplied with the projection snapshot. It is
        // the durable-snapshot waterline: stale buffered events are never
        // replayed by JS after a reload, switch or reconnect.
        const minimumSequence = Number(snapshot?.snapshotSequence);
        for (const event of barrier.events) {
            // Runtime diagnostics are process-global rather than a Session
            // transcript mutation. A selected Session Runtime can legitimately
            // be absent while the control transport is being created, so a
            // Session-identity snapshot filter would otherwise drop
            // the asynchronous ToolBox readiness result and leave the UI at
            // a permanent “checking” state. They remain Main-authored and
            // reducer-owned; this is not a Main/Renderer probe or inference.
            if (event?.type?.startsWith('runtime.')) {
                store.dispatch(event);
                continue;
            }
            if (event?.type?.startsWith('approval.')) {
                store.dispatch(event);
                continue;
            }
            if (!eventBelongsToTopicRuntime(event, runtime)) continue;
            if (Number.isFinite(minimumSequence) && Number(event.sequence) <= minimumSequence) continue;
            if (event?.runtime === 'codex' && event?.type === 'projection.updated') {
                applyCodexRuntimeEvent(event);
                continue;
            }
            applySessionUiEvent(event);
            projectRuntimeActivity(event);
            store.dispatch(event);
        }
    }

    function applyHydratedSnapshot(sessionId, snapshot, runtimeHint, agentId) {
        requireSnapshotSession(snapshot, sessionId);
        const current = store.getState();
        // A sidebar row may have been created before a background Turn
        // started. The identity-keyed runtime Map is fresher than that DOM
        // closure, so never let a stale row hint erase activeTurnId/activity.
        const active = runtimeForTopic(sessionId, current) || runtimeHint;
        // `read-topic` / `read-projection` is the durable metadata source
        // after a reload. Main's runtime status intentionally has only a
        // small identity shell, never a transcript cache.
        const durableState = durableSnapshotState(snapshot);
        const durableAgentId = snapshotAgentId(snapshot, durableState, agentId, active);
        const nextRuntime = hydratedRuntime(active, sessionId, durableState, durableAgentId);
        const runtimeSessionId = nextRuntime?.sessionId && String(nextRuntime.sessionId).trim()
            ? nextRuntime.sessionId : sessionId;
        const activeRuntimes = new Map(current.activeRuntimes);
        if (nextRuntime) activeRuntimes.set(runtimeSessionId, { ...nextRuntime, sessionId: runtimeSessionId });
        const normalizedState = applyProjectionSnapshot(current, snapshot);
        const normalizedCurrent = { ...current, ...normalizedState };
        const projection = Array.isArray(snapshot?.messages)
            ? (sessionProjectionFromState(normalizedCurrent, sessionId)?.projection || codexSnapshotToProjection(snapshot))
            : codexSnapshotToProjection(snapshot);
        const selectedSessionId = durableState.sessionId
            ? durableState.sessionId : runtimeSessionId;
        store.setState({
            ...projection,
            ...normalizedState,
            selectedSessionId,
            activeTurnId: nextRuntime?.activeTurnId || projection.activeTurnId || null,
            activeRuntimes,
            selectedTopic: hydratedTopicProjection(durableState, nextRuntime, durableAgentId, selectedSessionId),
        });
        return nextRuntime;
    }

    function snapshotIsStale(sessionId, snapshot, state = store.getState()) {
        const currentRevision = Number(state.projectionRevisions?.get(sessionId) || 0);
        const snapshotRevision = Number(snapshot?.projectionRevision || snapshot?.projection?.mutationGeneration || 0);
        return snapshotRevision < currentRevision;
    }

    async function reconcileHydratedTopic(sessionId, runtimeHint, agentId, version) {
        try {
            const snapshot = await requireApi('agentSessionRead')({ sessionId: sessionId, ...(agentId ? { agentId } : {}) });
            const current = store.getState();
            if (version !== selectionVersion || current.selectedTopic?.sessionId !== sessionId) return null;
            if (snapshotIsStale(sessionId, snapshot, current)) return null;
            applyHydratedSnapshot(sessionId, snapshot, runtimeHint || runtimeForTopic(sessionId), agentId);
            return snapshot;
        } catch (_error) {
            // The SQLite projection remains visible; Main records a sync
            // error and only a confirmed Thread-not-found becomes orphaned.
            return null;
        }
    }

    async function hydrateTopic(sessionId, runtimeHint = null, existingBarrier = null, agentId = undefined) {
        if (!sessionId) return null;
        const version = ++selectionVersion;
        const barrier = existingBarrier || beginSnapshotBarrier();
        try {
            const snapshot = await requireApi('agentSessionReadProjection')({
                sessionId: sessionId, ...(agentId ? { agentId } : {}),
            });
            if (version !== selectionVersion) {
                releaseSnapshotBarrier(barrier, null, runtimeHint || runtimeForTopic(sessionId));
                return null;
            }
            const nextRuntime = applyHydratedSnapshot(sessionId, snapshot, runtimeHint, agentId);
            releaseSnapshotBarrier(barrier, snapshot, nextRuntime);
            if (canReconcileSession(sessionId)) {
                void reconcileHydratedTopic(sessionId, runtimeHint, agentId, version);
            }
            return snapshot;
        } catch (error) {
            releaseSnapshotBarrier(barrier, null, runtimeForTopic(sessionId));
            throw error;
        }
    }

    // View selection reads the durable SQLite projection first. It does not
    // resume, stop, or otherwise mutate any Codex Thread.
    async function previewTopic(sessionId, agentId = undefined, metadata = {}) {
        if (!sessionId) return null;
        const version = ++selectionVersion;
        const barrier = beginSnapshotBarrier();
        const selectedTopic = {
            sessionId,
            agentId: agentId || metadata.agentId || null,
            model: metadata.model || '',
            workspaceRoot: metadata.workspaceRef || metadata.workspaceRoot || '',
            title: metadata.title || '',
            archivedAt: metadata.archivedAt || null,
            mode: 'preview',
        };
        const cached = cachedProjection(sessionId);
        if (cached) applyPreviewProjection(cached, selectedTopic, sessionId);
        let localSnapshot;
        try {
            // This is the only awaited cold-open read in the Codex path. It
            // is a local SQLite query and must not request a Codex Thread.
            localSnapshot = await requireApi('agentSessionReadProjection')({
                sessionId: sessionId, ...(agentId ? { agentId } : {}),
            });
            if (version !== selectionVersion) {
                releaseSnapshotBarrier(barrier, null, runtimeForTopic(sessionId));
                return null;
            }
            const resolvedTopic = resolvePreviewTopic(localSnapshot, selectedTopic);
            if (snapshotIsStale(sessionId, localSnapshot, store.getState())) {
                releaseSnapshotBarrier(barrier, localSnapshot, runtimeForTopic(sessionId));
                return localSnapshot;
            }
            const normalizedState = applyProjectionSnapshot(store.getState(), localSnapshot);
            store.setState(normalizedState);
            const projection = Array.isArray(localSnapshot?.messages)
                ? (sessionProjectionFromState(store.getState(), sessionId)?.projection || codexSnapshotToProjection(localSnapshot))
                : codexSnapshotToProjection(localSnapshot);
            applyPreviewProjection(
                projection,
                resolvedTopic,
                localSnapshot?.session?.sessionId,
            );
            releaseSnapshotBarrier(barrier, localSnapshot, runtimeForTopic(sessionId));
            // Deliberately detached: navigation is complete before App Server
            // reconciliation begins. The guards in reconcilePreviewTopic make
            // an A response harmless after the user selects B.
            if (canReconcileSession(sessionId)) {
                void reconcilePreviewTopic(sessionId, agentId, resolvedTopic, version);
            }
            return localSnapshot;
        } catch (error) {
            releaseSnapshotBarrier(barrier, null, runtimeForTopic(sessionId));
            throw error;
        }
    }

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
        getWorkbenchSettings, updateWorkbenchSettings, applyAgentProfile, selectAttachments,
        startTurn, cancelTurn, cancelTool, steerTurn, followUpTurn,
        respondApproval, respondInteraction, respondToolboxApproval,
        workspaceListDirectory, workspaceReadPreview, workspaceSearchFiles,
        workspaceStatPath, workspacePerformPathAction, workspaceCancel,
        listAgentProfiles, getCachedModels, saveAgentProfile, saveAgentAvatar,
        openExternal, launchVchatApp, openThemes, openImageViewer, showImageContextMenu,
    } = commands;

    function resolvePreviewTopic(snapshot, selectedTopic) {
        const durableAgentId = typeof snapshot?.session?.agentId === 'string' && snapshot.session.agentId.trim()
            ? snapshot.session.agentId
            : typeof snapshot?.agentId === 'string' && snapshot.agentId.trim() ? snapshot.agentId
                : selectedTopic.agentId;
        const durableState = snapshot?.session && typeof snapshot.session === 'object'
            ? snapshot.session
            : snapshot?.state && typeof snapshot.state === 'object' ? snapshot.state : {};
        return {
            ...selectedTopic,
            agentId: durableAgentId,
            title: typeof durableState.title === 'string' && durableState.title.trim()
                ? durableState.title : selectedTopic.title,
            model: typeof durableState.model === 'string' && durableState.model.trim()
                ? durableState.model : selectedTopic.model,
            workspaceRoot: typeof durableState.workspaceRef === 'string' && durableState.workspaceRef.trim()
                ? durableState.workspaceRef : selectedTopic.workspaceRoot,
            configSnapshot: durableState.configSnapshot || null,
            configRevision: Number(durableState.configRevision || selectedTopic.configRevision || 1),
            archivedAt: durableState.archivedAt || selectedTopic.archivedAt || null,
        };
    }

    async function reconcilePreviewTopic(sessionId, agentId, selectedTopic, version) {
        try {
            const snapshot = await requireApi('agentSessionRead')({ sessionId: sessionId, ...(agentId ? { agentId } : {}) });
            const current = store.getState();
            if (version !== selectionVersion || current.selectedTopic?.sessionId !== sessionId) return null;
            if (snapshotIsStale(sessionId, snapshot, current)) return null;
            const normalizedState = applyProjectionSnapshot(current, snapshot);
            store.setState(normalizedState);
            const projection = Array.isArray(snapshot?.messages)
                ? (sessionProjectionFromState(store.getState(), sessionId)?.projection || codexSnapshotToProjection(snapshot))
                : codexSnapshotToProjection(snapshot);
            applyPreviewProjection(
                projection,
                resolvePreviewTopic(snapshot, selectedTopic),
                snapshot?.session?.sessionId,
            );
            return snapshot;
        } catch (_error) {
            // A background sync failure preserves the SQLite projection. Main
            // records the sync error; only an explicit Thread-not-found may
            // make the Session orphaned.
            return null;
        }
    }

    function clearSelection() {
        selectionVersion += 1;
        if (snapshotBarrier) releaseSnapshotBarrier(snapshotBarrier, null, null);
        const current = store.getState();
        const globalProjection = {
            approvals: current.approvals,
            interactions: current.interactions,
            toolboxWs: current.toolboxWs,
            readiness: current.readiness,
            activityUnread: current.activityUnread,
            activityUnreadByTab: current.activityUnreadByTab,
        };
        store.selectSession(null);
        store.setState(globalProjection);
    }
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
        selectionVersion += 1;
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
        getWorkbenchSettings, updateWorkbenchSettings, applyAgentProfile, selectAttachments,
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
