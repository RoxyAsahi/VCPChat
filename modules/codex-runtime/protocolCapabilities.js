'use strict';

const fixture = require('../../fixtures/codex-app-server-v0.146.json');

const TOOLBOX_ONLY = 'toolbox-only';
const CODEX_NATIVE = 'codex-native';
const CODEX_NATIVE_LEGACY = 'codex-native-legacy';
const NATIVE_APPROVAL_METHODS = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
]);
const LEGACY_NATIVE_APPROVAL_METHODS = new Set([
    'applyPatchApproval',
    'execCommandApproval',
]);
const INTERACTIVE_METHODS = new Map([
    ['item/tool/requestUserInput', 'user-input'],
    ['item/permissions/requestApproval', 'permission'],
    ['mcpServer/elicitation/request', 'mcp-elicitation'],
]);

function versionMatchesFixture(version) {
    return typeof version === 'string' && version.startsWith(`${fixture.codexVersionLine}.`);
}

function capabilityMatrix(profile = TOOLBOX_ONLY) {
    const toolboxOnly = profile === TOOLBOX_ONLY;
    return {
        protocol: fixture.protocol,
        codexVersionLine: fixture.codexVersionLine,
        sourceRevision: fixture.sourceRevision,
        executionProfile: profile,
        clientMethods: fixture.clientMethods,
        notifications: fixture.notifications,
        items: fixture.items,
        serverRequests: Object.fromEntries(Object.entries(fixture.serverRequests).map(([method, mode]) => {
            let state = mode;
            if (mode === 'native-only' || mode === 'legacy-native-only') {
                state = toolboxOnly ? 'disabled' : 'supported';
            }
            if (mode === 'dynamic-vcp-invoke-only') state = 'supported';
            if (mode === 'interactive') state = 'supported';
            return [method, state];
        })),
    };
}

function serverRequestPolicy(method, profile = TOOLBOX_ONLY) {
    const value = fixture.serverRequests[method];
    if (method === 'item/tool/call') {
        return { state: 'supported', kind: 'dynamic-tool' };
    }
    if (NATIVE_APPROVAL_METHODS.has(method)) {
        return profile === TOOLBOX_ONLY
            ? { state: 'disabled', reason: 'Codex native execution is disabled by the toolbox-only profile' }
            : { state: 'supported', kind: 'native-approval' };
    }
    if (LEGACY_NATIVE_APPROVAL_METHODS.has(method)) {
        return profile === TOOLBOX_ONLY
            ? { state: 'disabled', reason: 'Legacy Codex native execution is disabled by the toolbox-only profile' }
            : { state: 'supported', kind: 'legacy-native-approval' };
    }
    if (INTERACTIVE_METHODS.has(method)) {
        return { state: 'supported', kind: INTERACTIVE_METHODS.get(method) };
    }
    if (value === 'unsupported') {
        return { state: 'unsupported', reason: `Codex server request is not enabled: ${method}` };
    }
    return { state: 'unsupported', reason: `Unknown Codex server request: ${method || '(empty)'}` };
}

function failClosedServerRequestResponse(method) {
    if (NATIVE_APPROVAL_METHODS.has(method)) return { decision: 'decline' };
    if (LEGACY_NATIVE_APPROVAL_METHODS.has(method)) return { decision: 'abort' };
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null, _meta: null };
    return null;
}

function isNativeProfile(profile) {
    return profile === CODEX_NATIVE || profile === CODEX_NATIVE_LEGACY;
}

module.exports = {
    CODEX_NATIVE,
    CODEX_NATIVE_LEGACY,
    TOOLBOX_ONLY,
    capabilityMatrix,
    failClosedServerRequestResponse,
    isNativeProfile,
    serverRequestPolicy,
    versionMatchesFixture,
};
