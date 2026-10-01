import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createDurationStore, createMessageMetaEnhancer, formatMessageTimeLabel, formatWorkDuration, parseFullTimestampText } from '../modules/ui-system/message-meta-enhancer.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

test('formatWorkDuration keeps at most two units and rounds short runs up to one second', () => {
    assert.equal(formatWorkDuration(200), '1 秒');
    assert.equal(formatWorkDuration(12_400), '12 秒');
    assert.equal(formatWorkDuration(125_000), '2 分 5 秒');
    assert.equal(formatWorkDuration(3_600_000), '1 时');
    assert.equal(formatWorkDuration(3_725_000), '1 时 2 分');
    assert.equal(formatWorkDuration(90_000_000), '1 天 1 时');
    assert.equal(formatWorkDuration(undefined), null);
    assert.equal(formatWorkDuration(-5), null);
});

test('duration store persists by id and evicts the oldest entries', () => {
    const data = {};
    const storage = { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
    const store = createDurationStore(storage);
    store.set('a', 1234.6);
    assert.equal(store.get('a'), 1235);
    assert.equal(createDurationStore(storage).get('a'), 1235, 'a fresh store reads the persisted value');
    for (let i = 0; i < 3100; i += 1) store.set(`m${i}`, i);
    assert.equal(store.get('a'), undefined);
    assert.equal(store.get('m3099'), 3099);
    assert.equal(createDurationStore({ getItem: () => '{bad', setItem() {} }).get('x'), undefined);
});

function makeEnv(startClock = 1_000_000) {
    const dom = new JSDOM('<div id="chatMessages"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const data = {};
    const storage = { getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
    let clock = startClock;
    const root = doc.getElementById('chatMessages');
    const enhancer = createMessageMetaEnhancer({ document: doc, messagesRoot: root, storage, now: () => clock });
    enhancer.mount();
    const addAssistant = (id, extra = '') => {
        const item = doc.createElement('div');
        item.className = `message-item assistant ${extra}`.trim();
        item.dataset.messageId = id;
        item.innerHTML = '<div class="details-and-bubble-wrapper"><div class="name-time-block"><div class="sender-name">AI</div></div><div class="md-content"></div></div>';
        root.appendChild(item);
        return item;
    };
    return { doc, root, storage, enhancer, addAssistant, advance: ms => { clock += ms; } };
}

test('labels a streamed reply with its duration when streaming ends', async () => {
    const { addAssistant, advance, doc } = makeEnv();
    const item = addAssistant('m1', 'streaming thinking');
    await wait();
    advance(65_000);
    item.classList.remove('streaming', 'thinking');
    await wait();
    const label = item.querySelector('.name-time-block .message-duration');
    assert.equal(label.textContent, '用时 1 分 5 秒');
    // 再次结束不重复追加
    item.classList.add('streaming');
    await wait();
    advance(2_000);
    item.classList.remove('streaming');
    await wait();
    assert.equal(doc.querySelectorAll('.message-duration').length, 1);
    assert.equal(label.textContent, '用时 2 秒');
});

test('a class that stays streaming keeps the original start time', async () => {
    const { addAssistant, advance } = makeEnv();
    const item = addAssistant('m2', 'streaming');
    await wait();
    advance(4_000);
    item.classList.add('streaming', 'thinking'); // 流式管线会反复写 class
    await wait();
    advance(1_000);
    item.classList.remove('streaming');
    await wait();
    assert.equal(item.querySelector('.message-duration').textContent, '用时 5 秒');
});

test('history messages get their stored duration back when rendered again', async () => {
    const env = makeEnv();
    const item = env.addAssistant('m3', 'streaming');
    await wait();
    env.advance(7_000);
    item.classList.remove('streaming');
    await wait();
    env.root.textContent = '';
    await wait();

    const again = env.addAssistant('m3');
    await wait();
    assert.equal(again.querySelector('.message-duration').textContent, '用时 7 秒');
    const unknown = env.addAssistant('never-streamed');
    await wait();
    assert.equal(unknown.querySelector('.message-duration'), null);
});

test('user messages and disposed observers are ignored', async () => {
    const { doc, root, enhancer, advance } = makeEnv();
    const user = doc.createElement('div');
    user.className = 'message-item user streaming';
    user.innerHTML = '<div class="name-time-block"></div>';
    root.appendChild(user);
    await wait();
    advance(3_000);
    user.classList.remove('streaming');
    await wait();
    assert.equal(doc.querySelector('.message-duration'), null);

    enhancer.dispose();
    const item = doc.createElement('div');
    item.className = 'message-item assistant streaming';
    item.innerHTML = '<div class="name-time-block"></div>';
    root.appendChild(item);
    await wait();
    advance(3_000);
    item.classList.remove('streaming');
    await wait();
    assert.equal(doc.querySelector('.message-duration'), null);
});

test('formatMessageTimeLabel follows the today / yesterday / this year / older rules', () => {
    const now = new Date(2026, 9, 1, 15, 30).getTime();
    const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min).getTime();
    assert.equal(formatMessageTimeLabel(at(2026, 10, 1, 9, 5), now), '09:05');
    assert.equal(formatMessageTimeLabel(at(2026, 10, 1, 0, 5), now), '00:05');
    assert.equal(formatMessageTimeLabel(at(2026, 9, 30, 23, 59), now), '昨天 23:59');
    assert.equal(formatMessageTimeLabel(at(2026, 3, 8, 14, 5), now), '3/8 14:05');
    assert.equal(formatMessageTimeLabel(at(2025, 12, 31, 8, 0), now), '2025/12/31 08:00');
    assert.equal(formatMessageTimeLabel(NaN, now), null);
    assert.equal(formatMessageTimeLabel(0, now), null);
    assert.equal(parseFullTimestampText('2026-10-01 09:05'), at(2026, 10, 1, 9, 5));
    assert.equal(parseFullTimestampText('昨天 09:05'), null);
});

test('rewrites message timestamps to the short label, keeps the full time in the title and handles late-appended stamps', async () => {
    const env = makeEnv(Date.now());
    const stamp = new Date();
    const pad = value => String(value).padStart(2, '0');
    const full = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
    const short = `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;

    const item = env.addAssistant('t1');
    item.dataset.timestamp = String(stamp.getTime());
    const block = item.querySelector('.name-time-block');
    const early = env.doc.createElement('div');
    early.className = 'message-timestamp';
    early.textContent = full;
    block.appendChild(early);
    await wait();
    assert.equal(early.textContent, short);
    assert.equal(early.title, full);

    // streamManager 在流结束后才补上时间戳
    const streaming = env.addAssistant('t2', 'streaming');
    streaming.dataset.timestamp = String(stamp.getTime());
    await wait();
    const late = env.doc.createElement('div');
    late.className = 'message-timestamp';
    late.textContent = full;
    streaming.querySelector('.name-time-block').appendChild(late);
    await wait();
    assert.equal(late.textContent, short);

    // 只会改写一次，不会被自己的修改反复触发
    await wait();
    assert.equal(late.textContent, short);

    // 没有 data-timestamp 时回退解析文本
    const user = env.doc.createElement('div');
    user.className = 'message-item user';
    user.innerHTML = `<div class="name-time-block"><div class="message-timestamp">2020-01-02 03:04</div></div>`;
    env.root.appendChild(user);
    await wait();
    assert.equal(user.querySelector('.message-timestamp').textContent, '2020/1/2 03:04');
    assert.equal(user.querySelector('.message-timestamp').title, '2020-01-02 03:04');
});
