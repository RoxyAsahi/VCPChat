const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const {
    MAX_DETACH_COORDINATE,
    classifyEmbeddedNavigation,
    normalizeEmbeddedAction,
    normalizeDetachPoint,
} = require('../modules/services/embeddedAppSessionManager.js');

test('embedded navigation stays on its declared local page', () => {
    const allowed = 'file:///Applications/VCP/Notemodules/notes.html?vcpEmbedded=1';
    assert.equal(classifyEmbeddedNavigation(allowed, `${allowed}#editor`), 'internal');
    assert.equal(classifyEmbeddedNavigation(allowed, 'https://example.com/docs'), 'external');
    assert.equal(classifyEmbeddedNavigation(allowed, 'http://127.0.0.1:3000/'), 'external');
    assert.equal(classifyEmbeddedNavigation(allowed, 'file:///Applications/VCP/main.html'), 'blocked');
    assert.equal(classifyEmbeddedNavigation(allowed, 'javascript:alert(1)'), 'blocked');
    assert.equal(classifyEmbeddedNavigation(allowed, 'not a url'), 'blocked');
});

test('embedded actions are restricted to the local application allowlist', () => {
    assert.equal(normalizeEmbeddedAction('open-notes-window'), 'open-notes-window');
    assert.equal(normalizeEmbeddedAction(null, { optional: true }), null);
    assert.throws(() => normalizeEmbeddedAction('open-arbitrary-window'), /无效/);
    assert.throws(() => normalizeEmbeddedAction({ action: 'open-notes-window' }), /无效/);
});

test('detach coordinates are finite, rounded and bounded', () => {
    assert.deepEqual(normalizeDetachPoint({ x: 10.4, y: -20.6 }), { x: 10, y: -21 });
    assert.equal(normalizeDetachPoint({ x: Infinity, y: 0 }), null);
    assert.equal(normalizeDetachPoint({ x: MAX_DETACH_COORDINATE + 1, y: 0 }), null);
    assert.equal(normalizeDetachPoint(null), null);
});

test('embedded sessions keep upstream child pages independent from main settings', () => {
    const source = fs.readFileSync(require.resolve('../modules/services/embeddedAppSessionManager.js'), 'utf8');
    assert.doesNotMatch(source, /settings-updated|ui-mode-updated/,
        'canonical main settings must not change the presentation of existing child sessions');
    assert.doesNotMatch(source, /\buiMode\b|searchParams\.set\(['"]uiMode/,
        'upstream child pages must not inherit a retired main-window mode query');
});

test('embedded session manager enforces a bounded native view pool', async () => {
    const originalLoad = Module._load;
    const openedExternal = [];
    class FakeWebContents extends EventEmitter {
        constructor() { super(); this.destroyed = false; this.currentLoad = null; this.sent = []; }
        isDestroyed() { return this.destroyed; }
        isCrashed() { return false; }
        setWindowOpenHandler() {}
        async loadURL() {}
        send() {}
        close() { this.destroyed = true; queueMicrotask(() => this.emit('destroyed')); }
        stop() {}
    }
    class FakeView {
        static instances = [];
        constructor() { this.webContents = new FakeWebContents(); this.visible = false; FakeView.instances.push(this); }
        setBackgroundColor() {}
        setVisible(value) { this.visible = value; }
        setBounds() {}
    }
    Module._load = function loadWithElectronMock(request, parent, isMain) {
        if (request === 'electron') return {
            WebContentsView: FakeView,
            app: { getAppPath: () => process.cwd() },
            shell: { openExternal: async url => { openedExternal.push(url); } },
            screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
        };
        return originalLoad.call(this, request, parent, isMain);
    };
    const modulePath = require.resolve('../modules/services/embeddedAppSessionManager.js');
    delete require.cache[modulePath];
    let manager;
    let mainWindow;
    try {
        mainWindow = new EventEmitter();
        mainWindow.isDestroyed = () => false;
        mainWindow.getContentBounds = () => ({ width: 1200, height: 900 });
        mainWindow.webContents = new FakeWebContents();
        mainWindow.contentView = { addChildView() {}, removeChildView() {} };
        const { createEmbeddedAppSessionManager, MAX_EMBEDDED_SESSIONS } = require(modulePath);
        const powerMonitor = new EventEmitter();
        manager = createEmbeddedAppSessionManager({
            mainWindow,
            powerMonitor,
            launchStandalone: async () => ({ success: true }),
        });
        const actions = [
            'open-notes-window', 'open-note-mini-window', 'open-translator-window',
            'open-memo-window', 'open-forum-window', 'open-log-window',
            'open-themes-window',
        ];
        for (const action of actions.slice(0, MAX_EMBEDDED_SESSIONS)) {
            assert.equal((await manager.create(action)).success, true);
        }
        let prevented = false;
        const firstContents = FakeView.instances[0].webContents;
        firstContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, 'https://example.com/outside');
        assert.equal(prevented, true, 'external navigation must never stay inside an embedded view');
        assert.deepEqual(openedExternal, ['https://example.com/outside']);
        const overflow = await manager.create(actions[MAX_EMBEDDED_SESSIONS]);
        assert.equal(overflow.success, false);
        assert.match(overflow.error, /最多同时打开/);
        assert.equal((await manager.create(actions[0])).reused, true);
        assert.equal(manager.activate(actions[0]).success, true);
        assert.equal(FakeView.instances[0].visible, true);
        powerMonitor.emit('suspend');
        assert.equal(FakeView.instances[0].visible, false);
        powerMonitor.emit('resume');
        assert.equal(FakeView.instances[0].visible, true);
    } finally {
        mainWindow?.emit('closed');
        await manager?.closeAll();
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
});

test('a stale load completion cannot close a replacement session for the same action', async () => {
    const originalLoad = Module._load;
    const pendingLoads = [];
    class FakeWebContents extends EventEmitter {
        constructor() { super(); this.destroyed = false; this.currentLoad = null; this.sent = []; }
        isDestroyed() { return this.destroyed; }
        isCrashed() { return false; }
        setWindowOpenHandler() {}
        loadURL() {
            return new Promise((resolve, reject) => {
                this.currentLoad = { resolve, reject };
                pendingLoads.push({ resolve, reject, contents: this });
            }).finally(() => { this.currentLoad = null; });
        }
        send(channel, payload) { this.sent.push({ channel, payload }); }
        close() {
            this.destroyed = true;
            queueMicrotask(() => this.emit('destroyed'));
        }
        stop() { this.currentLoad?.reject(new Error('aborted')); }
    }
    class FakeView {
        static instances = [];
        constructor() {
            this.webContents = new FakeWebContents();
            this.visible = false;
            FakeView.instances.push(this);
        }
        setBackgroundColor() {}
        setVisible(value) { this.visible = value; }
        setBounds() {}
    }
    Module._load = function loadWithElectronMock(request, parent, isMain) {
        if (request === 'electron') return {
            WebContentsView: FakeView,
            app: { getAppPath: () => process.cwd() },
            shell: { openExternal: async () => {} },
            screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
        };
        return originalLoad.call(this, request, parent, isMain);
    };
    const modulePath = require.resolve('../modules/services/embeddedAppSessionManager.js');
    delete require.cache[modulePath];
    let manager;
    let mainWindow;
    try {
        mainWindow = new EventEmitter();
        mainWindow.isDestroyed = () => false;
        mainWindow.getContentBounds = () => ({ width: 1200, height: 900 });
        mainWindow.webContents = new FakeWebContents();
        mainWindow.contentView = { addChildView() {}, removeChildView() {} };
        const { createEmbeddedAppSessionManager } = require(modulePath);
        manager = createEmbeddedAppSessionManager({
            mainWindow,
            launchStandalone: async () => ({ success: true }),
        });
        const action = 'open-notes-window';
        const firstCreate = manager.create(action);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pendingLoads.length, 1, 'first session must be waiting for loadURL');

        const closeFirst = manager.close(action);
        const secondCreate = manager.create(action);
        await closeFirst;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(pendingLoads.length, 2, 'replacement session must start while stale load is unresolved');

        pendingLoads[0].resolve();
        const firstResult = await firstCreate;
        assert.equal(firstResult.cancelled, true, 'stale first load must settle as cancelled');
        assert.deepEqual(manager.list().sessions, [{ action }],
            'stale first completion must not close the replacement session');
        const notificationsBeforeStaleEvents = mainWindow.webContents.sent.length;
        FakeView.instances[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
        FakeView.instances[0].webContents.emit('did-fail-load', {}, -2, 'stale failure', 'file:///stale', true);
        assert.equal(mainWindow.webContents.sent.length, notificationsBeforeStaleEvents,
            'stale view failure notifications must not be published for the replacement session');

        pendingLoads[1].resolve();
        const secondResult = await secondCreate;
        assert.equal(secondResult.success, true);
        assert.deepEqual(manager.list().sessions, [{ action }],
            'replacement session must remain authoritative after both loads settle');
        assert.equal(FakeView.instances[1].webContents.isDestroyed(), false);
        const notificationsBeforeAuthoritativeFailure = mainWindow.webContents.sent.length;
        FakeView.instances[1].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
        FakeView.instances[1].webContents.emit('did-fail-load', {}, -2, 'authoritative failure', 'file:///current', true);
        const authoritativeNotifications = mainWindow.webContents.sent.slice(notificationsBeforeAuthoritativeFailure);
        assert.equal(authoritativeNotifications.length, 1,
            'a renderer crash retires the authoritative session before later load failures');
        assert.deepEqual(authoritativeNotifications.map(entry => entry.payload.state), ['error']);
        assert.match(authoritativeNotifications[0].payload.error, /应用进程已退出/);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(manager.list().sessions, [], 'renderer crash must retire the dead native session');
        const notificationsBeforeFilteredFailures = mainWindow.webContents.sent.length;
        FakeView.instances[1].webContents.emit('did-fail-load', {}, -2, 'subframe failure', 'file:///subframe', false);
        FakeView.instances[1].webContents.emit('did-fail-load', {}, -3, 'aborted navigation', 'file:///aborted', true);
        assert.equal(mainWindow.webContents.sent.length, notificationsBeforeFilteredFailures,
            'subframe and ERR_ABORTED did-fail-load events must remain non-fatal');

        await manager.close(action);
        const controller = new AbortController();
        const abortedCreate = manager.create(action, { signal: controller.signal });
        await new Promise(resolve => setImmediate(resolve));
        controller.abort();
        const abortedResult = await abortedCreate;
        assert.equal(abortedResult.cancelled, true, 'aborted load must settle as cancelled');
        assert.deepEqual(manager.list().sessions, [], 'aborted load must not retain a native session');
    } finally {
        mainWindow?.emit('closed');
        await manager?.closeAll();
        Module._load = originalLoad;
        delete require.cache[modulePath];
    }
});
