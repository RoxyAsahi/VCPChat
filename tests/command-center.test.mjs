import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
    resolveQueryScope,
    readSearchHistory,
    pushSearchHistory,
    clearSearchHistory,
    filterCommands,
    buildConversationItems,
    toFileItem,
    createCommandCenter
} from '../modules/ui-system/command-center.js';

const wait = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

function memoryStorage() {
    const map = new Map();
    return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)) };
}

test('resolveQueryScope reads > # @ prefixes', () => {
    assert.deepEqual(resolveQueryScope('  hello '), { query: 'hello', scope: 'all', explicitScope: false });
    assert.deepEqual(resolveQueryScope('> new topic'), { query: 'new topic', scope: 'commands', explicitScope: true });
    assert.deepEqual(resolveQueryScope('#周报'), { query: '周报', scope: 'conversations', explicitScope: true });
    assert.deepEqual(resolveQueryScope('@ readme'), { query: 'readme', scope: 'files', explicitScope: true });
    assert.deepEqual(resolveQueryScope('@'), { query: '', scope: 'files', explicitScope: true });
});

test('search history dedupes by query, caps at 20 and ignores empty / bare-prefix queries', () => {
    const storage = memoryStorage();
    assert.deepEqual(readSearchHistory(storage), []);
    pushSearchHistory(storage, '  ', 'all', 1);
    pushSearchHistory(storage, '>', 'commands', 1);
    assert.deepEqual(readSearchHistory(storage), []);
    pushSearchHistory(storage, 'Alpha', 'all', 1);
    pushSearchHistory(storage, 'beta', 'files', 2);
    pushSearchHistory(storage, 'alpha', 'conversations', 3);
    assert.deepEqual(readSearchHistory(storage).map(entry => [entry.query, entry.scope]), [['alpha', 'conversations'], ['beta', 'files']]);
    for (let index = 0; index < 30; index += 1) pushSearchHistory(storage, `q${index}`, 'all', 10 + index);
    assert.equal(readSearchHistory(storage).length, 20);
    assert.equal(readSearchHistory(storage)[0].query, 'q29');
    storage.setItem('vcp-command-center-search-history', '{not json');
    assert.deepEqual(readSearchHistory(storage), []);
    storage.setItem('vcp-command-center-search-history', JSON.stringify([{ query: 'x', scope: 'bogus', updatedAt: 1 }, { query: 'ok', scope: 'all', updatedAt: 1 }]));
    assert.deepEqual(readSearchHistory(storage).map(entry => entry.query), ['ok']);
    clearSearchHistory(storage);
    assert.deepEqual(readSearchHistory(storage), []);
});

test('filterCommands ranks title prefix before keyword and description matches', () => {
    const commands = [
        { id: 'a', title: '切换明暗主题', description: '主题', keywords: ['theme'] },
        { id: 'b', title: '选择主题', description: '', keywords: [] },
        { id: 'c', title: '全局设置', description: '外观与主题', keywords: ['settings'] }
    ];
    assert.deepEqual(filterCommands(commands, '').map(c => c.id), ['a', 'b', 'c']);
    assert.deepEqual(filterCommands(commands, '主题').map(c => c.id), ['a', 'b', 'c']);
    assert.deepEqual(filterCommands(commands, '选择').map(c => c.id), ['b']);
    assert.deepEqual(filterCommands(commands, 'THEME').map(c => c.id), ['a']);
    assert.deepEqual(filterCommands(commands, 'zzz'), []);
});

test('buildConversationItems matches agent / group names and topic names', () => {
    const agents = [
        { id: 'a1', name: 'Nova', topics: [{ id: 't1', name: '周报整理' }, { id: 't2', name: '闲聊' }] },
        { id: 'a2', name: '周报助手', topics: [] }
    ];
    const groups = [{ id: 'g1', name: '项目群', topics: [{ id: 'gt', name: '周报讨论' }] }];
    assert.deepEqual(buildConversationItems(agents, groups, '').map(row => row.id), ['agent:a1', 'agent:a2', 'group:g1']);
    const rows = buildConversationItems(agents, groups, '周报');
    assert.deepEqual(rows.map(row => row.id), ['agent:a2', 'agent:a1:t1', 'group:g1:gt']);
    const topicRow = rows[1];
    assert.equal(topicRow.topicId, 't1');
    assert.equal(topicRow.itemId, 'a1');
    assert.equal(topicRow.subtitle, '助手 · Nova');
    assert.equal(rows[2].itemType, 'group');
});

test('toFileItem splits the relative path into a subtitle', () => {
    const item = toFileItem({ name: 'a.js', path: 'C:/w/src/a.js', relPath: 'src\\a.js', alias: 'proj' });
    assert.equal(item.title, 'a.js');
    assert.equal(item.subtitle, 'proj/src');
    assert.equal(toFileItem({ name: 'b.md', path: '/w/b.md', relPath: 'b.md', alias: 'proj' }).subtitle, 'proj');
});

function makeCenter(overrides = {}) {
    const dom = new JSDOM('<body><textarea id="messageInput"></textarea></body>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const log = [];
    const storage = memoryStorage();
    const commands = [
        { id: 'new', title: '新建话题', description: '', keywords: ['new'], run: () => log.push('new') },
        { id: 'theme', title: '切换明暗主题', description: '', keywords: ['theme'], run: () => log.push('theme') }
    ];
    const center = createCommandCenter({
        document: doc,
        storage,
        getCommands: () => commands,
        loadConversationSources: async () => ({
            agents: [{ id: 'a1', name: 'Nova', avatarUrl: 'x.png', topics: [{ id: 't1', name: '新年计划' }] }],
            groups: []
        }),
        selectConversation: async row => log.push(`select:${row.itemId}:${row.topicId || ''}`),
        searchFiles: async query => [{ name: `${query}.md`, path: `/w/${query}.md`, relPath: `docs/${query}.md`, alias: 'proj' }],
        openFile: async file => log.push(`open:${file.path}`),
        debounceMs: 5,
        ...overrides
    });
    center.mount();
    const win = dom.window;
    const input = doc.querySelector('.vcp-cc-input');
    const type = value => { input.value = value; input.dispatchEvent(new win.Event('input', { bubbles: true })); };
    const key = (k, init = {}) => input.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
    const ctrlK = () => {
        const event = new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
        win.dispatchEvent(event);
        return event;
    };
    const titles = () => [...doc.querySelectorAll('.vcp-cc-row-title')].map(node => node.textContent);
    return { dom, doc, win, center, input, type, key, ctrlK, titles, log, storage };
}

test('Ctrl+K toggles the dialog; Escape closes and restores focus', () => {
    const { doc, center, ctrlK, key } = makeCenter();
    const composer = doc.getElementById('messageInput');
    composer.focus();
    const overlay = doc.querySelector('.vcp-cc-overlay');
    assert.equal(overlay.hidden, true);
    assert.equal(ctrlK().defaultPrevented, true);
    assert.equal(overlay.hidden, false);
    assert.equal(doc.activeElement, doc.querySelector('.vcp-cc-input'));
    key('Escape');
    assert.equal(overlay.hidden, true);
    assert.equal(doc.activeElement, composer);
    ctrlK();
    ctrlK();
    assert.equal(overlay.hidden, true);
    assert.equal(center.getState().open, false);
});

test('empty query lists commands only; typing searches commands, conversations and files together', async () => {
    const { doc, titles, type, center, ctrlK } = makeCenter();
    ctrlK();
    assert.deepEqual(titles(), ['新建话题', '切换明暗主题']);
    assert.equal(doc.querySelectorAll('.vcp-cc-section').length, 1);

    type('新');
    await wait();
    assert.deepEqual([...doc.querySelectorAll('.vcp-cc-section')].map(s => s.dataset.section), ['commands', 'conversations', 'files']);
    assert.deepEqual(titles(), ['新建话题', '新年计划', '新.md']);
    assert.equal(center.getState().rows.length, 3);
});

test('prefixes and tabs restrict the scope; the "more" row switches scope', async () => {
    const { doc, titles, type, input, ctrlK } = makeCenter({
        getCommands: () => Array.from({ length: 8 }, (_, index) => ({ id: `c${index}`, title: `命令${index}`, description: '', keywords: [], run() {} }))
    });
    ctrlK();
    assert.equal(titles().length, 5, '"all" shows 5 per section');
    const more = doc.querySelector('.vcp-cc-more');
    assert.equal(more.textContent, '查看全部 8 项');
    more.click();
    assert.equal(titles().length, 8);
    assert.equal(doc.querySelector('.vcp-cc-tab.active').dataset.scope, 'commands');

    type('#nova');
    await wait();
    assert.equal(doc.querySelector('.vcp-cc-tab.active').dataset.scope, 'conversations');
    assert.deepEqual(titles(), ['Nova']);

    type('@guide');
    await wait();
    assert.deepEqual(titles(), ['guide.md']);
    doc.querySelector('.vcp-cc-tab[data-scope="all"]').click();
    assert.equal(input.value, 'guide', 'switching tab strips the explicit prefix');
});

test('Enter runs the active item, records history and closes; arrows and Tab navigate', async () => {
    const { doc, type, key, log, storage, ctrlK, center } = makeCenter();
    ctrlK();
    type('新');
    await wait();
    key('ArrowDown');
    assert.equal(center.getState().activeIndex, 1);
    key('Enter');
    await wait();
    assert.deepEqual(log, ['select:a1:t1']);
    assert.equal(doc.querySelector('.vcp-cc-overlay').hidden, true);
    assert.deepEqual(readSearchHistory(storage).map(entry => entry.query), ['新']);

    ctrlK();
    assert.equal(doc.querySelectorAll('.vcp-cc-chip').length, 2, 'history chip + clear');
    doc.querySelector('.vcp-cc-chip').click();
    assert.equal(doc.querySelector('.vcp-cc-input').value, '新');
    key('Tab');
    assert.equal(center.getState().scope, 'commands');
    key('Enter');
    await wait();
    assert.deepEqual(log, ['select:a1:t1', 'new']);
    assert.deepEqual(readSearchHistory(storage).map(entry => `${entry.scope}:${entry.query}`), ['commands:新']);

    // 文件结果走 openFile
    ctrlK();
    type('@readme');
    await wait();
    key('Enter');
    await wait();
    assert.equal(log.at(-1), 'open:/w/readme.md');
});

test('stale async results are dropped and failures are surfaced', async () => {
    const notices = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { titles, type, key, ctrlK } = makeCenter({
        searchFiles: async (query) => {
            if (query === 'slow') { await gate; return [{ name: 'old.md', path: '/old.md', relPath: 'old.md', alias: 'p' }]; }
            return [{ name: 'new.md', path: '/new.md', relPath: 'new.md', alias: 'p' }];
        },
        notify: (...args) => notices.push(args),
        getCommands: () => [{ id: 'bad', title: '会失败', description: '', keywords: [], run() { throw new Error('boom'); } }]
    });
    ctrlK();
    type('@slow');
    await wait();
    type('@fast');
    await wait();
    release();
    await wait();
    assert.deepEqual(titles(), ['new.md']);

    const originalError = console.error;
    console.error = () => {};
    try {
        type('');
        key('Enter');
        await wait();
    } finally {
        console.error = originalError;
    }
    assert.equal(notices.length, 1);
    assert.equal(notices[0][1], 'error');
});

test('dispose removes the overlay and the shortcut', () => {
    const { doc, center, ctrlK } = makeCenter();
    center.dispose();
    center.dispose();
    assert.equal(doc.querySelector('.vcp-cc-overlay'), null);
    assert.equal(ctrlK().defaultPrevented, false);
});
