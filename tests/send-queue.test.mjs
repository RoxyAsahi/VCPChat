import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createSendQueue, moveQueueItem, resolveReorderAnchor, STORAGE_KEY } from '../modules/ui-system/send-queue.js';

const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const ids = items => items.map(item => item.id).join('');

function memoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

test('resolveReorderAnchor / moveQueueItem port ZCode drag semantics', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    assert.equal(resolveReorderAnchor(items, 'a', 'a'), null);
    assert.equal(resolveReorderAnchor(items, 'a', 'zz'), null);
    // 向后拖：落在 over 之后（排到 over 的下一项之前）
    assert.deepEqual(resolveReorderAnchor(items, 'a', 'c'), { id: 'a', beforeId: 'd' });
    assert.deepEqual(resolveReorderAnchor(items, 'a', 'd'), { id: 'a', beforeId: null });
    // 向前拖：落在 over 之前
    assert.deepEqual(resolveReorderAnchor(items, 'd', 'b'), { id: 'd', beforeId: 'b' });
    assert.equal(ids(moveQueueItem(items, 'a', 'd')), 'bcad');
    assert.equal(ids(moveQueueItem(items, 'a', null)), 'bcda');
    assert.equal(ids(moveQueueItem(items, 'd', 'b')), 'adbc');
    assert.equal(moveQueueItem(items, 'x', null), items);
    assert.equal(moveQueueItem(items, 'a', 'nope'), items);
});

function makeApp({ sendText, hasAttachments = () => false, context = { key: 'agent:1:t1' }, storage } = {}) {
    const dom = new JSDOM(`<footer class="chat-input-area"><div class="chat-input-card">
        <textarea id="messageInput"></textarea><button id="sendMessageBtn" data-mode="send"></button></div></footer>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const input = doc.getElementById('messageInput');
    const button = doc.getElementById('sendMessageBtn');
    const sent = [];
    const notices = [];
    const state = { context };
    const sender = sendText || (async (text, transaction) => {
        transaction.onAccepted();
        sent.push(text);
        button.dataset.mode = 'interrupt'; // 模拟：发出后马上进入输出中
    });
    const queue = createSendQueue({
        document: doc,
        getContext: () => state.context,
        hasAttachments: () => hasAttachments(),
        sendText: sender,
        notify: (...args) => notices.push(args),
        drainDelayMs: 5,
        startTimeoutMs: 80,
        storage: storage ?? null
    });
    const panel = queue.mount();
    const sendLog = [];
    // 模拟 event-listeners.js 冒泡阶段的 Enter 发送
    input.addEventListener('keydown', event => {
        if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey) sendLog.push(input.value);
    });
    const press = (init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
        input.dispatchEvent(event);
        return event;
    };
    const setMode = mode => { button.dataset.mode = mode; };
    return { dom, doc, input, button, queue, panel, sent, sendLog, notices, state, press, setMode };
}

test('Enter while a reply streams queues the draft instead of sending, and drains in order once idle', async () => {
    const { input, queue, panel, sent, sendLog, press, setMode } = makeApp();
    assert.equal(panel.hidden, true);

    input.value = '先发这个';
    assert.equal(press().defaultPrevented, false, 'idle: the normal send path owns Enter');
    assert.equal(sendLog.length, 1);

    setMode('interrupt');
    input.value = '第一条';
    const queued = press();
    assert.equal(queued.defaultPrevented, true);
    assert.equal(input.value, '');
    input.value = '第二条';
    press();
    input.value = '   ';
    assert.equal(press().defaultPrevented, false, 'blank drafts are not queued');
    assert.equal(sendLog.length, 2);
    assert.deepEqual(queue.getState().items, ['第一条', '第二条']);
    assert.equal(panel.hidden, false);
    assert.equal(panel.querySelectorAll('.vcp-queue-item').length, 2);
    assert.equal(panel.querySelector('.vcp-queue-title').textContent, '待发送消息（2）');

    setMode('send'); // 回复结束
    await wait();
    assert.deepEqual(sent, ['第一条']);
    assert.deepEqual(queue.getState().items, ['第二条']);
    assert.equal(queue.getState().awaitingStart, false, 'the sent item has started streaming');
    setMode('send'); // 第一条的回复结束，轮到第二条
    await wait();
    assert.deepEqual(sent, ['第一条', '第二条']);
    assert.deepEqual(queue.getState().items, []);
    assert.equal(panel.hidden, true);
});

test('modifier keys, IME and attachment drafts bypass the queue', () => {
    let attachments = false;
    const { input, queue, press, setMode } = makeApp({ hasAttachments: () => attachments });
    setMode('interrupt');
    input.value = 'x';
    assert.equal(press({ shiftKey: true }).defaultPrevented, false);
    assert.equal(press({ ctrlKey: true }).defaultPrevented, false);
    assert.equal(press({ isComposing: true }).defaultPrevented, false);
    attachments = true;
    assert.equal(press().defaultPrevented, false);
    assert.deepEqual(queue.getState().items, []);
});

test('stopping the reply pauses the queue with a resume banner; resume sends the next item', async () => {
    const { button, panel, queue, sent, input, press, setMode } = makeApp();
    setMode('interrupt');
    input.value = '排队的';
    press();
    // 用户点中止
    button.click();
    assert.equal(queue.getState().paused, 'stopped');
    assert.match(panel.querySelector('.vcp-queue-banner-text').textContent, /中断了当前响应/u);
    setMode('send');
    await wait();
    assert.deepEqual(sent, [], 'paused: nothing is sent');

    panel.querySelector('.vcp-queue-resume').click();
    await wait();
    assert.deepEqual(sent, ['排队的']);
    assert.equal(queue.getState().paused, false);
});

test('a dispatch that never starts streaming puts the message back and pauses', async () => {
    const attempts = [];
    const { input, queue, setMode, press } = makeApp({ sendText: async (text) => { attempts.push(text); } });
    setMode('interrupt');
    input.value = '发不出去';
    press();
    setMode('send');
    await wait(150);
    assert.deepEqual(attempts, ['发不出去']);
    assert.deepEqual(queue.getState(), { items: ['发不出去'], paused: 'error', awaitingStart: false });

    // sendText 直接抛错也一样
    const failing = makeApp({ sendText: async () => { throw new Error('no server'); } });
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        failing.setMode('interrupt');
        failing.input.value = '会失败';
        failing.press();
        failing.setMode('send');
        await wait(40);
        assert.deepEqual(failing.queue.getState().items, ['会失败']);
        assert.equal(failing.queue.getState().paused, 'error');
    } finally {
        console.warn = originalWarn;
    }
});

test('reorder by drop, edit back into the composer, remove and send-now', async () => {
    const { dom, doc, input, panel, queue, sent, notices, press, setMode, button } = makeApp();
    setMode('interrupt');
    for (const text of ['A', 'B', 'C']) { input.value = text; press(); }
    const rows = () => [...panel.querySelectorAll('.vcp-queue-item')];
    assert.deepEqual(rows().map(row => row.querySelector('.vcp-queue-text').textContent), ['A', 'B', 'C']);

    // 把 A 拖到 B 上：A 排到 B 后面
    const [rowA, rowB] = rows();
    rowA.dispatchEvent(new dom.window.Event('dragstart', { bubbles: true }));
    rowB.dispatchEvent(new dom.window.Event('dragover', { bubbles: true, cancelable: true }));
    rowB.dispatchEvent(new dom.window.Event('drop', { bubbles: true, cancelable: true }));
    assert.deepEqual(queue.getState().items, ['B', 'A', 'C']);

    // 编辑：草稿非空时拒绝并提示
    input.value = '正在写的草稿';
    rows()[0].querySelector('.vcp-queue-edit').click();
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'warning');
    assert.deepEqual(queue.getState().items, ['B', 'A', 'C']);
    input.value = '';
    let inputEvents = 0;
    input.addEventListener('input', () => { inputEvents += 1; });
    rows()[0].querySelector('.vcp-queue-edit').click();
    assert.equal(input.value, 'B');
    assert.equal(inputEvents, 1);
    assert.equal(doc.activeElement, input);
    assert.deepEqual(queue.getState().items, ['A', 'C']);

    rows()[1].querySelector('.vcp-queue-remove').click();
    assert.deepEqual(queue.getState().items, ['A']);

    // 立即：先点中止（不会触发暂停），队首就是这一条
    input.value = '';
    input.value = 'D'; press();
    let stopClicks = 0;
    button.addEventListener('click', () => { stopClicks += 1; setMode('send'); });
    rows()[1].querySelector('.vcp-queue-send-now').click();
    assert.equal(stopClicks, 1);
    assert.equal(queue.getState().paused, false);
    await wait();
    assert.deepEqual(sent, ['D']);
    assert.deepEqual(queue.getState().items, ['A']);
});

test('queues are per topic: switching away pauses the old one and the new topic starts empty', async () => {
    const { input, panel, queue, state, sent, press, setMode } = makeApp();
    setMode('interrupt');
    input.value = '话题一的';
    press();
    state.context = { key: 'agent:1:t2' };
    queue.refresh();
    assert.equal(panel.hidden, true);
    assert.deepEqual(queue.getState().items, []);
    setMode('send');
    await wait();
    assert.deepEqual(sent, [], 'nothing leaks into the other topic');

    state.context = { key: 'agent:1:t1' };
    queue.refresh();
    assert.equal(queue.getState().paused, 'switched');
    assert.equal(panel.hidden, false);
    state.context = null;
    queue.refresh();
    assert.equal(panel.hidden, true);
});

test('mount is a no-op without the composer footer, dispose is idempotent', () => {
    const dom = new JSDOM('<textarea id="messageInput"></textarea><button id="sendMessageBtn"></button>');
    assert.equal(createSendQueue({ document: dom.window.document }).mount(), null);
    const { queue, doc, input } = makeApp();
    queue.dispose();
    queue.dispose();
    assert.equal(doc.querySelector('.vcp-queue-panel'), null);
    input.value = 'x';
    assert.equal(queue.getState().items.length, 0);
});

test('queues persist per context, restore paused after a restart, and clear when emptied', async () => {
    const storage = memoryStorage();
    const first = makeApp({ storage, sendText: async () => {} });
    first.setMode('interrupt');
    first.input.value = '稍后发送的话';
    first.press();
    first.input.value = '第二条';
    first.press();
    const saved = JSON.parse(storage.map.get(STORAGE_KEY));
    assert.deepEqual(saved['agent:1:t1'].map(item => item.text), ['稍后发送的话', '第二条']);
    first.queue.dispose();

    const second = makeApp({ storage });
    assert.deepEqual(second.queue.getState(), { items: ['稍后发送的话', '第二条'], paused: 'restored', awaitingStart: false });
    assert.match(second.panel.textContent, /已恢复上次没有发出的消息/);
    await wait(60);
    assert.deepEqual(second.sent, [], 'restored queue must not auto-send');

    second.queue.removeItem(JSON.parse(storage.map.get(STORAGE_KEY))['agent:1:t1'][0].id);
    assert.ok(storage.map.has(STORAGE_KEY));
    second.panel.querySelector('.vcp-queue-resume').click();
    await wait(60);
    assert.deepEqual(second.sent, ['第二条']);
    assert.equal(storage.map.has(STORAGE_KEY), false);
});

test('corrupt or foreign persisted data is ignored', () => {
    for (const raw of ['{not json', '[1,2]', JSON.stringify({ k: 'x' }), JSON.stringify({ 'agent:1:t1': [{ text: '  ' }, null, { text: 5 }] })]) {
        const app = makeApp({ storage: memoryStorage({ [STORAGE_KEY]: raw }) });
        assert.deepEqual(app.queue.getState().items, []);
    }
});

test('capacity rejects the 51st item without consuming its draft',()=>{
 const storage=memoryStorage();const app=makeApp({storage});app.setMode('interrupt');
 for(let i=0;i<50;i++) assert.equal(app.queue.enqueue('entry-'+i),true);
 app.input.value='keep this draft';app.press();assert.equal(app.input.value,'keep this draft');
 assert.equal(app.queue.getState().items.length,50);assert.equal(JSON.parse(storage.map.get(STORAGE_KEY))['agent:1:t1'].length,50);app.queue.dispose();app.dom.window.close();
});
test('pending admission survives reload, timeout never retries, and acceptance removes only its own item',async()=>{
 const storage=memoryStorage();let accept,finish;const app=makeApp({storage,sendText:async(text,tx)=>{accept=tx.onAccepted;await new Promise(resolve=>{finish=resolve;});}});
 app.queue.enqueue('pending');app.queue.resume();await wait(120);
 assert.deepEqual(app.queue.getState().items,['pending']);assert.equal(app.queue.getState().paused,'pending');
 assert.equal(app.queue.resume(),false);assert.equal(JSON.parse(storage.map.get(STORAGE_KEY))['agent:1:t1'][0].text,'pending');
 const reopened=makeApp({storage});assert.deepEqual(reopened.queue.getState().items,['pending']);assert.equal(reopened.queue.getState().paused,'restored');
 accept();finish();await wait();assert.deepEqual(app.queue.getState().items,[]);app.queue.dispose();reopened.queue.dispose();app.dom.window.close();reopened.dom.window.close();
});
test('busy transitions do not acknowledge a dispatch, nor do later model failures requeue an admitted message',async()=>{
 let tx,fail;const app=makeApp({sendText:async(text,transaction)=>{tx=transaction;app.setMode('interrupt');await new Promise((resolve,reject)=>{fail=reject;});}});
 app.queue.enqueue('one');app.queue.resume();await wait();assert.deepEqual(app.queue.getState().items,['one']);tx.onAccepted();
 const warn=console.warn;console.warn=()=>{};try{fail(Error('model failed'));await wait();}finally{console.warn=warn;}
 assert.deepEqual(app.queue.getState().items,[]);app.queue.dispose();app.dom.window.close();
});
