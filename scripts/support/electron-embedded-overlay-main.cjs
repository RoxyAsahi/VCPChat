'use strict';

// Test-only Electron entrypoint. It wraps one main-process IPC handler before
// the production entrypoint registers it, leaving production main/preload code
// and the IPC contract untouched.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const gateDir = process.env.VCPCHAT_E2E_EMBEDDED_GATE_DIR;
const appMain = process.env.VCPCHAT_E2E_APP_MAIN;
const channel = 'embedded-vchat-app:activate';
const filePart = channel.replace(/[^a-z0-9._-]+/gi, '-');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const originalHandle = ipcMain.handle.bind(ipcMain);

// Optional, test-only fault injection.  It is installed before the
// production entrypoint creates any WebContentsView and only targets the
// utility document URL used by embedded applications.  No production IPC or
// session code is changed by this hook.
let failEmbeddedLoad = process.env.VCPCHAT_E2E_FAIL_EMBEDDED_LOAD_ONCE === '1';
let crashEmbeddedRenderer = process.env.VCPCHAT_E2E_CRASH_EMBEDDED_ONCE === '1';
let failEmbeddedHide = process.env.VCPCHAT_E2E_FAIL_EMBEDDED_HIDE_ONCE === '1';
if (failEmbeddedLoad || crashEmbeddedRenderer) {
    app.on('web-contents-created', (_event, contents) => {
        const originalLoadURL = contents.loadURL.bind(contents);
        contents.loadURL = async url => {
            if (failEmbeddedLoad && String(url).includes('vcpEmbedded=1')) {
                failEmbeddedLoad = false;
                throw new Error('[E2E embedded fault] controlled loadURL rejection');
            }
            const result = await originalLoadURL(url);
            if (crashEmbeddedRenderer && String(url).includes('vcpEmbedded=1')) {
                crashEmbeddedRenderer = false;
                setTimeout(() => {
                    try { contents.forcefullyCrashRenderer?.(); } catch (_error) { /* test cleanup */ }
                }, 25);
            }
            return result;
        };
    });
}

ipcMain.handle = (registeredChannel, listener) => {
    if (!gateDir || registeredChannel !== channel) return originalHandle(registeredChannel, listener);
    return originalHandle(registeredChannel, async (event, ...args) => {
        const result = await listener(event, ...args);
        const appAction = args[0];
        const hideArmFile = gateDir ? path.join(gateDir, `${filePart}.hide-failure.arm`) : null;
        if (!appAction && failEmbeddedHide && (!hideArmFile || fs.existsSync(hideArmFile))) {
            failEmbeddedHide = false;
            if (gateDir) {
                await fsp.mkdir(gateDir, { recursive: true });
                await fsp.writeFile(path.join(gateDir, `${filePart}.hide-failure-observed`), '1', 'utf8');
            }
            throw new Error('[E2E embedded fault] controlled hide IPC rejection');
        }
        const armFile = path.join(gateDir, `${filePart}.arm`);
        if (appAction !== null || !fs.existsSync(armFile)) return result;
        await fsp.mkdir(gateDir, { recursive: true });
        const observedFile = path.join(gateDir, `${filePart}.observed`);
        await fsp.writeFile(observedFile, JSON.stringify({ channel, appAction }), 'utf8');
        const releaseFile = path.join(gateDir, `${filePart}.release`);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            if (fs.existsSync(releaseFile)) return result;
            await delay(10);
        }
        throw new Error(`[E2E embedded overlay gate] Timed out waiting for ${channel}`);
    });
};

if (!appMain) throw new Error('VCPCHAT_E2E_APP_MAIN is required');
app.setAppPath(path.dirname(appMain));
require(appMain);
