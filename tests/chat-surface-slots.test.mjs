import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatSurfaceSlots, createSlotRegistry } from '../modules/chat/chatSurfaceSlots.js';

test('chat surface slots are named, disposable and receive readonly snapshots', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const slots = createChatSurfaceSlots();
    const seen = [];
    const dispose = slots.register('header', 'skin', (host, snapshot) => { seen.push(snapshot.mode); host.textContent = 'skin'; });
    const owned = slots.mount('header', root, { mode: 'readonly', canSend: false });
    assert.deepEqual(seen, ['readonly']);
    assert.equal(root.querySelector('[data-chat-slot-owner="skin"]')?.textContent, 'skin');
    owned.forEach(unmount => unmount());
    dispose();
    slots.dispose();
    assert.equal(root.childElementCount, 0);
});

test('slot mount rolls back earlier contributions when a later consumer fails', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const slots = createChatSurfaceSlots();
    let disposed = 0;
    slots.register('header', 'first', () => () => { disposed += 1; });
    slots.register('header', 'broken', () => { throw new Error('mount failed'); });
    assert.throws(() => slots.mount('header', root, {}), /mount failed/);
    assert.equal(root.childElementCount, 0);
    assert.equal(disposed, 1);
});

test('target-mode slot registrations are ordered, owned and inspectable', () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const slots = createChatSurfaceSlots();
    const ownerReleases = [];
    const owner = { own(dispose) { ownerReleases.push(dispose); return dispose; } };
    const seen = [];
    slots.register('chat.composer.leading', 'zeta', (host, snapshot, context) => {
        seen.push([host.dataset.chatSlotOwner, snapshot.mode, context.scope, context.kind]);
        host.textContent = 'zeta';
    }, { priority: 20, scope: 'session-maybe', owner, inject: { command: 'attach' } });
    slots.register('chat.composer.leading', 'alpha', (host) => { seen.push([host.dataset.chatSlotOwner]); host.textContent = 'alpha'; }, { priority: 10 });

    assert.deepEqual(slots.describe(), [
        { slot: 'chat.composer.leading', id: 'alpha', kind: 'list', scope: 'surface', priority: 10, hasInject: false },
        { slot: 'chat.composer.leading', id: 'zeta', kind: 'list', scope: 'session-maybe', priority: 20, hasInject: true },
    ]);
    const owned = slots.mount('chat.composer.leading', root, { mode: 'target' });
    assert.deepEqual(seen, [['alpha'], ['zeta', 'target', 'session-maybe', 'list']]);
    assert.deepEqual([...root.children].map(node => node.textContent), ['alpha', 'zeta']);
    assert.equal(slots.diagnostics().registrations, 2);
    ownerReleases[0]();
    assert.equal(slots.diagnostics().registrations, 1);
    owned.forEach(dispose => dispose());
    assert.equal(root.childElementCount, 0);
});

test('target-mode registry factory can be scoped to a declared slot set', () => {
    const slots = createSlotRegistry({ allowedSlots: ['account.menu.item'] });
    assert.throws(() => slots.register('header', 'legacy', () => {}), /Unsupported chat surface slot/);
    const release = slots.register('account.menu.item', 'theme', () => {});
    assert.equal(slots.describe()[0].slot, 'account.menu.item');
    release();
    assert.equal(slots.diagnostics().registrations, 0);
});

test('target-mode slot mount exposes a child owner and rolls it back on async teardown', async () => {
    const root = new JSDOM('<div></div>').window.document.querySelector('div');
    const slots = createChatSurfaceSlots();
    let childDisposedByScope = false;
    const scope = {
        child() {
            const resources = [];
            return {
                own(dispose) { resources.push(dispose); return dispose; },
                async dispose() { resources.splice(0).reverse().forEach(dispose => dispose()); childDisposedByScope = true; },
            };
        }
    };
    let childDisposed = false;
    slots.register('header', 'async', (host, _snapshot, context) => {
        context.owner.own(() => { childDisposed = true; }, 'child-resource');
        host.textContent = 'async';
        return async () => { await Promise.resolve(); };
    });
    const owned = slots.mount('header', root, {}, { scope });
    await owned[0]();
    assert.equal(childDisposed, true);
    assert.equal(root.childElementCount, 0);
    assert.equal(childDisposedByScope, true);
});
