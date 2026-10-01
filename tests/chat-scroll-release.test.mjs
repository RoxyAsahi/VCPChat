import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { releaseChatBottomFollow } from '../modules/ui-system/chat-scroll-release.js';
import { createConversationTurnNavigator } from '../modules/ui-system/conversation-turn-navigator.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('releaseChatBottomFollow sends the same upward wheel the follow state machine listens for', () => {
    const dom = new JSDOM('<div class="chat-messages-container"></div>');
    const scroller = dom.window.document.querySelector('.chat-messages-container');
    const wheels = [];
    scroller.addEventListener('wheel', event => wheels.push(event.deltaY));
    assert.equal(releaseChatBottomFollow(scroller), true);
    assert.deepEqual(wheels, [-1]);
    assert.equal(releaseChatBottomFollow(null), false);
});

function makeLongChat({ turns = 12, scrollHeight = 1200, clientHeight = 300 } = {}) {
    const dom = new JSDOM('<div class="chat-messages-container"><div id="chatMessages"></div></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    for (let i = 0; i < turns; i++) {
        for (const role of ['user', 'assistant']) {
            const item = doc.createElement('div');
            item.className = `message-item ${role}`;
            item.dataset.messageId = `${role[0]}${i}`;
            item.innerHTML = `<div class="md-content">${role}${i}</div>`;
            root.appendChild(item);
        }
    }
    const scroller = doc.querySelector('.chat-messages-container');
    let top = scrollHeight - clientHeight; // starts at the bottom, like a followed chat
    let drift = 0; // lazy rendering above the target pushes it further away
    const calls = [];
    const wheels = [];
    Object.defineProperty(scroller, 'clientWidth', { value: 900, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: v => { top = v; }, configurable: true });
    scroller.addEventListener('wheel', event => wheels.push(event.deltaY));
    scroller.getBoundingClientRect = () => ({ top: 0, height: clientHeight });
    scroller.scrollTo = (options) => { calls.push(options); top = options.top; };
    [...root.children].forEach((child, index) => {
        child.getBoundingClientRect = () => ({ top: index * 50 + drift - top, height: 50 });
    });
    return { dom, doc, root, scroller, calls, wheels, setDrift: v => { drift = v; }, getTop: () => top };
}

test('jumping away from the bottom first releases the bottom-follow, jumping to the bottom does not', async () => {
    const { doc, root, scroller, calls, wheels } = makeLongChat();
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root });
    const nav = navigator.mount();
    navigator.refresh();
    const buttons = [...nav.querySelectorAll('.vcp-turn-nav-item')];
    assert.equal(buttons.length, 12);

    buttons[2].click(); // user message #2 sits at y=200: far from the bottom (900)
    assert.deepEqual(wheels, [-1]);
    assert.equal(calls.at(-1).top, 188);

    wheels.length = 0;
    scroller.scrollTop = 0;
    buttons[11].click(); // y=1100, clamped by the real scroller; within 80px of the bottom -> follow stays
    assert.deepEqual(wheels, []);
    navigator.dispose();
});

test('a jump whose target moved during the scroll (layout shift) is corrected instead of left off-screen', async () => {
    const { doc, root, calls, setDrift, getTop } = makeLongChat();
    const navigator = createConversationTurnNavigator({ document: doc, messagesRoot: root });
    const nav = navigator.mount();
    navigator.refresh();
    const buttons = [...nav.querySelectorAll('.vcp-turn-nav-item')];

    buttons[3].click();
    assert.equal(calls.length, 1);
    assert.equal(getTop(), 288);
    setDrift(400); // rows above the target finished rendering and grew while scrolling
    await wait(800);
    assert.ok(calls.length >= 2, 're-scrolled after the layout shift');
    assert.equal(calls.at(-1).behavior, 'auto');
    assert.equal(getTop(), 688, 'now sits on the shifted target');
    const settled = calls.length;
    await wait(700);
    assert.equal(calls.length, settled, 'stops once the target is in place');
    navigator.dispose();
});
