import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    buildAgentConfigDiagnostics,
    diagnosticSummary,
    normalizeDiagnosticError,
} from '../modules/ui-system/agent-config-diagnostics.js';
import { createAgentSettingsDiagnosticsCoordinator } from '../modules/ui-system/agent-settings-diagnostics-coordinator.js';
import { createAgentSettingsDiagnosticsView } from '../modules/ui-system/agent-settings-diagnostics-view.js';
import { createAgentSettingsAdvancedView } from '../modules/ui-system/agent-settings-advanced-view.js';
import { createAgentSettingsAdvancedFeature } from '../modules/ui-system/agent-settings-advanced-feature.js';
import { createAgentSettingsBudgetView } from '../modules/ui-system/agent-settings-budget-view.js';
import { createAgentSettingsState, sessionSettingsTarget } from '../modules/ui-system/agent-settings-state.js';

const secretPrompt = 'do not include this complete prompt in diagnostics';
const model = buildAgentConfigDiagnostics({
    runtime: {
        state: 'idle', generation: 7,
        toolbox: {
            configured: true,
            endpoint: 'http://user:password@localhost:6005/v1/chat/completions?api_key=secret',
        },
        lastError: {
            code: 'UPSTREAM_FAILED', message: 'ToolBox rejected the request',
            details: { apiKey: 'secret-key', path: 'C:\\private\\attachment.png', retryable: true },
        },
    },
    session: {
        sessionId: 'session-a', threadId: 'thread-a', configRevision: 4,
        appliedRuntimeConfigRevision: 3, configApplyState: 'error',
        configApplyError: 'Codex did not confirm settings',
        configSnapshot: {
            model: 'deepseek-v4-flash', permissionMode: 'always-approve',
            workspaceRoot: 'C:\\workspace\\project-a', baseInstructions: secretPrompt,
        },
        appliedRuntimeConfig: {
            model: 'old-model', permissionMode: 'ask',
            workspaceRoot: 'C:\\workspace\\old-project', baseInstructions: 'old secret prompt',
        },
    },
});
assert.equal(model.endpoint, 'http://localhost:6005/v1/chat/completions');
assert.equal(model.differences.find((item) => item.key === 'workspaceRoot').desired, '…/project-a');
assert.equal(model.differences.find((item) => item.key === 'baseInstructions').desired,
    `已配置（${secretPrompt.length} 字符）`);
assert.equal(model.runtimeError.details.apiKey, '[redacted]');
assert.equal(model.runtimeError.details.path, '…/attachment.png');
const summary = diagnosticSummary(model);
assert.equal(summary.includes(secretPrompt), false);
assert.equal(summary.includes('secret-key'), false);
assert.equal(summary.includes('C:\\workspace'), false);
assert.equal(summary.includes('password@'), false);
assert.match(summary, /deepseek|配置|differences/i);

const authoritativeModel = buildAgentConfigDiagnostics({
    authoritative: {
        sessionId: 'session-authoritative', threadId: 'thread-authoritative',
        desiredConfig: { model: 'deepseek-v4-flash', permissionMode: 'always-approve' },
        appliedRuntimeConfig: { model: 'deepseek-v4-flash', permissionMode: 'always-approve' },
        configRevision: 5, appliedRuntimeConfigRevision: 5, applyState: 'applied',
        runtime: {
            state: 'idle', generation: 9, protocol: 'codex-app-server-jsonl',
            thread: { activity: 'idle', observedStatus: 'idle' },
            projection: { lastReconciledAt: 1234, error: null },
            storage: { schemaVersion: 12, readOnly: false, error: null },
        },
        toolbox: {
            configured: true, endpoint: 'http://localhost:6005/v1/chat/completions',
            adapter: { state: 'ready', activeRequestCount: 0, recentRequests: [{
                model: 'deepseek-v4-flash', status: 'completed', httpStatus: 200, durationMs: 204,
                incomingTools: [{ type: 'function', name: 'shell_command' }, { type: 'function', name: 'vcp_invoke' }],
                forwardedTools: [{ type: 'function', name: 'vcp_invoke' }], error: null,
            }] },
        },
        modelCatalog: { cachedCount: 18, selectedModel: 'deepseek-v4-flash', selectedModelAvailable: true },
        applyBarrier: { waiting: false, revision: 0, runtimeGeneration: 0, fields: [] },
    },
});
assert.equal(authoritativeModel.endpoint, 'http://localhost:6005/v1/chat/completions');
assert.equal(authoritativeModel.adapterState, 'ready');
assert.equal(authoritativeModel.adapterLastRequest.forwardedTools[0].name, 'vcp_invoke');
assert.equal(authoritativeModel.modelCatalogCount, 18);
assert.equal(authoritativeModel.selectedModelAvailable, true);
assert.equal(authoritativeModel.threadRecoveryState, 'confirmed');
assert.equal(authoritativeModel.projectionLastReconciledAt, 1234);
assert.match(diagnosticSummary(authoritativeModel), /incoming 2 · forwarded vcp_invoke/);
assert.match(diagnosticSummary(authoritativeModel), /thread: idle · observed idle · recovery confirmed/);

const redactedAuthoritativeModel = buildAgentConfigDiagnostics({
    authoritative: {
        sessionId: 'session-redacted', threadId: 'thread-redacted',
        desiredConfig: {
            baseInstructions: { redactedType: 'instruction', configured: true, length: 42 },
            workspaceRoot: { redactedType: 'workspace', configured: true, display: '…/project-a' },
        },
        appliedRuntimeConfig: {
            baseInstructions: { redactedType: 'instruction', configured: true, length: 20 },
            workspaceRoot: { redactedType: 'workspace', configured: true, display: '…/old-project' },
        },
        configDifferenceFields: ['baseInstructions', 'workspaceRoot'],
    },
});
assert.equal(redactedAuthoritativeModel.differences[0].desired, '已配置（42 字符）');
assert.equal(redactedAuthoritativeModel.differences[1].desired, '…/project-a');

const structured = normalizeDiagnosticError({
    code: 'SESSION_CONFIG_CONFLICT', message: 'stale',
    details: { current: { baseInstructions: secretPrompt, model: 'deepseek-v4-flash' } },
});
assert.equal(structured.code, 'SESSION_CONFIG_CONFLICT');
assert.equal(structured.details.current.baseInstructions, '[redacted]');

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { document } = dom.window;
const calls = [];
const diagnosticsView = createAgentSettingsDiagnosticsView({
    document,
    actions: {
        refresh: () => calls.push('refresh'),
        reapply: () => calls.push('reapply'),
        copy: (value) => calls.push(['copy', value]),
    },
});
const diagnosticsElement = diagnosticsView.update(model, { loading: false, applying: false });
assert.equal(diagnosticsElement, diagnosticsView.element);
assert.match(diagnosticsElement.textContent, /已保存 r4 · Runtime r3/);
assert.match(diagnosticsElement.textContent, /UPSTREAM_FAILED/);
assert.match(diagnosticsElement.textContent, /影响/);
assert.match(diagnosticsElement.textContent, /下一步/);
assert.equal(diagnosticsElement.textContent.includes(secretPrompt), false);
assert.equal(diagnosticsElement.querySelector('.agent-chat-config-health').dataset.healthTone, 'error');
assert.ok(Number(diagnosticsElement.querySelector('.agent-chat-config-health').dataset.issueCount) > 0);
assert.ok([...diagnosticsElement.querySelectorAll('.agent-chat-config-error-header code')]
    .some((code) => code.textContent === 'UPSTREAM_FAILED' && code.title === 'UPSTREAM_FAILED'),
'ellipsized diagnostic error codes must expose the complete value as a tooltip');
const connectionDetails = diagnosticsElement.querySelector('.agent-chat-config-diagnostic-details');
assert.equal(connectionDetails.open, false, 'technical connection identity must be collapsed by default');
assert.equal(connectionDetails.querySelector('.agent-chat-config-value').title, 'session-a');
const diagnosticButtons = [...diagnosticsElement.querySelectorAll('button')];
diagnosticButtons[0].click();
diagnosticButtons[1].click();
diagnosticButtons[2].click();
assert.deepEqual(calls.slice(0, 2), ['refresh', 'reapply']);
assert.equal(calls[2][0], 'copy');
assert.equal(calls[2][1].includes(secretPrompt), false);
diagnosticsView.update(authoritativeModel, { loading: false, applying: false });
assert.match(diagnosticsElement.textContent, /最近一次 Adapter 请求/);
assert.match(diagnosticsElement.textContent, /Thread 状态/);
assert.match(diagnosticsElement.textContent, /recovery confirmed/);
assert.match(diagnosticsElement.textContent, /输入 2 个 · 转发 vcp_invoke/);
assert.equal(diagnosticsElement.querySelector('.agent-chat-config-health').dataset.healthTone, 'success');

const unconfirmedModel = buildAgentConfigDiagnostics({
    authoritative: {
        sessionId: 'session-unconfirmed', threadId: 'thread-unconfirmed',
        desiredConfig: {}, appliedRuntimeConfig: {}, configRevision: 1,
        appliedRuntimeConfigRevision: 1, applyState: 'applied',
        runtime: {
            state: 'ready', generation: 10,
            thread: { activity: 'unknown', observedStatus: 'active', recoveryState: 'unconfirmed' },
            projection: { error: null },
            storage: { schemaVersion: 12, readOnly: false, error: null },
        },
    },
});
diagnosticsView.update(unconfirmedModel, { loading: false, applying: false });
assert.equal(diagnosticsElement.querySelector('.agent-chat-config-health').dataset.healthTone, 'warning');
assert.match(diagnosticsElement.textContent, /运行状态尚未确认/);
const projectionErrorModel = buildAgentConfigDiagnostics({
    authoritative: {
        sessionId: 'session-projection-error', threadId: 'thread-projection-error',
        desiredConfig: {}, appliedRuntimeConfig: {}, configRevision: 1,
        appliedRuntimeConfigRevision: 1, applyState: 'applied',
        runtime: {
            state: 'ready', generation: 10,
            thread: { activity: 'idle', observedStatus: 'idle', recoveryState: 'confirmed' },
            projection: { error: { code: 'RECONCILE_FAILED', message: 'mismatched Thread' } },
            storage: { schemaVersion: 12, readOnly: false, error: null },
        },
    },
});
diagnosticsView.update(projectionErrorModel, { loading: false, applying: false });
assert.equal(diagnosticsElement.querySelector('.agent-chat-config-health').dataset.healthTone, 'error');
assert.match(diagnosticsElement.textContent, /Projection 对账错误/);

const budgetSaves = [];
const budgetView = createAgentSettingsBudgetView({
    document,
    actions: { save: (value) => budgetSaves.push(value) },
});
budgetView.update({ maxRequestsPerTurn: null, maxTokensPerTurn: null });
const budgetInputs = [...budgetView.element.querySelectorAll('input')];
budgetInputs[0].value = '4';
budgetInputs[0].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
budgetInputs[1].value = '12000';
budgetInputs[1].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
assert.deepEqual(budgetSaves.at(-1), { maxRequestsPerTurn: '4', maxTokensPerTurn: '12000' },
    'independent budget inputs must merge instead of overwriting each other');

const advancedView = createAgentSettingsAdvancedView({
    document,
    diagnosticsView,
    actions: {},
});
const advancedElement = advancedView.update({
    diagnostics: model,
    diagnosticsRequest: {},
    state: {
        budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
        recoveryOperations: [], recoveryThreads: [], recoveryLoading: false, recoveryError: '',
    },
});
assert.equal(advancedElement, advancedView.element);
assert.match(advancedElement.textContent, /配置与 Runtime 诊断/);
assert.match(advancedElement.textContent, /一致性恢复/);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

let storeState = {
    selectedSessionId: 'session-a',
    selectedTopic: { sessionId: 'session-a', threadId: 'thread-a', configSnapshot: {} },
    runtime: {},
};
const state = {
    settingsSaveByScope: new Map(),
    settingsDiagnostics: { sessionId: '', state: 'idle', config: null, error: null, requestId: 0, readAt: 0 },
};
const settingsState = createAgentSettingsState({ delayMs: 5 });
const sessionASettings = sessionSettingsTarget('session-a');
const sessionBSettings = sessionSettingsTarget('session-b');
const sessionAConflict = Object.assign(new Error('Session A stale revision'), {
    code: 'SESSION_CONFIG_CONFLICT',
});
await assert.rejects(() => settingsState.enqueue(sessionASettings, { model: 'new-a' }, async () => {
    throw sessionAConflict;
}), (error) => error.code === 'SESSION_CONFIG_CONFLICT');
const reads = { a: deferred(), b: deferred() };
const readCalls = [];
let controlPlaneRefreshes = 0;
const coordinator = createAgentSettingsDiagnosticsCoordinator({
    state,
    store: { getState: () => storeState },
    settingsState,
    controller: {
        readSessionDiagnostics: (sessionId) => {
            readCalls.push(sessionId);
            return reads[sessionId === 'session-a' ? 'a' : 'b'].promise;
        },
        reapplySessionConfig: async (sessionId) => ({
            sessionId, threadId: `thread-${sessionId}`, desiredConfig: {}, appliedRuntimeConfig: {},
            configRevision: 2, appliedRuntimeConfigRevision: 2, applyState: 'applied',
        }),
    },
    refreshControlPlane: async () => { controlPlaneRefreshes += 1; },
});
const loadA = coordinator.load();
storeState = {
    ...storeState,
    selectedSessionId: 'session-b',
    selectedTopic: { sessionId: 'session-b', threadId: 'thread-b', configSnapshot: {} },
};
const loadB = coordinator.syncSelection({ visible: true });
assert.equal(readCalls.at(-1), 'session-b',
    'switching Sessions while Advanced is visible must read the new authoritative config');
assert.equal(coordinator.current().model.saveError, null,
    'Session A save conflicts must not leak into Session B diagnostics');
reads.b.resolve({
    sessionId: 'session-b', threadId: 'thread-b', desiredConfig: {}, appliedRuntimeConfig: {},
    configRevision: 3, appliedRuntimeConfigRevision: 3, applyState: 'applied',
});
await loadB;
reads.a.resolve({
    sessionId: 'session-a', threadId: 'thread-a', desiredConfig: {}, appliedRuntimeConfig: {},
    configRevision: 9, appliedRuntimeConfigRevision: 9, applyState: 'applied',
});
assert.equal(await loadA, null, 'a stale Session A response must not commit after selection moved to B');
assert.equal(state.settingsDiagnostics.sessionId, 'session-b');
assert.equal(state.settingsDiagnostics.config.configRevision, 3);
assert.equal(settingsState.status(sessionBSettings).state, 'idle');
await coordinator.load({ reapply: true });
assert.equal(controlPlaneRefreshes, 1);
assert.equal(state.settingsDiagnostics.sessionId, 'session-b');

coordinator.dispose();
settingsState.dispose();
advancedView.dispose();

const featureErrors = [];
const featureState = {
    selectedAgent: 'Nova',
    budget: { maxRequestsPerTurn: null, maxTokensPerTurn: null },
    recoveryOperations: [], recoveryThreads: [], recoveryLoading: false, recoveryError: '',
    settingsSaveByScope: new Map(),
    settingsDiagnostics: { sessionId: '', state: 'idle', config: null, error: null, requestId: 0, readAt: 0 },
};
const featureStore = {
    getState: () => ({
        selectedSessionId: 'session-copy',
        selectedTopic: { sessionId: 'session-copy', threadId: 'thread-copy', configSnapshot: {} },
        runtime: {},
    }),
    subscribe: () => () => {},
};
const feature = createAgentSettingsAdvancedFeature({
    state: featureState,
    store: featureStore,
    settingsState: createAgentSettingsState({ delayMs: 5 }),
    controller: {
        readSessionDiagnostics: async () => ({
            sessionId: 'session-copy', threadId: 'thread-copy', desiredConfig: {}, appliedRuntimeConfig: {},
            configRevision: 1, appliedRuntimeConfigRevision: 1, applyState: 'applied',
        }),
    },
    document,
    lifecycle: { timeout() {} },
    host: { clipboard: {}, feedback: { confirm: async () => false } },
    run: async (work) => {
        try { await work(); } catch (error) { featureErrors.push(error); }
    },
    notify() {},
    refreshControlPlane: async () => {},
    renderSidebar() {},
    persistWorkbenchSettings: async () => {},
    refreshRecoveryOperations: async () => {},
    refreshTopicsForAgent: async () => {},
});
const featureDiagnostics = feature.current();
feature.view.update({
    state: featureState,
    diagnostics: featureDiagnostics.model,
    diagnosticsRequest: featureDiagnostics.request,
});
[...feature.view.element.querySelectorAll('button')]
    .find((control) => control.textContent.includes('复制脱敏诊断')).click();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.match(featureErrors[0]?.message || '', /无法访问系统剪贴板/);
feature.dispose();
budgetView.dispose();

assert.equal(advancedView.element.childElementCount, 0);
dom.window.close();
console.log('Agent config diagnostics tests passed.');
