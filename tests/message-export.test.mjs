import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { stripThoughtChains, contentToText, buildMarkdown, rangeBetween, createMessageExport } from '../modules/ui-system/message-export.js';

const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

test('stripThoughtChains removes VCP chains and <think> blocks but keeps the answer', () => {
    assert.equal(stripThoughtChains('<think>\n内部推理\n</think>\n答案'), '答案');
    assert.equal(stripThoughtChains('[--- VCP元思考链: "x" ---]\nabc\n[--- 元思考链结束 ---]\n正文'), '正文');
    assert.equal(stripThoughtChains('a <think>inline</think> b'), 'a  b');
    assert.equal(stripThoughtChains(null), '');
});

test('contentToText handles strings, part arrays and {text}', () => {
    assert.equal(contentToText('hi'), 'hi');
    assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }, 'b']), 'a\nb');
    assert.equal(contentToText({ text: 'x' }), 'x');
    assert.equal(contentToText(undefined), '');
});

test('buildMarkdown writes a header and one section per message, without a trailing rule', () => {
    const markdown = buildMarkdown({
        title: '周报',
        exportedAt: new Date(2026, 9, 1, 8, 5).getTime(),
        messages: [
            { sender: '用户', timestamp: new Date(2026, 9, 1, 7, 30).getTime(), content: '你好' },
            { sender: 'Nova', timestamp: null, content: '```js\nlet a = 1;\n```' }
        ]
    });
    assert.equal(markdown, [
        '# 周报', '', '> 导出时间：2026-10-01 08:05　共 2 条消息', '',
        '### 用户 · 2026-10-01 07:30', '', '你好', '', '---', '',
        '### Nova', '', '```js', 'let a = 1;', '```', ''
    ].join('\n'));
});

test('rangeBetween is order-independent and ignores unknown ids', () => {
    assert.deepEqual(rangeBetween(['a', 'b', 'c', 'd'], 'd', 'b'), ['b', 'c', 'd']);
    assert.deepEqual(rangeBetween(['a', 'b'], 'a', 'zz'), []);
});

function makeApp(overrides = {}) {
    const dom = new JSDOM(`<div id="chatMessages">
        <div class="message-item system" data-message-id="s0"><div class="md-content">系统</div></div>
        <div class="message-item user" data-message-id="m1"><span class="sender-name">用户:</span><div class="md-content">渲染文本一</div></div>
        <div class="message-item assistant" data-message-id="m2"><span class="sender-name">Nova</span><div class="md-content">渲染文本二</div></div>
        <div class="message-item assistant" data-message-id="m3"><span class="sender-name">Nova</span><div class="md-content">只有渲染文本</div></div>
    </div>`, { pretendToBeVisual: true });
    const doc = dom.window.document;
    const root = doc.getElementById('chatMessages');
    const log = { copied: [], saved: [], notes: [] };
    const exporter = createMessageExport({
        document: doc,
        messagesRoot: root,
        getHistory: () => [
            { id: 'm1', role: 'user', content: '**原始** markdown', timestamp: new Date(2026, 9, 1, 9, 0).getTime() },
            { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '<think>\nx\n</think>\n回答' }] }
        ],
        getTitle: () => '测试话题',
        copyText: async text => { log.copied.push(text); },
        saveMarkdown: async payload => { log.saved.push(payload); return { success: true, path: 'C:/out.md' }; },
        notify: (...args) => log.notes.push(args),
        ...overrides
    });
    exporter.mount();
    const win = dom.window;
    const click = (id, init = {}) => root.querySelector(`[data-message-id="${id}"]`).dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    const buttons = () => Object.fromEntries([...doc.querySelectorAll('.vcp-export-dock button')].map(button => [button.textContent, button]));
    return { dom, doc, root, exporter, log, click, buttons, win };
}

test('selection mode decorates selectable messages, toggles by click and Shift-range', () => {
    const { doc, root, exporter, click, buttons } = makeApp();
    const dock = doc.querySelector('.vcp-export-dock');
    assert.equal(dock.hidden, true);
    assert.equal(exporter.start(), true);
    assert.equal(dock.hidden, false);
    assert.equal(root.classList.contains('vcp-export-mode'), true);
    assert.equal(root.querySelectorAll('.vcp-export-check').length, 3, 'system messages are not selectable');
    assert.equal(buttons()['复制 Markdown'].disabled, true);

    click('m1');
    assert.deepEqual(exporter.getState().selected, ['m1']);
    assert.equal(doc.querySelector('.vcp-export-count').textContent, '已选 1 / 共 3 条');
    click('s0');
    assert.deepEqual(exporter.getState().selected, ['m1'], 'system rows ignore clicks');
    click('m3', { shiftKey: true });
    assert.deepEqual(exporter.getState().selected.sort(), ['m1', 'm2', 'm3']);
    click('m2');
    assert.deepEqual(exporter.getState().selected.sort(), ['m1', 'm3']);

    buttons()['全选'].click();
    assert.equal(exporter.getState().selected.length, 3);
    assert.equal(buttons()['取消全选'] !== undefined, true);
    buttons()['取消全选'].click();
    assert.equal(exporter.getState().selected.length, 0);
});

test('copy builds Markdown from raw history (falls back to rendered text) and leaves selection mode', async () => {
    const { doc, root, exporter, click, buttons, log } = makeApp();
    exporter.start();
    ['m1', 'm2', 'm3'].forEach(id => click(id));
    buttons()['复制 Markdown'].click();
    await wait();
    assert.equal(log.copied.length, 1);
    const markdown = log.copied[0];
    assert.match(markdown, /^# 测试话题\n/u);
    assert.match(markdown, /### 用户 · 2026-10-01 09:00\n\n\*\*原始\*\* markdown\n/u);
    assert.match(markdown, /### Nova\n\n回答\n/u, 'thought chain stripped from the raw text');
    assert.match(markdown, /### Nova\n\n只有渲染文本\n/u, 'no history record: rendered text');
    assert.equal(log.notes.at(-1)[1], 'success');
    assert.equal(exporter.getState().active, false);
    assert.equal(root.classList.contains('vcp-export-mode'), false);
    assert.equal(root.querySelectorAll('.vcp-export-check').length, 0);
    assert.equal(doc.querySelector('.vcp-export-dock').hidden, true);
});

test('save passes topic name and markdown to the export API; cancelling the dialog keeps the selection', async () => {
    let result = { success: false, error: '用户取消了导出操作。' };
    const { exporter, click, buttons, log } = makeApp({
        saveMarkdown: async payload => { log.saved.push(payload); return result; }
    });
    exporter.start();
    click('m1');
    buttons()['保存为 .md'].click();
    await wait();
    assert.equal(log.saved[0].topicName, '测试话题');
    assert.match(log.saved[0].markdownContent, /\*\*原始\*\* markdown/u);
    assert.equal(exporter.getState().active, true, 'cancelled dialog: stay in selection mode');
    assert.equal(log.notes.length, 0);

    result = { success: true, path: 'C:/out.md' };
    buttons()['保存为 .md'].click();
    await wait();
    assert.equal(exporter.getState().active, false);
    assert.match(log.notes.at(-1)[0], /C:\/out\.md/u);
});

test('Escape and 取消 leave the mode; new messages get a checkbox; dispose cleans up', async () => {
    const { doc, root, win, exporter, buttons } = makeApp();
    exporter.start();
    const added = doc.createElement('div');
    added.className = 'message-item assistant';
    added.dataset.messageId = 'm4';
    added.innerHTML = '<div class="md-content">新来的</div>';
    root.appendChild(added);
    await wait();
    assert.equal(added.querySelector('.vcp-export-check') !== null, true);
    assert.equal(doc.querySelector('.vcp-export-count').textContent, '已选 0 / 共 4 条');

    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(exporter.getState().active, false);
    exporter.start();
    buttons()['取消'].click();
    assert.equal(exporter.getState().active, false);

    exporter.dispose();
    exporter.dispose();
    assert.equal(doc.querySelector('.vcp-export-dock'), null);
});

test('start refuses an empty conversation', () => {
    const { exporter, root, log } = makeApp();
    root.textContent = '';
    assert.equal(exporter.start(), false);
    assert.equal(log.notes[0][1], 'info');
});
