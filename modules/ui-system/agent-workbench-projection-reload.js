import { applyProjectionSnapshot } from './agent-normalized-store.js';
import { requireSnapshotSession } from './agent-session-state.js';

function createProjectionReloadCoordinator({ store, readProjection, onApplied }) {
    const reloads = new Map();
    let disposed = false;

    function reload(sessionId, targetRevision = 0) {
        const existing = reloads.get(sessionId);
        if (existing) {
            existing.targetRevision = Math.max(existing.targetRevision, Number(targetRevision) || 0);
            return existing.promise;
        }
        const state = { targetRevision: Number(targetRevision) || 0, promise: null };
        state.promise = (async () => {
            try {
                for (let attempt = 0; attempt < 3 && !disposed; attempt += 1) {
                    const snapshot = await readProjection(sessionId);
                    if (disposed) return null;
                    requireSnapshotSession(snapshot, sessionId);
                    const current = store.getState();
                    const currentRevision = Number(current.projectionRevisions?.get(sessionId) || 0);
                    const snapshotRevision = Number(snapshot?.projectionRevision
                        || snapshot?.projection?.mutationGeneration || 0);
                    if (snapshotRevision >= currentRevision) {
                        store.setState(applyProjectionSnapshot(current, snapshot));
                        onApplied(sessionId);
                    }
                    if (Number(store.getState().projectionRevisions?.get(sessionId) || 0)
                        >= state.targetRevision) return snapshot;
                }
            } catch (_error) {
                // The next durable Session read remains the recovery path.
            }
            return null;
        })().finally(() => reloads.delete(sessionId));
        reloads.set(sessionId, state);
        return state.promise;
    }

    function dispose() {
        disposed = true;
        reloads.clear();
    }

    return { reload, dispose };
}

export { createProjectionReloadCoordinator };
