const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadThemeHandlers() {
    const originalLoad = Module._load;
    const ipcMain = {
        on() {},
        handle() {},
    };
    const nativeTheme = {
        shouldUseDarkColors: false,
        themeSource: 'light',
        on() {},
    };
    class BrowserWindow {}

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'electron') return { ipcMain, BrowserWindow, nativeTheme };
        if (request.endsWith('../services/preloadPaths')) {
            return {
                PRELOAD_ROLES: { UTILITY: 'utility' },
                resolveProjectPreload: () => '/tmp/utility-preload.js',
            };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        const modulePath = require.resolve('../modules/ipc/themeHandlers.js');
        delete require.cache[modulePath];
        return require(modulePath);
    } finally {
        Module._load = originalLoad;
    }
}

function makeContents(name, { destroyed = false, crashed = false, throwOnSend = false } = {}) {
    const sent = [];
    return {
        name,
        sent,
        isDestroyed: () => destroyed,
        isCrashed: () => crashed,
        send(channel, value) {
            if (throwOnSend) throw new Error(`${name} send failed`);
            sent.push({ channel, value });
        },
    };
}

function makeWindow(contents, { destroyed = false } = {}) {
    return {
        webContents: contents,
        isDestroyed: () => destroyed,
    };
}

test('theme broadcast reaches windows and embedded views exactly once', () => {
    const themeHandlers = loadThemeHandlers();
    const mainContents = makeContents('main');
    const childContents = makeContents('child');
    const embeddedContents = makeContents('embedded');
    const destroyedContents = makeContents('destroyed', { destroyed: true });
    const mainWindow = makeWindow(mainContents);
    mainWindow.contentView = {
        children: [
            { webContents: embeddedContents },
            { webContents: embeddedContents },
            { webContents: destroyedContents },
        ],
    };

    themeHandlers.initialize({
        mainWindow,
        openChildWindows: [makeWindow(childContents), makeWindow(embeddedContents), makeWindow(destroyedContents)],
        projectRoot: '/tmp/vcpchat',
        APP_DATA_ROOT_IN_PROJECT: '/tmp/vcpchat-data',
        settingsManager: null,
    });

    themeHandlers.broadcastThemeUpdate('dark');

    for (const contents of [mainContents, childContents, embeddedContents]) {
        assert.deepEqual(contents.sent, [{ channel: 'theme-updated', value: 'dark' }], contents.name);
    }
    assert.deepEqual(destroyedContents.sent, []);
});

test('theme broadcast tolerates destroyed windows and send failures', () => {
    const themeHandlers = loadThemeHandlers();
    const mainContents = makeContents('main', { throwOnSend: true });
    const crashedContents = makeContents('crashed', { crashed: true });
    const destroyedWindowContents = makeContents('destroyed-window');
    const mainWindow = makeWindow(mainContents);
    mainWindow.contentView = { children: [{ webContents: crashedContents }] };

    assert.doesNotThrow(() => {
        themeHandlers.initialize({
            mainWindow,
            openChildWindows: [
                makeWindow(crashedContents),
                makeWindow(destroyedWindowContents, { destroyed: true }),
            ],
            projectRoot: '/tmp/vcpchat',
            APP_DATA_ROOT_IN_PROJECT: '/tmp/vcpchat-data',
            settingsManager: null,
        });
        themeHandlers.broadcastThemeUpdate('light');
    });
    assert.deepEqual(crashedContents.sent, []);
    assert.deepEqual(destroyedWindowContents.sent, []);
});
