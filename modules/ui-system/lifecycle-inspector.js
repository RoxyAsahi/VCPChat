/* Read-only diagnostics for Next UI ownership; contains no user content. */
(function installLifecycleInspector(globalObject) {
    'use strict';
    if (!globalObject || globalObject.VCPLifecycleInspector) return;
    let streamDiagnosticsProvider = null;

    function snapshot() {
        const scopes = globalObject.VCPLifecycle?.diagnostics?.snapshot?.() || [];
        return Object.freeze({
            at: Date.now(),
            mode: 'next',
            scopes: Object.freeze(scopes),
            stalledScopes: Object.freeze(scopes.filter(scope => scope.state === 'disposing' && scope.disposingMs > 5_000)),
            scopeSummary: globalObject.VCPLifecycle?.diagnostics?.summary?.() || null,
            tasks: Object.freeze(globalObject.VCPTasks?.diagnostics?.snapshot?.() || []),
            contributions: globalObject.VCPContributions?.diagnostics?.snapshot?.() || null,
            states: Object.freeze(globalObject.VCPStateChannels?.diagnostics?.() || []),
            shell: globalObject.VCPNextShellController?.getDiagnostics?.() || null,
            streams: streamDiagnosticsProvider?.() || null,
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

    function setStreamDiagnosticsProvider(provider) {
        if (typeof provider !== 'function') throw new TypeError('Stream diagnostics provider must be a function.');
        if (streamDiagnosticsProvider && streamDiagnosticsProvider !== provider) {
            throw new Error('Stream diagnostics provider is already registered.');
        }
        streamDiagnosticsProvider = provider;
    }

    globalObject.VCPLifecycleInspector = Object.freeze({ snapshot, snapshotMain, setStreamDiagnosticsProvider });
})(typeof window !== 'undefined' ? window : null);
