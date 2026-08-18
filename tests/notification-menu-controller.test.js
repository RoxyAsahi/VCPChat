const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { NotificationMenuController } = require('../modules/ui-system/next-shell/notification-menu-controller.js');

function fixture() {
    const dom = new JSDOM(`<!doctype html><body>
      <button id="nextUiNotificationMenuBtn" aria-expanded="false"></button>
      <div id="nextUiNotificationMenu" hidden role="menu">
        <button id="nextUiNotificationForum" role="menuitem"></button>
        <button id="nextUiNotificationMemo" role="menuitem"></button>
        <button id="nextUiNotificationFilterToggle" role="menuitemcheckbox" aria-checked="false"></button>
        <span id="nextUiNotificationFilterState"></span>
        <button id="nextUiNotificationClear" role="menuitem"></button>
      </div>
    </body>`, { pretendToBeVisual: true, url: 'file:///notification-menu.html' });
    const calls = [];
    const listeners = new Set();
    let enabled = false;
    const filterManager = {
        isFilterEnabled: () => enabled,
        subscribe(listener) {
            listeners.add(listener);
            listener({ enabled });
            return () => listeners.delete(listener);
        },
        publish(next) {
            enabled = next;
            listeners.forEach(listener => listener({ enabled }));
        },
    };
    const commands = {
        openForum: () => calls.push('forum'),
        openMemo: () => calls.push('memo'),
        toggleNotificationFilter: () => { calls.push('filter'); filterManager.publish(true); },
        openNotificationFilterSettings: () => calls.push('filter-settings'),
        clearNotifications: () => calls.push('clear'),
    };
    const controller = new NotificationMenuController({
        window: dom.window,
        document: dom.window.document,
        commands: () => commands,
        filterManager,
        showToast: (message, variant) => calls.push(`toast:${variant}:${message}`),
    });
    return { dom, calls, listeners, filterManager, controller };
}

test('notification menu owns open, command actions, keyboard navigation and filter state', async () => {
    const { dom, calls, listeners, filterManager, controller } = fixture();
    assert.equal(controller.mount(), true);
    const document = dom.window.document;
    const trigger = document.getElementById('nextUiNotificationMenuBtn');
    const menu = document.getElementById('nextUiNotificationMenu');
    trigger.click();
    assert.equal(menu.hidden, false);
    assert.equal(document.activeElement.id, 'nextUiNotificationForum');
    document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement.id, 'nextUiNotificationMemo');
    document.getElementById('nextUiNotificationFilterToggle').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['filter']);
    assert.equal(document.getElementById('nextUiNotificationFilterState').textContent, '开启');
    assert.equal(menu.hidden, true);
    assert.equal(listeners.size, 1);
    controller.open();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(menu.hidden, true);
    assert.equal(document.activeElement, trigger);
    filterManager.publish(false);
    assert.equal(document.getElementById('nextUiNotificationFilterState').textContent, '关闭');
    controller.dispose();
    assert.equal(listeners.size, 0);
    dom.window.close();
});

test('notification menu right-click and command failure close once without leaking listeners', async () => {
    const { dom, calls, controller } = fixture();
    let failed = false;
    controller.commands = () => ({
        openNotificationFilterSettings: () => calls.push('filter-settings'),
        openForum: () => { failed = true; throw new Error('controlled failure'); },
    });
    assert.equal(controller.mount(), true);
    const document = dom.window.document;
    const trigger = document.getElementById('nextUiNotificationMenuBtn');
    const menu = document.getElementById('nextUiNotificationMenu');
    trigger.click();
    document.getElementById('nextUiNotificationFilterToggle').dispatchEvent(new dom.window.MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, button: 2,
    }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ['filter-settings']);
    assert.equal(menu.hidden, true);
    trigger.click();
    document.getElementById('nextUiNotificationForum').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(failed, true);
    assert.equal(menu.hidden, true);
    assert.ok(calls.some(call => call.startsWith('toast:error:')));
    controller.dispose();
    dom.window.close();
});
