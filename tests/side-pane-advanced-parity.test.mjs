import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import * as SidePaneState from '../modules/ui-system/side-pane/side-pane-state.js';
import { createSidePaneController } from '../modules/ui-system/side-pane/side-pane-controller.js';
import { mountSideChatSurface } from '../modules/renderer/sideChatSurfaceOwner.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function createParityTestDOM() {
    return new JSDOM(`
        <div class="main-content">
            <div class="chat-messages" id="chatMessages"></div>
        </div>
        <button id="toggleSidePaneChatBtn" type="button"></button>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <button id="sidePaneTabOverviewBtn" class="side-pane-action-btn" type="button"></button>
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                    <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button"></button>
                </div>
                <div id="sidePaneTabOverviewPopover" class="side-pane-tab-overview-popover" role="dialog" hidden>
                    <div id="sidePaneOpenTabsList"></div>
                </div>
                <div id="sidePaneTabContextMenu" class="side-pane-context-menu" role="menu" hidden>
                    <button type="button" role="menuitem" data-action="close-tab">关闭当前标签页</button>
                    <button type="button" role="menuitem" data-action="close-others">关闭其他标签页</button>
                    <button type="button" role="menuitem" data-action="close-all">关闭所有标签页</button>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
                <section class="side-pane-view" id="sidePaneViewLauncher" data-tab-id="launcher" hidden>
                    <form class="side-pane-launcher-address" hidden><input type="text"></form>
                    <p class="side-pane-launcher-address-error" hidden></p>
                    <section data-launcher-section="tools"><div class="side-pane-open-tab-list"></div></section>
                </section>
            </div>
        </aside>
    `);
}

const createDesc = (id = 's1', child = 'child-1', parentTopic = 'parent') => ({
    id,
    title: `侧聊-${id}`,
    parent: { itemType: 'agent', itemId: 'agent-1', topicId: parentTopic, name: 'Agent' },
    child: { itemType: 'agent', itemId: 'agent-1', topicId: child },
    contextMode: 'references-only'
});

const mockChatProvider = (disposed = []) => ({
    async mountTab(desc) {
        return {
            focus() {},
            async requestClose() { return { closed: true }; },
            async dispose() { disposed.push(desc.id); }
        };
    }
});

function createController(dom, options = {}) {
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    return createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        toggleChatBtn: doc.getElementById('toggleSidePaneChatBtn'),
        addChatTabBtn: doc.getElementById('addSidePaneChatBtn'),
        providers: { chat: mockChatProvider(options.disposed) },
        ...options.controller
    });
}

test('Parity: closing the last closable tab of the conversation collapses the pane', () => {
    const parent = { itemType: 'agent', itemId: 'agent-1', topicId: 'parent' };
    let s = SidePaneState.setParent(SidePaneState.createInitialSidePaneState({ visible: true }), parent);
    s = SidePaneState.openChatTab(s, createDesc('s1', 'c1'));
    s = SidePaneState.openChatTab(s, createDesc('other', 'c9', 'other-topic'));
    assert.deepEqual(SidePaneState.getClosableVisibleTabs(s).map(t => t.id), ['s1']);

    // 另一个话题的标签不算：关掉 s1 后当前对话已经没有可关的标签
    const closed = SidePaneState.closeTab(s, 's1');
    assert.equal(closed.visible, false);
    assert.equal(closed.activeTabId, SidePaneState.NOTIFICATIONS_TAB_ID);
    assert.ok(closed.tabs.some(t => t.id === 'other'));

    // 批量关闭时中间步骤不收起
    const kept = SidePaneState.closeTab(s, 's1', { collapseWhenEmpty: false });
    assert.equal(kept.visible, true);

    // 通知页不能关
    assert.equal(SidePaneState.closeTab(s, SidePaneState.NOTIFICATIONS_TAB_ID), s);
});

test('Parity: close-others and close-all only touch the current conversation', async () => {
    const dom = createParityTestDOM();
    const disposed = [];
    const ctrl = createController(dom, { disposed });

    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'other-topic' });
    await ctrl.openChat(createDesc('other', 'c9', 'other-topic'));
    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openChat(createDesc('s1', 'c1'));
    await ctrl.openChat(createDesc('s2', 'c2'));
    await ctrl.openChat(createDesc('s3', 'c3'));

    await ctrl.closeOtherTabs('s2');
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id).sort(), ['notifications', 'other', 's2']);
    assert.equal(ctrl.getSnapshot().activeTabId, 's2');
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.deepEqual(disposed.sort(), ['s1', 's3']);

    await ctrl.closeAllTabs();
    assert.ok(disposed.includes('s2'));
    assert.equal(disposed.includes('other'), false, '别的话题的标签不受影响');
    assert.equal(ctrl.getSnapshot().visible, false, '当前对话的标签全关后收起');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the add button opens the new tab page with tool rows', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const addBtn = doc.getElementById('addSidePaneChatBtn');
    const launcherView = doc.getElementById('sidePaneViewLauncher');
    const toolsSection = launcherView.querySelector('[data-launcher-section="tools"]');
    const opened = [];
    const ctrl = createController(dom);

    // 没有入口：按钮和工具区都隐藏
    assert.equal(addBtn.hidden, true);
    assert.equal(toolsSection.hidden, true);

    // 一个入口：直接打开，不进新标签页
    const disposeChat = ctrl.registerOpenTabEntry({ id: 'chat', label: '辅助对话', icon: 'chat_bubble', open: () => opened.push('chat') });
    assert.equal(addBtn.hidden, false);
    assert.equal(addBtn.getAttribute('aria-label'), '辅助对话');
    addBtn.click();
    await tick();
    assert.deepEqual(opened, ['chat']);
    assert.notEqual(ctrl.getSnapshot().activeTabId, 'launcher');

    // 两个入口：打开新标签页，工具按 order 排成列表
    ctrl.registerOpenTabEntry({ id: 'browser', label: '浏览器', order: 50, open: () => opened.push('browser') });
    assert.equal(addBtn.getAttribute('aria-label'), '新标签页');
    assert.equal(addBtn.hasAttribute('aria-haspopup'), false);
    addBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');
    assert.equal(launcherView.hidden, false);
    assert.equal(toolsSection.hidden, false);
    const rows = [...launcherView.querySelectorAll('[data-open-tab-entry]')];
    assert.deepEqual(rows.map(r => r.querySelector('.side-pane-open-tab-button-label').textContent), ['浏览器', '辅助对话']);

    rows[1].click();
    await tick();
    assert.deepEqual(opened, ['chat', 'chat']);

    // 注销后回到单入口
    disposeChat();
    assert.equal(addBtn.getAttribute('aria-label'), '浏览器');
    assert.equal(launcherView.querySelectorAll('[data-open-tab-entry]').length, 1);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the new tab page address bar hands the text to the handler', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const form = doc.querySelector('.side-pane-launcher-address');
    const input = form.querySelector('input');
    const error = doc.querySelector('.side-pane-launcher-address-error');
    const submitted = [];
    const ctrl = createController(dom, {
        controller: {
            openTabEntries: [
                { id: 'chat', label: '辅助对话', open() {} },
                { id: 'browser', label: '浏览器', open() {} }
            ]
        }
    });

    // 没有处理函数时不显示地址栏
    assert.equal(form.hidden, true);
    ctrl.setLauncherAddressHandler(async (text) => {
        submitted.push(text);
        return text.startsWith('javascript:') ? { error: '不支持' } : { url: text };
    });
    assert.equal(form.hidden, false);

    doc.getElementById('addSidePaneChatBtn').click();
    await tick();
    assert.equal(doc.activeElement, input, '打开新标签页后焦点在地址栏');

    const submit = async (value) => {
        input.value = value;
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await tick();
    };

    await submit('   ');
    assert.deepEqual(submitted, [], '空白不提交');

    await submit('javascript:alert(1)');
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, '不支持');
    assert.equal(input.value, 'javascript:alert(1)', '出错时保留输入');

    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    assert.equal(error.hidden, true, '继续输入就清掉错误');

    await submit(' example.com ');
    assert.deepEqual(submitted, ['javascript:alert(1)', 'example.com']);
    assert.equal(input.value, '', '打开后清空');

    ctrl.setLauncherAddressHandler(null);
    assert.equal(form.hidden, true);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: entries can hide themselves with isAvailable', () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    let available = false;
    const ctrl = createController(dom, {
        controller: { openTabEntries: [{ id: 'x', label: 'X', open() {}, isAvailable: () => available }] }
    });
    assert.equal(doc.getElementById('addSidePaneChatBtn').hidden, true);
    available = true;
    ctrl.refreshOpenTabEntries();
    assert.equal(doc.getElementById('addSidePaneChatBtn').hidden, false);
    assert.throws(() => ctrl.registerOpenTabEntry({ id: 'bad' }), TypeError);
    ctrl.dispose();
    dom.window.close();
});

test('Parity: tab context menu is scoped, keyboard friendly and closes on Escape', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const tabList = doc.querySelector('.side-pane-tabs');
    const contextMenu = doc.getElementById('sidePaneTabContextMenu');
    const ctrl = createController(dom);

    ctrl.setParent({ itemType: 'agent', itemId: 'agent-1', topicId: 'parent' });
    await ctrl.openChat(createDesc('s1', 'c1'));

    const openMenuOn = (tabId) => tabList.querySelector(`[data-tab-id="${tabId}"]`).dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { clientX: 200, clientY: 100, bubbles: true, cancelable: true }));
    const isDisabled = (action) => contextMenu.querySelector(`[data-action="${action}"]`).disabled;

    // 只有一个可关的标签：关闭其他不可用
    openMenuOn('s1');
    assert.equal(contextMenu.hidden, false);
    assert.equal(isDisabled('close-tab'), false);
    assert.equal(isDisabled('close-others'), true);
    assert.equal(isDisabled('close-all'), false);
    assert.equal(doc.activeElement, contextMenu.querySelector('[data-action="close-tab"]'));

    // 方向键在可用项之间移动
    contextMenu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.activeElement, contextMenu.querySelector('[data-action="close-all"]'));

    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(contextMenu.hidden, true);

    // 通知页不能关，但能关掉其他
    openMenuOn('notifications');
    assert.equal(isDisabled('close-tab'), true);
    assert.equal(isDisabled('close-others'), false);

    await ctrl.openChat(createDesc('s2', 'c2'));
    openMenuOn('s1');
    contextMenu.querySelector('[data-action="close-others"]').click();
    await tick();
    assert.equal(contextMenu.hidden, true);
    assert.deepEqual(ctrl.getSnapshot().tabs.map(t => t.id), ['notifications', 's1']);
    assert.equal(ctrl.getSnapshot().activeTabId, 's1');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: the expand button shows the launcher when several entries exist', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const toggleBtn = doc.getElementById('toggleSidePaneChatBtn');
    const launcherView = doc.getElementById('sidePaneViewLauncher');
    const opened = [];
    const ctrl = createController(dom, {
        controller: {
            openTabEntries: [
                { id: 'chat', label: '辅助对话', open: () => opened.push('chat') },
                { id: 'browser', label: '浏览器', open: () => opened.push('browser') }
            ]
        }
    });

    assert.equal(toggleBtn.hidden, false);
    toggleBtn.click();
    await tick();
    assert.equal(ctrl.getSnapshot().visible, true);
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');
    assert.equal(launcherView.hidden, false);
    assert.equal(doc.getElementById('sidePaneViewNotifications').hidden, true);
    assert.equal(toggleBtn.hidden, true, '面板展开后标题栏按钮隐藏');

    const buttons = launcherView.querySelectorAll('[data-open-tab-entry]');
    assert.equal(buttons.length, 2);
    buttons[1].click();
    await tick();
    assert.deepEqual(opened, ['browser']);

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: Side Chat Model Picker supports interactive switching', async () => {
    const dom = new JSDOM('<div id="mount"></div>');
    const doc = dom.window.document;

    let selected;
    const caps = {
        repository: { getHistory: async () => [], saveHistory: async () => ({ success: true }) },
        createRenderer({ conversation }) {
            selected = conversation.selectedItem;
            return {
                renderer: { renderHistory: async () => {} },
                conversation: { selectedItemRef: { get: () => selected }, topicIdRef: { get: () => 'c1' }, historyRef: { get: () => [] } },
                dispose: async () => {}
            };
        },
        manager: { sendMessage: async () => ({ terminal: { event: { type: 'completed' } } }) },
        listModels: async () => ({ ids: ['claude-3-5-sonnet', 'gemini-1.5-pro'], favorites: new Set() })
    };

    const handle = await mountSideChatSurface(doc.getElementById('mount'), {
        descriptor: createDesc('s1', 'c1'),
        chatCapabilities: caps
    });
    await tick();

    const pickerBtn = doc.querySelector('.side-chat-model-picker-btn');
    const popover = doc.querySelector('.side-chat-model-popover');
    assert.ok(pickerBtn, 'Should have model picker button');
    assert.ok(popover, 'Should have model popover');

    // Click button to toggle popover
    pickerBtn.click();
    await tick();
    assert.equal(popover.hidden, false);

    // Click claude-3-5-sonnet
    const claudeItem = popover.querySelector('[data-model="claude-3-5-sonnet"]');
    assert.ok(claudeItem);
    claudeItem.click();

    assert.equal(handle.getModel(), 'claude-3-5-sonnet');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'claude-3-5-sonnet');
    assert.equal(popover.hidden, true);

    // Direct setModel via handle
    handle.setModel('gemini-1.5-pro');
    assert.equal(handle.getModel(), 'gemini-1.5-pro');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'gemini-1.5-pro');

    await handle.dispose();
    dom.window.close();
});

test('Side pane divider and header hairlines', () => {
    const css = fs.readFileSync(new URL('../styles/ui-system/side-pane.css', import.meta.url), 'utf8');

    // The pane sits inside the workspace card, so its only edge is a hairline
    // on the left, drawn with the same token as the card border.
    assert.match(css, /html #vcpSidePane:where\(\.vcp-ui-scope, \.vcp-ui-scope \*\) \{[^}]*border-left:\s*1px solid var\(--next-panel-edge/);
    // Main panel and main content are outside .vcp-ui-scope: scoped rules for
    // them would never match, so the side pane stylesheet must not carry any.
    assert.doesNotMatch(css, /#nextUiMainPanel:where\(\.vcp-ui-scope/);
    assert.doesNotMatch(css, /\.main-content[^{]*:where\(\.vcp-ui-scope/);

    assert.match(css, /html \.side-pane-tab-bar[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
    // VCPLog status lives on the 通知 tab, so the panel has no second header row.
    assert.doesNotMatch(css, /\.notifications-header/);
});
