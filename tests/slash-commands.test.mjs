import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    buildDefaultCommands,
    createSlashCommands,
    filterCommands,
    findCommand,
    parseSlashDraft,
    resolvePopupPosition
} from '../modules/ui-system/slash-commands.js';

test('parseSlashDraft only reacts to a leading slash command', () => {
    assert.deepEqual(parseSlashDraft('/'), { phase: 'name', query: '' });
    assert.deepEqual(parseSlashDraft('/ne'), { phase: 'name', query: 'ne' });
    assert.deepEqual(parseSlashDraft('/find 你好 世界'), { phase: 'args', name: 'find', args: '你好 世界' });
    assert.deepEqual(parseSlashDraft('/find '), { phase: 'args', name: 'find', args: '' });
    assert.equal(parseSlashDraft('hello /new'), null);
    assert.equal(parseSlashDraft(' /new'), null);
    assert.equal(parseSlashDraft('/usr/local/bin'), null, 'paths are plain messages');
    assert.equal(parseSlashDraft('/new\n第二行'), null);
    assert.equal(parseSlashDraft(''), null);
});

test('filterCommands ranks exact > prefix > contains > description, and findCommand resolves aliases', () => {
    const commands = [
        { name: 'new', aliases: ['topic'], label: '新建话题', description: '新建' },
        { name: 'search', aliases: ['global'], label: '全局搜索', description: '跨话题' },
        { name: 'settings', aliases: [], label: '设置', description: '打开 Agent 设置' }
    ];
    assert.deepEqual(filterCommands(commands, '').map(c => c.name), ['new', 'search', 'settings']);
    assert.deepEqual(filterCommands(commands, 'se').map(c => c.name), ['search', 'settings']);
    assert.deepEqual(filterCommands(commands, 'TOP').map(c => c.name), ['new']);
    assert.deepEqual(filterCommands(commands, '设置').map(c => c.name), ['settings']);
    assert.deepEqual(filterCommands(commands, 'agent').map(c => c.name), ['settings']);
    assert.deepEqual(filterCommands(commands, 'zzz'), []);
    assert.equal(findCommand(commands, 'GLOBAL').name, 'search');
    assert.equal(findCommand(commands, 'nope'), null);
});

test('buildDefaultCommands only offers commands whose action exists', () => {
    const commands = buildDefaultCommands({ newTopic: () => 'n', find: query => `f:${query}` });
    assert.deepEqual(commands.map(c => c.name), ['new', 'find']);
    assert.equal(commands[1].takesArgs, true);
    assert.equal(commands[1].run('x'), 'f:x');
});

test('/trace resolves by alias to the model trajectory action', () => {
    const commands = buildDefaultCommands({ modelTrajectory: () => 'opened' });
    assert.deepEqual(commands.map(c => c.name), ['trace']);
    assert.equal(findCommand(commands, '轨迹').name, 'trace');
    assert.equal(findCommand(commands, 'trajectory').run(), 'opened');
});

test('resolvePopupPosition sits above the input and stays inside the viewport', () => {
    assert.deepEqual(
        resolvePopupPosition({ inputRect: { left: 100, top: 500, width: 600 }, viewportHeight: 700, viewportWidth: 1200 }),
        { left: 100, width: 380, bottom: 208 }
    );
    assert.equal(resolvePopupPosition({ inputRect: { left: 1100, top: 500, width: 300 }, viewportHeight: 700, viewportWidth: 1200 }).left, 892);
});

function makeApp(actions) {
    const dom = new JSDOM('<textarea id="messageInput"></textarea>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const input = doc.getElementById('messageInput');
    input.getBoundingClientRect = () => ({ left: 100, top: 500, width: 600, height: 40 });
    const sent = [];
    // 模拟 event-listeners.js 的冒泡阶段「Enter 发送」
    input.addEventListener('keydown', event => {
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' && !event.shiftKey) sent.push(input.value);
    });
    const slash = createSlashCommands({ document: doc, actions });
    slash.mount();
    const type = value => {
        input.value = value;
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    const press = (key, init = {}) => {
        const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        input.dispatchEvent(event);
        return event;
    };
    return { dom, doc, input, slash, sent, type, press, popup: () => doc.querySelector('.vcp-slash-popup') };
}

test('typing "/" opens the list, arrows move, Enter runs the command and clears the draft without sending', () => {
    const calls = [];
    const { input, slash, sent, type, press, popup } = makeApp({
        newTopic: () => calls.push('new'),
        sideChat: () => calls.push('side'),
        globalSearch: () => calls.push('search')
    });
    assert.equal(popup().hidden, true);

    type('/');
    assert.equal(popup().hidden, false);
    assert.deepEqual(slash.getState().items, ['new', 'side', 'search']);
    assert.equal(popup().style.bottom, '276px');

    const down = press('ArrowDown');
    assert.equal(down.defaultPrevented, true);
    assert.equal(slash.getState().activeIndex, 1);
    press('ArrowUp');
    press('ArrowUp');
    assert.equal(slash.getState().activeIndex, 2, 'wraps around');

    type('/si');
    assert.equal(slash.getState().activeIndex, 0, 'editing the query resets the highlight');
    assert.deepEqual(slash.getState().items, ['side']);
    const enter = press('Enter');
    assert.equal(enter.defaultPrevented, true);
    assert.deepEqual(calls, ['side']);
    assert.equal(input.value, '');
    assert.equal(popup().hidden, true);
    assert.deepEqual(sent, [], 'the send handler never saw the Enter');
});

test('Escape closes, unknown slash text and paths are sent as ordinary messages', () => {
    const { slash, sent, type, press, popup } = makeApp({ newTopic: () => {} });
    type('/n');
    assert.equal(popup().hidden, false);
    const escape = press('Escape');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(popup().hidden, true);

    type('/zzz');
    assert.equal(popup().hidden, true);
    press('Enter');
    type('/usr/bin');
    press('Enter');
    type('/new 带参数但 new 不接受参数');
    press('Enter');
    assert.deepEqual(sent, ['/zzz', '/usr/bin', '/new 带参数但 new 不接受参数']);
    assert.equal(slash.getState().open, false);
});

test('commands with arguments complete to "/name " and run on Enter with the argument', () => {
    const calls = [];
    const { input, sent, type, press, popup } = makeApp({ find: query => calls.push(query) });
    type('/f');
    press('Tab');
    assert.equal(input.value, '/find ');
    assert.equal(popup().hidden, true);
    assert.deepEqual(calls, [], 'not executed until the user confirms');

    type('/find 关键词');
    press('Enter', { shiftKey: true });
    assert.deepEqual(calls, [], 'Shift+Enter still means newline');
    press('Enter');
    assert.deepEqual(calls, ['关键词']);
    assert.equal(input.value, '');
    assert.deepEqual(sent, []);

    type('/find ');
    press('Enter');
    assert.deepEqual(calls, ['关键词', '']);
});

test('clicking an item runs it, IME composition is ignored, async failures are contained, dispose cleans up', async () => {
    const calls = [];
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => { if (String(args[0]).startsWith('[SlashCommands]')) errors.push(args); };
    try {
        const { dom, doc, input, slash, type, press, popup } = makeApp({
            newTopic: () => Promise.reject(new Error('boom')),
            globalSearch: () => calls.push('search')
        });
        type('/');
        const composing = press('Enter', { isComposing: true });
        assert.equal(composing.defaultPrevented, false);
        assert.equal(popup().hidden, false);

        const row = popup().querySelectorAll('.vcp-slash-item')[0];
        const mousedown = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
        row.dispatchEvent(mousedown);
        assert.equal(mousedown.defaultPrevented, true);
        row.click();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(errors.length, 1);
        assert.equal(input.value, '');

        type('/');
        input.dispatchEvent(new dom.window.Event('blur'));
        assert.equal(popup().hidden, true);

        slash.dispose();
        slash.dispose();
        assert.equal(doc.querySelector('.vcp-slash-popup'), null);
        type('/');
        assert.equal(doc.querySelector('.vcp-slash-popup'), null);
    } finally {
        console.error = originalError;
    }
});

test('mount is a no-op without an input or without any command', () => {
    const empty = new JSDOM('<div></div>');
    assert.equal(createSlashCommands({ document: empty.window.document, actions: { newTopic: () => {} } }).mount(), null);
    const dom = new JSDOM('<textarea id="messageInput"></textarea>');
    assert.equal(createSlashCommands({ document: dom.window.document, actions: {} }).mount(), null);
});
