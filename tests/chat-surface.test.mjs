import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatSurface, createReadOnlyChatSurface } from '../modules/chat/chatSurface.js';
import { createChatSurfaceSlots } from '../modules/chat/chatSurfaceSlots.js';

test('read-only ChatSurface ignores a late history result after dispose', async () => {
    const dom = new JSDOM('<div id="root" tabindex="-1"></div>');
    let resolveHistory;
    const renderer = { renderHistory: async () => { throw new Error('must not render after dispose'); } };
    const surface = createReadOnlyChatSurface({
        root: dom.window.document.querySelector('#root'),
        renderer,
        repository: { getHistory: () => new Promise(resolve => { resolveHistory = resolve; }) }
    });
    const load = surface.loadHistory('a', 'agent', 't');
    const firstDispose = surface.dispose();
    const secondDispose = surface.dispose();
    resolveHistory([]);
    assert.deepEqual(await load, { stale: true });
    await Promise.all([firstDispose, secondDispose]);
    assert.equal(surface.disposed, true);
});

test('interactive ChatSurface drains its real operation before renderer teardown', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const sequence = [];
    let settleOperation;
    const operationDone = new Promise(resolve => { settleOperation = resolve; });
    const surface = createChatSurface({
        root: dom.window.document.querySelector('#root'),
        renderer: {},
        repository: { getHistory: async () => [] },
        mode: 'interactive',
        operations: {
            async dispose() {
                sequence.push('operation-cancel');
                settleOperation();
                await operationDone;
                sequence.push('operation-terminal');
            },
        },
        disposeRenderer: async () => {
            sequence.push('renderer-dispose');
            assert.deepEqual(sequence, ['operation-cancel', 'operation-terminal', 'renderer-dispose']);
        },
    });

    await surface.dispose();

    assert.deepEqual(sequence, ['operation-cancel', 'operation-terminal', 'renderer-dispose']);
    dom.window.close();
});

test('interactive ChatSurface mounts composer slots and awaits their teardown', async () => {
    const dom = new JSDOM('<div id="root"></div><div id="composer"></div>');
    const root = dom.window.document.querySelector('#root');
    const composer = dom.window.document.querySelector('#composer');
    const slots = createChatSurfaceSlots();
    let unmounted = false;
    slots.register('chat.composer.leading', 'test-action', host => {
        host.textContent = '动作';
        return async () => { await Promise.resolve(); unmounted = true; };
    });
    const surface = createChatSurface({
        root,
        renderer: {},
        repository: { getHistory: async () => [] },
        mode: 'interactive',
        slots,
        disposeRenderer: async () => {},
    });
    surface.mountSlot('chat.composer.leading', composer, { canSend: true });
    assert.equal(composer.querySelector('[data-chat-slot-owner="test-action"]')?.textContent, '动作');
    await surface.dispose();
    assert.equal(unmounted, true);
    assert.equal(composer.childElementCount, 0);
    dom.window.close();
});

test('composer leading contribution can retain a business control identity while relocating it', async () => {
    const dom = new JSDOM('<div id="root"></div><div id="composer"><button id="before">前</button><button id="attach">附件</button><button id="after">后</button></div>');
    const root = dom.window.document.querySelector('#root');
    const composer = dom.window.document.querySelector('#composer');
    const attach = dom.window.document.querySelector('#attach');
    const originalParent = attach.parentNode;
    const originalNext = attach.nextSibling;
    const slots = createChatSurfaceSlots();
    slots.register('chat.composer.leading', 'core-attachment', host => {
        host.style.display = 'contents';
        host.appendChild(attach);
        return () => originalParent.insertBefore(attach, originalNext);
    });
    const surface = createChatSurface({ root, renderer: {}, repository: { getHistory: async () => [] }, slots });
    surface.mountSlot('chat.composer.leading', composer, {});
    assert.equal(attach, composer.querySelector('[data-chat-slot-owner="core-attachment"] #attach'));
    await surface.dispose();
    assert.equal(attach.parentNode, originalParent);
    assert.equal(attach.nextSibling, originalNext);
    dom.window.close();
});

test('multiple leading contributions preserve priority order and restore reverse-safe DOM order', async () => {
    const dom = new JSDOM('<div id="root"></div><div id="composer"><button id="quick">新话题</button><button id="attach">附件</button><button id="emoji">表情</button><button id="send">发送</button></div>');
    const root = dom.window.document.querySelector('#root');
    const composer = dom.window.document.querySelector('#composer');
    const controls = ['attach', 'emoji'].map(id => dom.window.document.querySelector(`#${id}`));
    const originalOrder = [...composer.children].map(node => node.id);
    const slots = createChatSurfaceSlots();
    controls.forEach((control, index) => {
        slots.register('chat.composer.leading', `core-${control.id}`, host => {
            const parent = control.parentNode;
            const next = control.nextSibling;
            host.style.display = 'contents';
            host.appendChild(control);
            return () => next && next.parentNode === parent ? parent.insertBefore(control, next) : parent.appendChild(control);
        }, { priority: index * 10 });
    });
    const surface = createChatSurface({ root, renderer: {}, repository: { getHistory: async () => [] }, slots });
    surface.mountSlot('chat.composer.leading', composer, {});
    assert.deepEqual([...composer.querySelectorAll('button')].map(node => node.id), ['attach', 'emoji', 'quick', 'send']);
    await surface.dispose();
    assert.deepEqual([...composer.children].map(node => node.id), originalOrder);
    dom.window.close();
});
