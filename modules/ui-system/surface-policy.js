/* Canonical document capability marker for the unified main chat surface. */
(function installSurfacePolicy(globalObject) {
    'use strict';
    if (!globalObject || globalObject.VCPSurfacePolicy) return;
    const isMainChat = (documentObject = globalObject.document) => {
        const root = documentObject?.documentElement;
        return root?.dataset?.vcpUiSurface === 'main-chat';
    };
    globalObject.VCPSurfacePolicy = Object.freeze({
        isMainChat,
        marker: 'main-chat'
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
