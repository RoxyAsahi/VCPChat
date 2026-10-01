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
            <div class="chat-messages" id="chatMessages">
                <button id="floatingSelectionSideChatBtn" class="floating-selection-side-chat-btn" style="display:none;">在侧栏提问</button>
            </div>
        </div>
        <div class="resizer" id="resizerRight"></div>
        <aside id="vcpSidePane" class="vcp-side-pane">
            <header class="side-pane-tab-bar">
                <button id="sidePaneTabOverviewBtn" class="side-pane-action-btn" type="button"></button>
                <div class="side-pane-tabs" role="tablist"></div>
                <div class="side-pane-tab-actions">
                    <button id="addSidePaneChatBtn" class="side-pane-action-btn" type="button"></button>
                    <button id="closeSidePaneBtn" class="side-pane-action-btn" type="button"></button>
                </div>
                <div id="sidePaneTabOverviewPopover" class="side-pane-tab-overview-popover" style="display:none;">
                    <div id="sidePaneOpenTabsList"></div>
                </div>
                <div id="sidePaneAddMenuPopover" class="side-pane-add-menu-popover" style="display:none;">
                    <button type="button" data-action="new-chat">新建辅助对话</button>
                    <button type="button" data-action="notifications">系统通知</button>
                    <button type="button" data-action="launcher">打开标签页引导...</button>
                </div>
                <div id="sidePaneTabContextMenu" class="side-pane-context-menu" style="display:none;">
                    <button type="button" data-action="close-tab">关闭当前标签页</button>
                    <button type="button" data-action="close-others">关闭其他标签页</button>
                    <button type="button" data-action="close-all">关闭所有标签页</button>
                </div>
            </header>
            <div class="side-pane-content-container">
                <section class="side-pane-view active" id="sidePaneViewNotifications" data-tab-id="notifications"></section>
                <section class="side-pane-view" id="sidePaneViewLauncher" data-tab-id="launcher" style="display:none;">
                    <div class="side-pane-open-tab-shell">
                        <button type="button" data-side-pane-open-tab-item="selection-side-conversation">辅助对话</button>
                        <button type="button" data-side-pane-open-tab-item="notifications">系统通知</button>
                    </div>
                </section>
            </div>
        </aside>
    `);
}

const createDesc = (id = 's1', child = 'child-1') => ({
    id,
    title: `侧聊-${id}`,
    parent: { itemType: 'agent', itemId: 'agent-1', topicId: 'parent', name: 'Agent' },
    child: { itemType: 'agent', itemId: 'agent-1', topicId: child },
    contextMode: 'references-only'
});

test('Parity: SidePaneState closeOtherTabs and closeAllTabs transitions', () => {
    const s0 = SidePaneState.createInitialSidePaneState();
    const s1 = SidePaneState.openChatTab(s0, createDesc('s1', 'c1'));
    const s2 = SidePaneState.openChatTab(s1, createDesc('s2', 'c2'));
    assert.equal(s2.tabs.length, 3); // notifications, s1, s2

    // closeOtherTabs preserves notifications and target tab
    const sOthersClosed = SidePaneState.closeOtherTabs(s2, 's1');
    assert.equal(sOthersClosed.tabs.length, 2);
    assert.equal(sOthersClosed.tabs.some(t => t.id === 's1'), true);
    assert.equal(sOthersClosed.tabs.some(t => t.id === 's2'), false);
    assert.equal(sOthersClosed.activeTabId, 's1');

    // closeAllTabs closes all chat tabs and transitions active to launcher
    const sAllClosed = SidePaneState.closeAllTabs(s2);
    assert.equal(sAllClosed.tabs.length, 1);
    assert.equal(sAllClosed.tabs[0].id, 'notifications');
    assert.equal(sAllClosed.activeTabId, SidePaneState.LAUNCHER_TAB_ID);
});

test('Parity: SidePaneController closeOtherTabs and closeAllTabs dispose views and update DOM', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const content = root.querySelector('.side-pane-content-container');

    const disposedTabs = [];
    const mockChatProvider = {
        async mountTab(desc, view) {
            return {
                focus() {},
                async requestClose() { return { closed: true }; },
                async dispose() { disposedTabs.push(desc.id); }
            };
        }
    };

    let openedChatCount = 0;
    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: content,
        providers: { chat: mockChatProvider },
        onOpenSideChat: async () => { openedChatCount++; }
    });

    await ctrl.openChat(createDesc('s1', 'c1'));
    await ctrl.openChat(createDesc('s2', 'c2'));
    await ctrl.openChat(createDesc('s3', 'c3'));
    assert.equal(ctrl.getSnapshot().tabs.length, 4); // notifications + 3 chats

    // Close other tabs keeping s2
    await ctrl.closeOtherTabs('s2');
    assert.equal(ctrl.getSnapshot().tabs.length, 2);
    assert.equal(ctrl.getSnapshot().activeTabId, 's2');
    assert.ok(disposedTabs.includes('s1'));
    assert.ok(disposedTabs.includes('s3'));
    assert.equal(disposedTabs.includes('s2'), false);

    // Close all tabs -> transitions to launcher
    await ctrl.closeAllTabs();
    assert.ok(disposedTabs.includes('s2'));
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');

    const launcherView = doc.getElementById('sidePaneViewLauncher');
    assert.equal(launcherView.classList.contains('active'), true);
    assert.equal(launcherView.style.display, '');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: + Add Menu Popover opens and routes actions', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const addBtn = doc.getElementById('addSidePaneChatBtn');
    const addMenu = doc.getElementById('sidePaneAddMenuPopover');

    let newChatOpened = false;
    const ctrl = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        addChatTabBtn: addBtn,
        onOpenSideChat: async () => { newChatOpened = true; }
    });

    // Clicking + toggles addMenu
    addBtn.click();
    assert.equal(addMenu.style.display, 'flex');

    // Clicking new-chat triggers onOpenSideChat and hides menu
    const newChatBtn = addMenu.querySelector('[data-action="new-chat"]');
    newChatBtn.click();
    await tick();
    assert.equal(newChatOpened, true);
    assert.equal(addMenu.style.display, 'none');

    // Reopen menu and click launcher
    addBtn.click();
    assert.equal(addMenu.style.display, 'flex');
    const launcherBtn = addMenu.querySelector('[data-action="launcher"]');
    launcherBtn.click();
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: Tab Right-Click Context Menu triggers actions', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const tabList = root.querySelector('.side-pane-tabs');
    const contextMenu = doc.getElementById('sidePaneTabContextMenu');

    const ctrl = createSidePaneController({
        root,
        tabListElement: tabList,
        contentContainer: root.querySelector('.side-pane-content-container'),
        providers: {
            chat: { mountTab: async () => ({ focus() {}, async requestClose() { return { closed: true }; }, async dispose() {} }) }
        }
    });

    await ctrl.openChat(createDesc('s1', 'c1'));
    await ctrl.openChat(createDesc('s2', 'c2'));

    const s1TabItem = tabList.querySelector('[data-tab-id="s1"]');
    assert.ok(s1TabItem);

    // Dispatch contextmenu event on tab
    const event = new dom.window.MouseEvent('contextmenu', {
        clientX: 200,
        clientY: 100,
        bubbles: true,
        cancelable: true
    });
    s1TabItem.dispatchEvent(event);

    assert.equal(contextMenu.style.display, 'flex');

    // Click close-others in context menu
    const closeOthersBtn = contextMenu.querySelector('[data-action="close-others"]');
    closeOthersBtn.click();
    await tick();

    assert.equal(contextMenu.style.display, 'none');
    assert.equal(ctrl.getSnapshot().tabs.length, 2); // notifications and s1
    assert.equal(ctrl.getSnapshot().activeTabId, 's1');

    await ctrl.dispose();
    dom.window.close();
});

test('Parity: Open Tab Launcher buttons activate chat and notifications', async () => {
    const dom = createParityTestDOM();
    const doc = dom.window.document;
    const root = doc.getElementById('vcpSidePane');
    const launcherView = doc.getElementById('sidePaneViewLauncher');

    let chatOpened = false;
    const ctrl = createSidePaneController({
        root,
        tabListElement: root.querySelector('.side-pane-tabs'),
        contentContainer: root.querySelector('.side-pane-content-container'),
        onOpenSideChat: async () => { chatOpened = true; }
    });

    ctrl.showLauncher();
    assert.equal(ctrl.getSnapshot().activeTabId, 'launcher');

    // Click [辅助对话] in launcher
    const chatItem = launcherView.querySelector('[data-side-pane-open-tab-item="selection-side-conversation"]');
    chatItem.click();
    await tick();
    assert.equal(chatOpened, true);

    // Click [系统通知] in launcher
    const notifItem = launcherView.querySelector('[data-side-pane-open-tab-item="notifications"]');
    notifItem.click();
    await tick();
    assert.equal(ctrl.getSnapshot().activeTabId, 'notifications');

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
    assert.equal(popover.style.display, 'flex');

    // Click claude-3-5-sonnet
    const claudeItem = popover.querySelector('[data-model="claude-3-5-sonnet"]');
    assert.ok(claudeItem);
    claudeItem.click();

    assert.equal(handle.getModel(), 'claude-3-5-sonnet');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'claude-3-5-sonnet');
    assert.equal(popover.style.display, 'none');

    // Direct setModel via handle
    handle.setModel('gemini-1.5-pro');
    assert.equal(handle.getModel(), 'gemini-1.5-pro');
    assert.equal(doc.querySelector('.side-chat-model-name').textContent, 'gemini-1.5-pro');

    await handle.dispose();
    dom.window.close();
});

test('Parity: ZCode Subtle Border & Header Divider Contract', () => {
    const css = fs.readFileSync(new URL('../styles/ui-system/side-pane.css', import.meta.url), 'utf8');

    const tokens = fs.readFileSync(new URL('../styles/ui-system/tokens.css', import.meta.url), 'utf8');
    // Token declarations have one shared owner; consumers remain scoped.
    assert.match(tokens, /--zcode-panel-border:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/);
    assert.match(tokens, /--zcode-header-divider:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/);

    // Panel borders use var(--zcode-panel-border)
    assert.match(css, /html body #nextUiMainPanel[\s\S]*?border:\s*1px solid var\(--zcode-panel-border/);
    assert.match(css, /html body \.main-content\.side-pane-active[\s\S]*?border-right:\s*1px solid var\(--zcode-panel-border/);

    // Title / Header bottom dividers use var(--zcode-header-divider)
    assert.match(css, /html body \.chat-header[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
    assert.match(css, /html \.side-pane-tab-bar[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
    assert.match(css, /html #vcpSidePane \.notifications-header[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
    assert.match(css, /html \.side-chat-header[\s\S]*?border-bottom:\s*1px solid var\(--zcode-header-divider/);
});
