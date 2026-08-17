'use strict';

// Test-only Electron entrypoint. Electron has initialized its main-process API
// before loading this file, so handlers can be wrapped without changing the
// production main process, preload contract or IPC implementation.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, ipcMain } = require('electron');

const gateDir = process.env.VCPCHAT_E2E_DELAY_GATE_DIR;
const appMain = process.env.VCPCHAT_E2E_APP_MAIN;
const channels = new Set(['get-agents', 'get-rust-assistant-config']);
const ordinals = new Map();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const originalHandle = ipcMain.handle.bind(ipcMain);

ipcMain.handle = (channel, listener) => {
    if (!gateDir || !channels.has(channel)) return originalHandle(channel, listener);
    return originalHandle(channel, async (...args) => {
        const result = await listener(...args);
        if (!fs.existsSync(path.join(gateDir, `${channel}.arm`))) return result;

        const ordinal = (ordinals.get(channel) || 0) + 1;
        ordinals.set(channel, ordinal);
        const stem = path.join(gateDir, `${channel}-${ordinal}`);
        await fsp.mkdir(gateDir, { recursive: true });
        await fsp.writeFile(`${stem}.observed.json`, JSON.stringify({ channel, ordinal }), 'utf8');

        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            try {
                const release = JSON.parse(await fsp.readFile(`${stem}.release.json`, 'utf8'));
                return Object.hasOwn(release, 'override') ? release.override : result;
            } catch (error) {
                if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
            }
            await delay(10);
        }
        throw new Error(`[E2E delay gate] Timed out waiting to release ${channel}#${ordinal}`);
    });
};

if (!appMain) throw new Error('VCPCHAT_E2E_APP_MAIN is required');
app.setAppPath(path.dirname(appMain));
require(appMain);
