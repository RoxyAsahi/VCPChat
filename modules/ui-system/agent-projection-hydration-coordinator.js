import {
    requireMatchingProjectionSession,
    requireSnapshotSession,
} from './agent-session-state.js';
import { codexSnapshotToProjection } from './agent-workbench-snapshot-projection.js';
import {
    applyProjectionSnapshot,
    sessionProjectionFromState,
} from './agent-normalized-store.js';
import {
    durableSnapshotState,
    hydratedRuntime,
    hydratedTopicProjection,
    snapshotAgentId,
} from './agent-workbench-controller-hydration.js';

export function createAgentProjectionHydrationCoordinator({
    store,
    requireApi,
    runtimeForSession,
    applyProjectionEvent,
    applySessionUiEvent,
    projectRuntimeActivity,
}) {
    let selectionVersion = 0;
    let activeBarrier = null;

    function cachedProjection(sessionId) {
        return sessionProjectionFromState(store.getState(), sessionId)?.projection || null;
    }

    function canReconcileSession(sessionId, state = store.getState()) {
        const runtime = runtimeForSession(sessionId, state);
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
        activeBarrier = barrier;
        return barrier;
    }

    function eventBelongsToRuntime(event, runtime) {
        if (!event || typeof event !== 'object') return false;
        if (event.type?.startsWith('runtime.')) return true;
        return Boolean(runtime?.sessionId && event.sessionId === runtime.sessionId);
    }

    function releaseSnapshotBarrier(barrier, snapshot, runtime) {
        if (activeBarrier !== barrier) return;
        activeBarrier = null;
        const minimumSequence = Number(snapshot?.snapshotSequence);
        for (const event of barrier.events) {
            if (event?.type?.startsWith('runtime.') || event?.type?.startsWith('approval.')) {
                store.dispatch(event);
                continue;
            }
            if (!eventBelongsToRuntime(event, runtime)) continue;
            if (Number.isFinite(minimumSequence) && Number(event.sequence) <= minimumSequence) continue;
            if (event?.runtime === 'codex' && event?.type === 'projection.updated') {
                applyProjectionEvent(event);
                continue;
            }
            applySessionUiEvent(event);
            projectRuntimeActivity(event);
            store.dispatch(event);
        }
    }

    function projectionFromSnapshot(state, snapshot, sessionId) {
        if (!Array.isArray(snapshot?.messages)) return codexSnapshotToProjection(snapshot);
        return sessionProjectionFromState(state, sessionId)?.projection || codexSnapshotToProjection(snapshot);
    }

    function applyHydratedSnapshot(sessionId, snapshot, runtimeHint, agentId) {
        requireSnapshotSession(snapshot, sessionId);
        const current = store.getState();
        const active = runtimeForSession(sessionId, current) || runtimeHint;
        const durableState = durableSnapshotState(snapshot);
        const durableAgentId = snapshotAgentId(snapshot, durableState, agentId, active);
        const nextRuntime = hydratedRuntime(active, sessionId, durableState, durableAgentId);
        const runtimeSessionId = nextRuntime?.sessionId && String(nextRuntime.sessionId).trim()
            ? nextRuntime.sessionId : sessionId;
        const activeRuntimes = new Map(current.activeRuntimes);
        if (nextRuntime) activeRuntimes.set(runtimeSessionId, { ...nextRuntime, sessionId: runtimeSessionId });
        const normalizedState = applyProjectionSnapshot(current, snapshot);
        const projection = projectionFromSnapshot({ ...current, ...normalizedState }, snapshot, sessionId);
        const selectedSessionId = durableState.sessionId || runtimeSessionId;
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

    async function reconcileHydratedSession(sessionId, runtimeHint, agentId, version) {
        try {
            const snapshot = await requireApi('agentSessionRead')({ sessionId, ...(agentId ? { agentId } : {}) });
            const current = store.getState();
            if (version !== selectionVersion || current.selectedTopic?.sessionId !== sessionId) return null;
            if (!canReconcileSession(sessionId, current)) return null;
            if (snapshotIsStale(sessionId, snapshot, current)) return null;
            applyHydratedSnapshot(sessionId, snapshot, runtimeHint || runtimeForSession(sessionId), agentId);
            return snapshot;
        } catch (_error) {
            return null;
        }
    }

    async function hydrateTopic(sessionId, runtimeHint = null, existingBarrier = null, agentId = undefined) {
        if (!sessionId) return null;
        const version = ++selectionVersion;
        const barrier = existingBarrier || beginSnapshotBarrier();
        try {
            const snapshot = await requireApi('agentSessionReadProjection')({ sessionId, ...(agentId ? { agentId } : {}) });
            if (version !== selectionVersion) {
                releaseSnapshotBarrier(barrier, null, runtimeHint || runtimeForSession(sessionId));
                return null;
            }
            const nextRuntime = applyHydratedSnapshot(sessionId, snapshot, runtimeHint, agentId);
            releaseSnapshotBarrier(barrier, snapshot, nextRuntime);
            if (canReconcileSession(sessionId)) {
                void reconcileHydratedSession(sessionId, runtimeHint, agentId, version);
            }
            return snapshot;
        } catch (error) {
            releaseSnapshotBarrier(barrier, null, runtimeForSession(sessionId));
            throw error;
        }
    }

    async function reconcilePreviewSession(sessionId, agentId, selectedTopic, version) {
        try {
            const snapshot = await requireApi('agentSessionRead')({ sessionId, ...(agentId ? { agentId } : {}) });
            const current = store.getState();
            if (version !== selectionVersion || current.selectedTopic?.sessionId !== sessionId) return null;
            if (snapshotIsStale(sessionId, snapshot, current)) return null;
            const normalizedState = applyProjectionSnapshot(current, snapshot);
            store.setState(normalizedState);
            applyPreviewProjection(
                projectionFromSnapshot(store.getState(), snapshot, sessionId),
                resolvePreviewTopic(snapshot, selectedTopic),
                snapshot?.session?.sessionId,
            );
            return snapshot;
        } catch (_error) {
            return null;
        }
    }

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
        try {
            const snapshot = await requireApi('agentSessionReadProjection')({ sessionId, ...(agentId ? { agentId } : {}) });
            if (version !== selectionVersion) {
                releaseSnapshotBarrier(barrier, null, runtimeForSession(sessionId));
                return null;
            }
            const resolvedTopic = resolvePreviewTopic(snapshot, selectedTopic);
            if (snapshotIsStale(sessionId, snapshot, store.getState())) {
                releaseSnapshotBarrier(barrier, snapshot, runtimeForSession(sessionId));
                return snapshot;
            }
            const normalizedState = applyProjectionSnapshot(store.getState(), snapshot);
            store.setState(normalizedState);
            applyPreviewProjection(
                projectionFromSnapshot(store.getState(), snapshot, sessionId),
                resolvedTopic,
                snapshot?.session?.sessionId,
            );
            releaseSnapshotBarrier(barrier, snapshot, runtimeForSession(sessionId));
            if (canReconcileSession(sessionId)) {
                void reconcilePreviewSession(sessionId, agentId, resolvedTopic, version);
            }
            return snapshot;
        } catch (error) {
            releaseSnapshotBarrier(barrier, null, runtimeForSession(sessionId));
            throw error;
        }
    }

    function clearSelection() {
        selectionVersion += 1;
        if (activeBarrier) releaseSnapshotBarrier(activeBarrier, null, null);
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

    function dispose() {
        selectionVersion += 1;
        if (activeBarrier) releaseSnapshotBarrier(activeBarrier, null, null);
    }

    return {
        activeBarrier: () => activeBarrier,
        beginSnapshotBarrier,
        releaseSnapshotBarrier,
        hydrateTopic,
        previewTopic,
        clearSelection,
        dispose,
    };
}
