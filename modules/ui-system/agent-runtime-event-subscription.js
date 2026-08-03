export function createAgentRuntimeEventSubscription({
    subscribe, snapshotBarrier, store, applyCodexRuntimeEvent, applySessionUiEvent,
    projectRuntimeActivity, refreshStatus,
}) {
    let unsubscribe = null;
    return Object.freeze({
        start() {
            if (unsubscribe || typeof subscribe !== 'function') return;
            unsubscribe = subscribe((event) => {
                const barrier = snapshotBarrier();
                if (barrier) { barrier.events.push(event); return; }
                const current = store.getState();
                if (event?.runtime === 'codex' && event?.type === 'projection.updated') {
                    applyCodexRuntimeEvent(event);
                    return;
                }
                applySessionUiEvent(event);
                projectRuntimeActivity(event);
                const selectedSession = current.selectedSessionId;
                const processGlobal = event?.type?.startsWith('runtime.') || event?.type === 'toolbox.ws';
                if (!event?.type?.startsWith('approval.') && !processGlobal && event?.sessionId
                    && selectedSession && event.sessionId !== selectedSession) {
                    void refreshStatus().catch(() => {});
                    return;
                }
                store.dispatch(event);
            });
        },
        dispose() {
            if (typeof unsubscribe === 'function') unsubscribe();
            unsubscribe = null;
        },
    });
}
