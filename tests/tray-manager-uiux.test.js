const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const trayPath = path.join(__dirname, '..', 'modules', 'trayManager.js');

class TestScope {
    constructor(label) {
        this.label = label;
        this.active = true;
        this.releases = [];
    }

    own(disposer) {
        this.releases.push(disposer);
        return disposer;
    }

    listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        return this.own(() => target.removeEventListener(type, handler, options));
    }

    child(label) {
        const child = new TestScope(label);
        this.own(() => child.dispose('parent-disposed'));
        return child;
    }

    async dispose() {
        if (this.disposePromise) return this.disposePromise;
        if (!this.active) return;
        this.active = false;
        this.disposePromise = (async () => {
            for (const release of this.releases.splice(0).reverse()) await release?.();
        })();
        return this.disposePromise;
    }
}

function fixture() {
    const dom = new JSDOM(`<!doctype html><body>
      <section id="vchatAppTray">
        <div id="appTrayPinnedApps"></div>
        <button id="appTrayMoreBtn" type="button" aria-expanded="false">More</button>
        <section id="appTrayDrawer" aria-hidden="true"><button id="appTraySettingsBtn" type="button">Settings</button><div id="appTrayDrawerGrid"></div></section>
      </section>
    </body>`, { pretendToBeVisual: true, url: 'http://vcpchat.local/' });
    const calls = [];
    const tooltips = [];
    dom.window.VCPLifecycle = { LifecycleScope: TestScope };
    dom.window.chatAPI = { desktopLaunchVchatApp: async action => { calls.push(action); return { success: true }; } };
    dom.window.VCPUIUX = {
        mountButton(button, props, scope) {
            button.classList.add('vcp-harness-button', 'button', props.variant, props.size);
            scope.own(() => button.classList.remove('vcp-harness-button', 'button', props.variant, props.size));
        },
        mountTooltip(button, props, scope) {
            let bubble = null;
            const show = () => {
                bubble = dom.window.document.createElement('span');
                bubble.className = 'vcp-harness-tooltip-bubble';
                bubble.setAttribute('role', 'tooltip');
                bubble.dataset.side = props.side;
                bubble.textContent = props.label;
                dom.window.document.body.append(bubble);
                tooltips.push(bubble);
            };
            const hide = () => { bubble?.remove(); bubble = null; };
            scope.listen(button, 'focus', show);
            scope.listen(button, 'blur', hide);
            scope.own(hide);
        },
    };
    const previous = { window: global.window, document: global.document, localStorage: global.localStorage };
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;
    delete require.cache[require.resolve(trayPath)];
    require(trayPath);
    return {
        dom,
        calls,
        tooltips,
        tray: dom.window.trayManager,
        restore() {
            global.window = previous.window;
            global.document = previous.document;
            global.localStorage = previous.localStorage;
            dom.window.close();
        },
    };
}

test('app tray drawer consumes generated Harness Button/Tooltip without replacing the canonical launcher', async () => {
    const state = fixture();
    try {
        state.tray.init();
        const { document } = state.dom.window;
        const first = document.querySelector('#appTrayDrawerGrid .app-tray-drawer-item');
        assert.ok(first, 'drawer must render real application launchers');
        assert.ok(first.classList.contains('vcp-harness-button'));
        assert.equal(first.classList.contains('toolbar'), true);
        assert.equal(first.getAttribute('title'), null, 'generated tooltip, not the native title bridge, owns the hint');
        assert.equal(first.dataset.uiuxShellAction, 'app-tray-launch');

        document.getElementById('appTrayMoreBtn').click();
        assert.equal(document.getElementById('appTrayDrawer').classList.contains('active'), true);
        first.focus();
        assert.equal(document.querySelector('.vcp-harness-tooltip-bubble')?.textContent, first.getAttribute('aria-label'));
        first.click();
        await Promise.resolve();
        assert.equal(state.calls.length, 1, 'the original desktop launcher remains the sole command path');
        assert.equal(document.getElementById('appTrayDrawer').classList.contains('active'), false);
        document.getElementById('appTrayMoreBtn').click();
        document.dispatchEvent(new state.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        assert.equal(document.getElementById('appTrayDrawer').classList.contains('active'), false);
        assert.equal(document.activeElement.id, 'appTrayMoreBtn');

        await state.tray.dispose();
        assert.equal(first.classList.contains('vcp-harness-button'), false, 'owner disposal restores the legacy presentation node');
        assert.equal(document.querySelector('.vcp-harness-tooltip-bubble'), null, 'owner disposal retracts body portals');
    } finally {
        state.restore();
    }
});

test('app tray source gate keeps the generated primitive boundary and excludes the bespoke fixed dock', () => {
    const source = fs.readFileSync(trayPath, 'utf8');
    assert.match(source, /function mountDrawerActionCandidate[\s\S]*uiux\.mountButton[\s\S]*uiux\.mountTooltip/);
    assert.match(source, /drawerScope\.listen\(item, 'click', open/);
    assert.match(source, /function disposeDrawerScope[\s\S]*scope\.dispose/);
    assert.match(source, /grid\.appendChild\(item\);[\s\S]*mountDrawerActionCandidate\(item, app, drawerScope\)/,
        'Tooltip must receive a connected Light-DOM anchor');
    assert.doesNotMatch(source, /mountDrawerActionCandidate\(btn, app/, 'fixed dock remains its bespoke presentation path');
});
