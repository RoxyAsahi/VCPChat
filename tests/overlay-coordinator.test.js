const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { OverlayCoordinator } = require('../modules/ui-system/next-shell/overlay-coordinator.js');

function createFixture(overrides = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="globalSettingsModal" class="modal active"></div></body>');
    const stateEvents = [];
    const calls = { hide: 0, reconcile: 0 };
    dom.window.document.addEventListener('next-ui-overlay-changed', event => stateEvents.push(event.detail.active));
    const coordinator = new OverlayCoordinator({
        document: dom.window.document,
        hideEmbeddedView: async () => { calls.hide += 1; },
        reconcileEmbeddedView: () => { calls.reconcile += 1; },
        ...overrides,
    });
    return { dom, coordinator, calls, stateEvents };
}

test('visible modals acquire one lease and close events release it', async () => {
    const { dom, coordinator, calls, stateEvents } = createFixture();
    coordinator.mount();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.active, true);
    assert.equal(calls.hide, 1);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', active: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.hide, 1, 'duplicate visibility events must not duplicate a modal lease');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', active: false },
    }));
    assert.equal(coordinator.active, false);
    assert.deepEqual(stateEvents, [true, false]);
    assert.equal(calls.reconcile, 1);
    coordinator.dispose();
});

test('a released lease reconciles after a delayed hide settles', async () => {
    let settleHide;
    const { coordinator, calls, stateEvents } = createFixture({
        hideEmbeddedView: () => new Promise(resolve => { settleHide = resolve; }),
    });
    coordinator.document.querySelector('.modal').classList.remove('active');
    coordinator.mount();
    const owner = Symbol('delayed');
    const pending = coordinator.acquire(owner);
    coordinator.release(owner);
    assert.equal(calls.reconcile, 1);
    settleHide();
    await pending;
    assert.equal(calls.reconcile, 2, 'late hide completion must reconcile the selected native view again');
    assert.deepEqual(stateEvents, [true, false]);
    coordinator.dispose();
});

test('dispose clears leases, retracts fallback listeners and is idempotent', async () => {
    const { dom, coordinator, calls, stateEvents } = createFixture();
    coordinator.document.querySelector('.modal').classList.remove('active');
    coordinator.mount();
    await coordinator.acquire(Symbol('owned'));
    const reconcilesBeforeDispose = calls.reconcile;
    coordinator.dispose();
    coordinator.dispose();
    assert.equal(coordinator.active, false);
    assert.equal(calls.reconcile, reconcilesBeforeDispose + 1, 'disposing an active coordinator restores the embedded view');
    assert.deepEqual(stateEvents, [true, false]);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'late', active: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.hide, 1, 'disposed coordinator must not respond to later modal events');
});

test('concurrent leases share one hide transition', async () => {
    let resolveHide;
    const { coordinator, calls } = createFixture({
        hideEmbeddedView: () => new Promise(resolve => { calls.hide += 1; resolveHide = resolve; }),
    });
    coordinator.mount();
    const first = coordinator.acquire(Symbol('first'));
    const second = coordinator.acquire(Symbol('second'));
    assert.equal(calls.hide, 1, 'two owners share one in-flight hide operation');
    resolveHide();
    await Promise.all([first, second]);
    coordinator.dispose();
});

test('stale modal generation cannot release a newer modal lease', async () => {
    const { dom, coordinator } = createFixture();
    coordinator.document.querySelector('.modal').classList.remove('active');
    coordinator.mount();
    const oldRoot = dom.window.document.createElement('div');
    const newRoot = dom.window.document.createElement('div');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', active: true, root: oldRoot, generation: 1 },
    }));
    await new Promise(resolve => setImmediate(resolve));
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', active: true, root: newRoot, generation: 2 },
    }));
    await new Promise(resolve => setImmediate(resolve));
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', active: false, root: oldRoot, generation: 1 },
    }));
    assert.equal(coordinator.active, true, 'old close event cannot release the new generation');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', active: false, root: newRoot, generation: 2 },
    }));
    assert.equal(coordinator.active, false);
    coordinator.dispose();
});

test('modal activation failure is observable and cannot leave an overlay lease active', async () => {
    const failures = [];
    const { dom, coordinator } = createFixture({
        hideEmbeddedView: async () => { throw new Error('native view refused hide'); },
    });
    dom.window.document.addEventListener('next-ui-overlay-activation-failed', event => failures.push(event.detail));
    coordinator.mount();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.active, false, 'failed hide must release the modal lease');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].modalId, 'globalSettingsModal');
    assert.equal(failures[0].active, false);
    coordinator.dispose();
});

test('a late hide failure from a closed modal cannot poison a newer generation', async () => {
    let rejectFirst;
    let hideCalls = 0;
    const failures = [];
    const dom = new JSDOM('<!doctype html><body></body>');
    const coordinator = new OverlayCoordinator({
        document: dom.window.document,
        hideEmbeddedView: () => {
            hideCalls += 1;
            if (hideCalls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
            return Promise.resolve();
        },
    });
    dom.window.document.addEventListener('next-ui-overlay-activation-failed', event => failures.push(event.detail));
    coordinator.mount();
    const oldRoot = dom.window.document.createElement('div');
    const newRoot = dom.window.document.createElement('div');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', root: oldRoot, generation: 1, active: true },
    }));
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', root: oldRoot, generation: 1, active: false },
    }));
    rejectFirst(new Error('late old hide failure'));
    await new Promise(resolve => setImmediate(resolve));
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', root: newRoot, generation: 2, active: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hideCalls, 2);
    assert.equal(failures.length, 0, 'closed generation must not emit activation failure');
    assert.equal(coordinator.active, true, 'new generation retains its overlay lease');
    coordinator.dispose();
    dom.window.close();
});

test('failed replacement generation releases the previous modal lease', async () => {
    let hideCalls = 0;
    let rejectReplacement;
    const dom = new JSDOM('<!doctype html><body></body>');
    const coordinator = new OverlayCoordinator({
        document: dom.window.document,
        hideEmbeddedView: () => {
            hideCalls += 1;
            if (hideCalls === 2) return new Promise((_, reject) => { rejectReplacement = reject; });
            return Promise.resolve();
        },
    });
    coordinator.mount();
    const oldRoot = dom.window.document.createElement('div');
    const newRoot = dom.window.document.createElement('div');
    coordinator.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', root: oldRoot, generation: 1, active: true },
    }));
    await new Promise(resolve => setImmediate(resolve));
    coordinator.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', root: newRoot, generation: 2, active: true },
    }));
    rejectReplacement(new Error('replacement refused'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(coordinator.active, false, 'failed replacement must not strand the old lease');
    coordinator.dispose();
    dom.window.close();
});
