import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    FOLLOW_UP_MIN_INTERVAL_MS,
    MAX_FOLLOW_UPS_PER_MOUNT,
    MAX_STATE_CHARS,
    buildBridgeScript,
    createWidgetChannel,
    readGlobals,
    widgetStateKey
} from '../modules/renderer/widgetBridge.js';
import { createContentProcessor } from '../modules/renderer/contentProcessor.js';

function memoryStorage() {
    const map = new Map();
    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: key => map.delete(key),
        map
    };
}

function fakeFrame({ engaged = true } = {}) {
    const contentWindow = { postMessage() {} };
    const frame = { contentWindow, ownerDocument: { activeElement: null } };
    frame.ownerDocument.activeElement = engaged ? frame : null;
    return { frame, contentWindow };
}

test('state key is stable per message and html, and absent without a message id', () => {
    assert.equal(widgetStateKey('', '<p>x</p>'), null);
    assert.equal(widgetStateKey('m1', '<p>x</p>'), widgetStateKey('m1', '<p>x</p>'));
    assert.notEqual(widgetStateKey('m1', '<p>x</p>'), widgetStateKey('m1', '<p>y</p>'));
    assert.notEqual(widgetStateKey('m1', '<p>x</p>'), widgetStateKey('m2', '<p>x</p>'));
});

test('bridge script exposes window.vcp and talks to the host through postMessage', () => {
    const posted = [];
    const listeners = [];
    const parent = { postMessage: (data, target) => posted.push([data, target]) };
    const fakeWindow = {
        addEventListener: (type, fn) => listeners.push([type, fn]),
        dispatchEvent: event => { fakeWindow.lastEvent = event; }
    };
    class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
    const script = buildBridgeScript({ frameId: 'f1', state: { n: 3 }, globals: { theme: 'dark', locale: 'zh-CN' } });
    new Function('window', 'parent', 'CustomEvent', 'Object', script)(fakeWindow, parent, FakeCustomEvent, Object);

    const vcp = fakeWindow.vcp;
    assert.deepEqual(vcp.widgetState, { n: 3 });
    assert.equal(vcp.globals.theme, 'dark');

    vcp.setWidgetState({ n: 4 });
    assert.deepEqual(posted.at(-1)[0], { type: 'vcp-widget', frameId: 'f1', action: 'set-state', state: { n: 4 } });
    assert.throws(() => vcp.setWidgetState('x'.repeat(MAX_STATE_CHARS + 1)));

    assert.equal(vcp.sendFollowUpMessage('   '), false);
    assert.equal(vcp.sendFollowUpMessage('继续'), true);
    assert.equal(posted.at(-1)[0].action, 'follow-up');

    const seen = [];
    vcp.onGlobals(globals => seen.push(globals.theme));
    const onMessage = listeners.find(([type]) => type === 'message')[1];
    onMessage({ source: {}, data: { type: 'vcp-widget:globals', frameId: 'f1', globals: { theme: 'light' } } });
    assert.deepEqual(seen, [], 'messages from anything but the host are ignored');
    onMessage({ source: parent, data: { type: 'vcp-widget:globals', frameId: 'other', globals: { theme: 'light' } } });
    assert.deepEqual(seen, [], 'messages for another frame are ignored');
    onMessage({ source: parent, data: { type: 'vcp-widget:globals', frameId: 'f1', globals: { theme: 'light' } } });
    assert.deepEqual(seen, ['light']);
    assert.equal(fakeWindow.lastEvent.type, 'vcp:set_globals');
});

test('bridge script survives hostile state and frame ids', () => {
    const script = buildBridgeScript({ frameId: 'f"</script>', state: { s: '</script><b>' + String.fromCharCode(0x2028) }, globals: {} });
    assert.equal(script.includes('</script>'), false);
    assert.equal(script.includes(String.fromCharCode(0x2028)), false);
    assert.doesNotThrow(() => new Function('window', 'parent', 'CustomEvent', 'Object', script)(
        { addEventListener() {}, dispatchEvent() {} }, { postMessage() {} }, class {}, Object
    ));
});

test('channel persists state and only answers its own frame', () => {
    const storage = memoryStorage();
    const { frame, contentWindow } = fakeFrame();
    const channel = createWidgetChannel({ frame, frameId: 'f1', storage, storageKey: 'k' });
    assert.equal(channel.loadState(), null);

    assert.equal(channel.handle({ source: {}, data: { type: 'vcp-widget', frameId: 'f1', action: 'set-state', state: { a: 1 } } }), false);
    assert.equal(channel.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'nope', action: 'set-state', state: { a: 1 } } }), false);
    assert.equal(channel.handle({ source: contentWindow, data: { type: 'vcp-html-resize', frameId: 'f1' } }), false);
    assert.equal(storage.map.size, 0);

    assert.equal(channel.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'set-state', state: { a: 1 } } }), true);
    assert.deepEqual(channel.loadState(), { a: 1 });

    const rejected = [];
    const tight = createWidgetChannel({ frame, frameId: 'f1', storage, storageKey: 'k2', onRejected: r => rejected.push(r) });
    tight.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'set-state', state: 'x'.repeat(MAX_STATE_CHARS) } });
    assert.deepEqual(rejected, ['state-too-large']);
    assert.equal(storage.map.has('k2'), false);

    channel.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'set-state', state: null } });
    assert.equal(channel.loadState(), null);

    channel.dispose();
    assert.equal(channel.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'set-state', state: 1 } }), false);
});

test('follow-up messages require a fresh host confirmation and are rate limited', async () => {
    const sent = [];
    const rejected = [];
    let clock = 1000;
    const { frame, contentWindow } = fakeFrame();
    const channel = createWidgetChannel({
        frame, frameId: 'f1', requestConfirmation: async () => true, sendMessage: text => { sent.push(text); }, now: () => clock, onRejected: r => rejected.push(r)
    });
    const ask = text => channel.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'follow-up', text } });

    ask('帮我总结');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(sent, ['[[组件消息:帮我总结]]']);
    ask('太快了');
    assert.deepEqual(rejected, ['follow-up-rate-limited']);
    for (let i = 1; i < MAX_FOLLOW_UPS_PER_MOUNT; i += 1) {
        clock += FOLLOW_UP_MIN_INTERVAL_MS;
        ask(`第${i}条`);
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(sent.length, MAX_FOLLOW_UPS_PER_MOUNT);
    clock += FOLLOW_UP_MIN_INTERVAL_MS;
    ask('超额');
    assert.equal(rejected.at(-1), 'follow-up-limit');

    const idle = fakeFrame({ engaged: false });
    const idleSent = [];
    const idleRejected = [];
    const cold = createWidgetChannel({ frame: idle.frame, frameId: 'f1', sendMessage: t => idleSent.push(t), onRejected: r => idleRejected.push(r) });
    cold.handle({ source: idle.contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'follow-up', text: '偷偷发' } });
    assert.deepEqual(idleSent, []);
    assert.deepEqual(idleRejected, ['no-host-confirmation']);

    const long = createWidgetChannel({ frame, frameId: 'f1', sendMessage: t => idleSent.push(t), onRejected: r => idleRejected.push(r) });
    long.handle({ source: contentWindow, data: { type: 'vcp-widget', frameId: 'f1', action: 'follow-up', text: 'x'.repeat(2001) } });
    assert.equal(idleRejected.at(-1), 'follow-up-too-long');
});

test('readGlobals follows the app theme attribute', () => {
    const dom = new JSDOM('<body data-vcp-theme="light"></body>');
    assert.equal(readGlobals(dom.window.document).theme, 'light');
    dom.window.document.body.dataset.vcpTheme = 'dark';
    assert.equal(readGlobals(dom.window.document).theme, 'dark');
    dom.window.close();
});

test('HTML preview embeds the bridge and restores saved state for the same message', () => {
    const dom = new JSDOM('<body><section id="chat"><div class="message-item" data-message-id="m-42"><pre><code class="language-html">&lt;p id="a"&gt;hello&lt;/p&gt;</code></pre></div></section></body>', {
        url: 'https://vcpchat.local/'
    });
    const root = dom.window.document.getElementById('chat');
    const processor = createContentProcessor();
    const sent = [];
    processor.initializeContentProcessor({ chatMessagesDiv: root, messageCommands: { handleSendMessage: text => { sent.push(text); return Promise.resolve(); } }, uiHelper: {} });
    processor.processAllPreBlocksInContentDiv(root);
    root.querySelector('.vcp-html-preview-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));

    let frame = root.querySelector('iframe.vcp-html-preview-frame');
    assert.match(frame.srcdoc, /window, 'vcp'/);
    assert.match(frame.srcdoc, /"widgetState":\s*null|widgetState: null/);

    // 组件保存状态 → 宿主写入 localStorage；用户点击后 iframe 成为 activeElement，才允许追问
    const frameId = frame.dataset.frameId;
    const post = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data, source: frame.contentWindow }));
    post({ type: 'vcp-widget', frameId, action: 'set-state', state: { picked: 'B' } });
    const keys = Object.keys(dom.window.localStorage).filter(k => k.startsWith('vcp-widget-state:m-42:'));
    assert.equal(keys.length, 1);
    assert.deepEqual(JSON.parse(dom.window.localStorage.getItem(keys[0])), { picked: 'B' });

    post({ type: 'vcp-widget', frameId, action: 'follow-up', text: '无点击' });
    assert.deepEqual(sent, []);
    const consent = root.querySelector('.vcp-widget-confirmation');
    assert.ok(consent);
    consent.querySelector('button').click();
    assert.deepEqual(sent, [], 'synthetic host clicks cannot approve a send');

    // 重新预览：状态被带进新的 srcdoc
    root.querySelector('.vcp-html-preview-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    root.querySelector('.vcp-html-preview-toggle').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    frame = root.querySelector('iframe.vcp-html-preview-frame');
    assert.match(frame.srcdoc, /picked/);

    processor.dispose();
    dom.window.close();
});

test('iframe focus and repeated messages cannot replace a per-request host decision',async()=>{
 const {frame,contentWindow}=fakeFrame();const sent=[];let approve;
 const channel=createWidgetChannel({frame,frameId:'f',sendMessage:text=>sent.push(text),requestConfirmation:()=>new Promise(resolve=>{approve=resolve;})});
 const request=text=>channel.handle({source:contentWindow,data:{type:'vcp-widget',frameId:'f',action:'follow-up',text}});
 request('first');request('spam');assert.deepEqual(sent,[]);approve(true);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(sent,['[[组件消息:first]]']);
 const abandoned=createWidgetChannel({frame,frameId:'g',sendMessage:text=>sent.push(text),requestConfirmation:()=>new Promise(resolve=>{approve=resolve;})});
 abandoned.handle({source:contentWindow,data:{type:'vcp-widget',frameId:'g',action:'follow-up',text:'late'}});abandoned.dispose();approve(true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);
});

test('a confirmation completed after the originating conversation changes cannot send into the new conversation',async()=>{
 const {frame,contentWindow}=fakeFrame();let current=true,approve;const sent=[];
 const channel=createWidgetChannel({frame,frameId:'scope',isCurrent:()=>current,sendMessage:text=>sent.push(text),requestConfirmation:()=>new Promise(resolve=>{approve=resolve;})});
 channel.handle({source:contentWindow,data:{type:'vcp-widget',frameId:'scope',action:'follow-up',text:'old topic'}});
 current=false;approve(true);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(sent,[]);
});
