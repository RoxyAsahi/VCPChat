const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { AccountMenuController } = require('../modules/ui-system/next-shell/account-menu-controller.js');

function fixture({ buttonApi = null, scope = null } = {}) {
    const dom = new JSDOM(`<!doctype html><body class="dark-theme">
      <div class="next-ui-account-dock"><button id="nextUiAccountMenuTrigger"></button><img id="nextUiAccountAvatar"><span id="nextUiAccountName"></span></div>
      <div id="nextUiAccountMenu" role="menu" hidden><button id="nextUiAccountSettingsBtn"></button><button id="nextUiAccountAppearanceStudioBtn" role="menuitem"></button><button id="nextUiAccountThemeStoreBtn" role="menuitem"></button><button id="nextUiAccountThemeToggleBtn" role="menuitem"><span id="nextUiAccountThemeIcon"></span><span id="nextUiAccountThemeLabel"></span></button></div>
      <button id="nextUiThemeBtn"><span class="vcp-ui-icon"></span></button>
    </body>`, { url: 'http://vcpchat.local/' });
    const calls = [];
    const controller = new AccountMenuController({
        window: dom.window,
        document: dom.window.document,
        getSettings: () => ({ userName: 'Nova', userAvatarUrl: 'nova.png' }),
        openSettings: () => calls.push('settings'),
        openAppearance: () => calls.push('appearance'),
        openThemes: () => calls.push('themes'),
        setThemeMode: mode => { calls.push(`theme:${mode}`); return true; },
        setIcon: (element, icon) => { element.textContent = icon; },
        getThemeSnapshot: () => ({ value: { effective: 'dark' } }),
        buttonApi,
    });
    return { dom, calls, controller, scope };
}

test('account menu synchronizes identity/theme and owns dismissal behavior', () => {
    const { dom, calls, controller } = fixture();
    assert.equal(controller.mount(), true);
    const document = dom.window.document;
    document.getElementById('nextUiAccountMenuTrigger').click();
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, false);
    assert.equal(document.activeElement.id, 'nextUiAccountAppearanceStudioBtn');
    document.getElementById('nextUiAccountMenu').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(document.activeElement.id, 'nextUiAccountThemeStoreBtn');
    document.getElementById('nextUiAccountMenu').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(document.activeElement.id, 'nextUiAccountThemeToggleBtn');
    document.getElementById('nextUiAccountMenu').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(document.activeElement.id, 'nextUiAccountAppearanceStudioBtn');
    assert.equal(document.getElementById('nextUiAccountName').textContent, 'Nova');
    assert.equal(document.getElementById('nextUiAccountThemeLabel').textContent, '切换为浅色模式');
    document.getElementById('nextUiAccountThemeToggleBtn').click();
    assert.deepEqual(calls, ['theme:light']);
    controller.open();
    document.getElementById('nextUiAccountAppearanceStudioBtn').click();
    controller.open();
    document.getElementById('nextUiAccountThemeStoreBtn').click();
    controller.open();
    document.getElementById('nextUiAccountSettingsBtn').click();
    assert.deepEqual(calls, ['theme:light', 'appearance', 'themes', 'settings']);
    controller.open();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, true);
    controller.open();
    document.dispatchEvent(new dom.window.CustomEvent('next-ui-overlay-changed', { detail: { active: true } }));
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, true);
    controller.dispose();
    document.getElementById('nextUiAccountMenuTrigger').click();
    assert.equal(document.getElementById('nextUiAccountMenu').hidden, true);
});

test('account menu uses the typed theme snapshot instead of body classes', () => {
    const { dom, controller } = fixture();
    dom.window.document.body.className = 'light-theme';
    assert.equal(controller.mount(), true);
    const document = dom.window.document;
    assert.equal(document.getElementById('nextUiAccountThemeLabel').textContent, '切换为浅色模式');
    document.getElementById('nextUiAccountThemeToggleBtn').click();
    controller.dispose();
});

test('account menu adopts exactly its three native action buttons through the owning scope', async () => {
    const calls = [];
    const parentReleases = [];
    const childReleases = [];
    const childScope = {
        own(dispose) { childReleases.push(dispose); return dispose; },
        async dispose() { await Promise.all(childReleases.splice(0).reverse().map(dispose => dispose())); },
    };
    const scope = {
        own(dispose) { parentReleases.push(dispose); return dispose; },
        child() { parentReleases.push(() => childScope.dispose()); return childScope; },
        listen(target, type, handler) { target.addEventListener(type, handler); return () => target.removeEventListener(type, handler); },
        subscribe(register) { return register(); },
        observe(observer, target, options) { observer.observe(target, options); return () => observer.disconnect(); },
    };
    const buttonApi = {
        mountButton(button, props, owner) {
            assert.equal(owner, childScope);
            assert.deepEqual(props, { variant: 'ghost', size: 'md' });
            calls.push(button.id);
            button.dataset.harnessCandidate = 'true';
            return owner.own(() => { delete button.dataset.harnessCandidate; });
        },
    };
    const { dom, controller } = fixture({ buttonApi, scope });
    assert.equal(controller.mount(scope), true);
    assert.deepEqual(calls, [
        'nextUiAccountAppearanceStudioBtn',
        'nextUiAccountThemeStoreBtn',
        'nextUiAccountThemeToggleBtn',
    ]);
    const document = dom.window.document;
    assert.equal(document.getElementById('nextUiAccountSettingsBtn').dataset.harnessCandidate, undefined,
        'settings entry stays outside this menu-primitive slice');
    assert.equal(controller.mountGeneratedMenuButtons(), false, 'mount is idempotent');
    controller.dispose();
    for (const release of parentReleases.splice(0).reverse()) await release();
    for (const id of calls) assert.equal(document.getElementById(id).dataset.harnessCandidate, undefined);
});
