/* Read-only diagnostics for Next UI ownership; contains no user content. */
(function installLifecycleInspector(globalObject) {
    'use strict';
    if (!globalObject || globalObject.VCPLifecycleInspector) return;
    function snapshot() {
        const scopes = globalObject.VCPLifecycle?.diagnostics?.snapshot?.() || [];
        return Object.freeze({
            at: Date.now(),
            surface: globalObject.VCPSurfacePolicy?.isMainChat?.() === true ? 'main-chat' : 'unknown',
            scopes: Object.freeze(scopes),
            stalledScopes: Object.freeze(scopes.filter(scope => scope.state === 'disposing' && scope.disposingMs > 5_000)),
            scopeSummary: globalObject.VCPLifecycle?.diagnostics?.summary?.() || null,
            tasks: Object.freeze(globalObject.VCPTasks?.diagnostics?.snapshot?.() || []),
            contributions: globalObject.VCPContributions?.diagnostics?.snapshot?.() || null,
            states: Object.freeze(globalObject.VCPStateChannels?.diagnostics?.() || []),
            shell: globalObject.VCPNextShellController?.getDiagnostics?.() || null,
            streams: globalObject.streamManager?.getDiagnostics?.() || null,
            performance: Object.freeze(globalObject.VCPPerformance?.snapshot?.() || []),
        });
    }

    async function snapshotMain() {
        const api = globalObject.chatAPI || globalObject.electronAPI;
        const result = await api?.getMainLifecycleSnapshot?.();
        return Object.freeze({
            embeddedSessions: Object.freeze(result?.embeddedSessions || []),
            activeEmbeddedAction: result?.activeEmbeddedAction || null,
            tasks: Object.freeze(result?.tasks || []),
            chatTasks: Object.freeze(result?.chatTasks || []),
        });
    }

    globalObject.VCPLifecycleInspector = Object.freeze({ snapshot, snapshotMain });
})(typeof window !== 'undefined' ? window : null);
