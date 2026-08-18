import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const dom = new JSDOM(`<!doctype html><html data-vcp-ui-surface="main-chat"><body>
  <header class="next-ui-topbar vcp-ui-scope"></header>
  <button id="nextUiHomeTab"></button><button id="nextUiAddTabBtn"></button>
  <div id="nextUiDynamicTabs"></div><div id="nextUiAppGrid"></div>
  <section id="nextUiLaunchpad"></section><main class="container"></main>
</body></html>`, { url: 'http://vcpchat.local/main.html', runScripts: 'outside-only' });

const { window } = dom;
window.ResizeObserver = class {
    observe() {}
    disconnect() {}
};
let allowFeedbackOwner = true;
let scopedFeedbackDisposed = 0;
let globalFeedbackDisposed = 0;
window.VCPUI = {
    feedback: {
        cancelAll() {},
        toast() {},
        dispose() { globalFeedbackDisposed += 1; },
        owner(scope) {
            if (!allowFeedbackOwner) return null;
            let disposed = false;
            const owner = {
                toast() {},
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    scopedFeedbackDisposed += 1;
                    lifecycleEvents.push('feedback:dispose');
                },
            };
            scope?.own(() => owner.dispose(), 'test-feedback-owner', 'feedback-owner');
            return owner;
        },
    },
};
let creates = 0;
let activates = 0;
let closes = 0;
const lifecycleEvents = [];
let resolveDeferredClose = null;
let embeddedStateListener = null;
let deferNextOverlayHide = false;
let resolveDeferredOverlayHide = null;
let failNextOverlayHide = false;
const authoritativeSessions = new Set();
window.chatAPI = {
    desktopCreateEmbeddedVchatApp: async action => {
        creates += 1;
        lifecycleEvents.push('create');
        authoritativeSessions.add(action);
        return { success: true };
    },
    desktopListEmbeddedVchatApps: async () => ({
        sessions: [...authoritativeSessions].map(action => ({ action })),
        activeAction: null,
    }),
    desktopActivateEmbeddedVchatApp: async action => {
        activates += 1;
        lifecycleEvents.push(`activate:${action ?? 'none'}`);
        if (action == null && failNextOverlayHide) {
            failNextOverlayHide = false;
            throw new Error('controlled overlay hide failure');
        }
        if (action == null && deferNextOverlayHide) {
            deferNextOverlayHide = false;
            await new Promise(resolve => { resolveDeferredOverlayHide = resolve; });
        }
        return { success: true };
    },
    desktopSetEmbeddedVchatAppBounds: async () => ({ success: true }),
    desktopCloseEmbeddedVchatApp: async action => {
        closes += 1;
        authoritativeSessions.delete(action);
        return { success: true };
    },
    desktopCloseAllEmbeddedVchatApps: async () => {
        closes += 1;
        lifecycleEvents.push('close-all:start');
        await new Promise(resolve => { resolveDeferredClose = resolve; });
        authoritativeSessions.clear();
        lifecycleEvents.push('close-all:done');
        return { success: true };
    },
    onEmbeddedVchatAppState: listener => {
        embeddedStateListener = listener;
        return () => { embeddedStateListener = null; };
    },
};
window.trayManager = {
    getApps: () => [{ id: 'translator', action: 'open-translator-window', name: '翻译', icon: 'translator', embed: true }],
    getIcon: () => '<svg></svg>',
};
const failingInternalApp = {
    id: 'failing-cleanup',
    title: 'Failing cleanup fixture',
    icon: 'warning',
    kind: 'internal',
    mount: () => () => { throw new Error('expected fixture cleanup failure'); },
    unmount() {}
};
let removableDisposed = 0;
const removableInternalApp = {
    id: 'removable-fixture',
    title: 'Removable fixture',
    icon: 'close',
    kind: 'internal',
    mount: () => () => { removableDisposed += 1; },
    unmount() {}
};
const availableInternalApps = new Set([failingInternalApp.id, removableInternalApp.id]);
window.nextUiApps = {
    list: () => [failingInternalApp, removableInternalApp].filter(app => availableInternalApps.has(app.id)),
    get: id => [failingInternalApp, removableInternalApp].find(app => availableInternalApps.has(app.id) && app.id === id) || null,
};
window.sessionStorage.setItem('vcpchat.nextUi.openTabs.v1', JSON.stringify({
    activeViewId: 'app:translator',
    tabs: [{ kind: 'embedded', id: 'translator' }],
}));

window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/lifecycle-scope.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/overlay-coordinator.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/escape-dispatcher.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/embedded-app-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/app-tab-host.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/assistant-search-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/account-menu-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/notification-menu-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/launchpad-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/creation-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/ui-system/next-shell/next-shell-controller.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(root, 'modules/topTabManager.js'), 'utf8'));
window.topTabManager.init();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(window.topTabManager.isMounted(), true, 'the canonical shell must mount the tab host');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 1, 'the canonical shell must have exactly one tab-host owner');
assert.equal(window.VCPLifecycle.diagnostics.find('next:app-grid').length, 1, 'the canonical shell must own one app-grid render lifetime');
window.dispatchEvent(new window.CustomEvent('next-ui-apps-changed', { detail: { action: 'registered', id: 'fixture' } }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.VCPLifecycle.diagnostics.find('next:app-grid').length, 1, 'app-grid rerenders must retract the previous render owner');
assert.equal(creates, 1, 'the canonical shell may restore the saved embedded session once');
embeddedStateListener?.({ action: 'open-translator-window', state: 'closed' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(
    window.document.querySelector('[data-view-id="app:translator"]'),
    'a stale close event must not remove a session that Main still reports as open',
);
const restoredTab = window.document.querySelector('#nextUiDynamicTabs [role="tab"]');
assert.equal(restoredTab?.tagName, 'DIV', 'dynamic tab hosts must not be nested buttons');
assert.equal(restoredTab?.querySelector('.next-ui-tab-close')?.tagName, 'BUTTON', 'tab close must remain a native button');
assert.equal(restoredTab?.getAttribute('aria-selected'), 'true');
assert.equal(restoredTab?.tabIndex, 0);
const activationsBeforeKeyboard = activates;
restoredTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(activates > activationsBeforeKeyboard, 'Enter must activate a focused dynamic tab');

const overlayOwner = Symbol('test-overlay');
await window.topTabManager.acquireOverlay(overlayOwner);
assert.equal(lifecycleEvents.at(-1), 'activate:none', 'DOM overlays must hide native WebContentsViews before mounting');
window.topTabManager.setView('app:translator');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(lifecycleEvents.at(-1), 'activate:none', 'view changes must not reactivate native content while an overlay lease is held');
window.topTabManager.releaseOverlay(overlayOwner);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(lifecycleEvents.at(-1), 'activate:open-translator-window', 'releasing the final overlay lease must restore the active embedded view');

deferNextOverlayHide = true;
const delayedOverlayOwner = Symbol('delayed-overlay');
const delayedAcquire = window.topTabManager.acquireOverlay(delayedOverlayOwner);
await new Promise(resolve => setTimeout(resolve, 0));
window.topTabManager.releaseOverlay(delayedOverlayOwner);
resolveDeferredOverlayHide?.();
await delayedAcquire;
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(
    lifecycleEvents.at(-1),
    'activate:open-translator-window',
    'a hide IPC that settles after lease release must reconcile back to the active embedded view'
);

const failedOverlayModal = window.document.createElement('div');
failedOverlayModal.id = 'globalSettingsModal';
failedOverlayModal.className = 'modal active';
window.document.body.append(failedOverlayModal);
failNextOverlayHide = true;
window.document.dispatchEvent(new window.CustomEvent('modal-visibility-changed', {
    detail: { modalId: failedOverlayModal.id, root: failedOverlayModal, generation: 1, active: true },
}));
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(failedOverlayModal.classList.contains('active'), false,
    'a failed native hide must atomically close the affected renderer modal');
assert.equal(window.VCPNextShellController.getDiagnostics().overlay.active, false,
    'a failed native hide must not retain an overlay lease');
failedOverlayModal.remove();

// A failed hide from a closed generation must not close a newly opened modal
// with the same id. This exercises the real coordinator → shell event bridge.
const staleOverlayModal = window.document.createElement('div');
staleOverlayModal.id = 'globalSettingsModal';
staleOverlayModal.className = 'modal active';
window.document.body.append(staleOverlayModal);
failNextOverlayHide = true;
window.document.dispatchEvent(new window.CustomEvent('modal-visibility-changed', {
    detail: { modalId: staleOverlayModal.id, root: staleOverlayModal, generation: 10, active: true },
}));
window.document.dispatchEvent(new window.CustomEvent('modal-visibility-changed', {
    detail: { modalId: staleOverlayModal.id, root: staleOverlayModal, generation: 10, active: false },
}));
staleOverlayModal.remove();
await new Promise(resolve => setImmediate(resolve));
const reopenedOverlayModal = window.document.createElement('div');
reopenedOverlayModal.id = 'globalSettingsModal';
reopenedOverlayModal.className = 'modal active';
window.document.body.append(reopenedOverlayModal);
window.document.dispatchEvent(new window.CustomEvent('modal-visibility-changed', {
    detail: { modalId: reopenedOverlayModal.id, root: reopenedOverlayModal, generation: 11, active: true },
}));
await new Promise(resolve => setImmediate(resolve));
assert.equal(reopenedOverlayModal.classList.contains('active'), true,
    'a late failure from a closed modal generation must not close its replacement');
const reopenedOverlaySnapshot = window.VCPNextShellController.getDiagnostics().overlay;
assert.equal(reopenedOverlaySnapshot.active, true, 'the replacement modal must retain the overlay lease');
assert.deepEqual(Array.from(reopenedOverlaySnapshot.modalIds), ['globalSettingsModal'],
    'overlay ownership must point at the current modal generation only');
window.document.dispatchEvent(new window.CustomEvent('modal-visibility-changed', {
    detail: { modalId: reopenedOverlayModal.id, root: reopenedOverlayModal, generation: 11, active: false },
}));
await new Promise(resolve => setImmediate(resolve));
assert.equal(window.VCPNextShellController.getDiagnostics().overlay.active, false,
    'closing the replacement modal must release its generation lease');
reopenedOverlayModal.remove();

const lifecycleUnmount = window.topTabManager.unmount();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.topTabManager.isMounted(), false, 'explicit lifecycle teardown must unmount the tab host');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 1,
    'the tab-host owner must remain quiescing while native embedded teardown is pending');
assert.equal(window.VCPLifecycle.diagnostics.find('next:app-grid').length, 1,
    'app-grid listeners must remain owned until native embedded teardown settles');
assert.ok(closes >= 1, 'teardown must close native embedded sessions');
assert.ok(
    lifecycleEvents.indexOf('activate:none') < lifecycleEvents.indexOf('close-all:start'),
    'teardown must hide the native view before closing its session',
);

const lifecycleRemount = window.topTabManager.mount();
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(creates, 1, 'remount must wait for the previous native teardown');
resolveDeferredClose?.();
await lifecycleUnmount;
await lifecycleRemount;
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(creates, 2, 'remount must restore the preserved tab session once');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 1, 'remount must create one fresh owner');
assert.equal(scopedFeedbackDisposed, 1,
    'the scoped feedback owner must be disposed after native app teardown settles');
assert.ok(
    lifecycleEvents.indexOf('close-all:done') < lifecycleEvents.indexOf('feedback:dispose'),
    'scoped feedback must dispose only after native embedded sessions finish closing',
);

// A missing owner is a supported fallback path. It may use the global
// singleton for presentation, but must never dispose that shared singleton
// while tearing down the Next shell.
allowFeedbackOwner = false;

window.topTabManager.openInternalApp(removableInternalApp.id);
assert.ok(window.document.querySelector('[data-view-id="app:removable-fixture"]'), 'registered internal app must open in the tab host');
availableInternalApps.delete(removableInternalApp.id);
window.dispatchEvent(new window.CustomEvent('next-ui-apps-changed', {
    detail: { action: 'unregistered', id: removableInternalApp.id }
}));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(window.document.querySelector('[data-view-id="app:removable-fixture"]'), null,
    'unregistering an open internal app must close its view and surface');
assert.equal(removableDisposed, 1, 'unregistering an open app must dispose its mounted surface exactly once');
window.topTabManager.openInternalApp(failingInternalApp.id);
const originalConsoleError = window.console.error;
const expectedTeardownErrors = [];
window.console.error = (...args) => expectedTeardownErrors.push(args);
const finalUnmount = window.topTabManager.unmount();
await new Promise(resolve => setTimeout(resolve, 0));
resolveDeferredClose?.();
await assert.doesNotReject(finalUnmount, 'one failing app disposer must not block canonical lifecycle teardown');
window.console.error = originalConsoleError;
assert.ok(expectedTeardownErrors.length >= 1, 'cleanup failures must remain observable after transition recovery');
assert.equal(window.VCPLifecycle.diagnostics.find('next:tab-host').length, 0, 'final teardown must leave no tab-host owner');
assert.equal(globalFeedbackDisposed, 0,
    'fallback feedback must not dispose the shared global singleton');

console.log('Next UI tab lifecycle checks passed.');
