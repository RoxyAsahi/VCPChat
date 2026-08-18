// Real Electron regression for reusable global-settings DOM generations.
// It delays two generations of getAgents/Rust IPC and completes B before A;
// the late A results must have no right to mutate or refresh B.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const testMain = path.join(root, 'scripts', 'support', 'electron-settings-race-main.cjs');
const timeoutMs = 90_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const readyMarker = path.join(root, '.vcp_ready');
const readyMarkerExisted = await fs.access(readyMarker).then(() => true, () => false);

async function waitForChildExit(childProcess, timeout = 2_000) {
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) return true;
    return Promise.race([
        new Promise(resolve => childProcess.once('exit', () => resolve(true))),
        sleep(timeout).then(() => false),
    ]);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        }).on('error', reject);
    });
}

async function waitForFile(file, timeout = timeoutMs) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            await fs.access(file);
            return;
        } catch {}
        await sleep(20);
    }
    throw new Error(`Timed out waiting for ${file}`);
}

async function fileExists(file) {
    try { await fs.access(file); return true; } catch { return false; }
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-settings-race-'));
const gateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-settings-race-gate-'));
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    vcpServerUrl: 'http://127.0.0.1:1',
    vcpApiKey: 'race-test-key',
    assistantAgent: 'generation-b',
}), 'utf8');
const port = await freePort();
const stderr = { value: '' };
const child = spawn(electron, [testMain, '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
    cwd: root,
    env: {
        ...process.env,
        VCPCHAT_APP_DATA_DIR: appData,
        VCPCHAT_E2E_TEST: '1',
        VCPCHAT_E2E_DELAY_GATE_DIR: gateDir,
        VCPCHAT_E2E_APP_MAIN: path.join(root, 'main.js'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
});
child.stderr.on('data', chunk => { stderr.value = `${stderr.value}${chunk}`.slice(-16_000); });

let browser;
try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            break;
        } catch { await sleep(100); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, `Electron main renderer did not appear: ${stderr.value}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await sleep(200);
    assert.equal(await page.evaluate(() => document.getElementById('globalSettingsModal')?.classList.contains('active') === true), false);

    for (const channel of ['get-agents', 'get-rust-assistant-config']) {
        await fs.writeFile(path.join(gateDir, `${channel}.arm`), '', 'utf8');
    }
    await page.evaluate(() => {
        window.__settingsRaceEvents = [];
        window.__settingsRaceChanges = { assistant: 0, rust: 0 };
        document.addEventListener('vcp-settings-surface-updated', event => {
            if (event.detail?.surface === 'global-settings') {
                window.__settingsRaceEvents.push({
                    generation: event.detail.generation,
                    reason: event.detail.reason,
                });
            }
        });
        window.uiHelperFunctions.openModal('globalSettingsModal');
        window.__settingsRaceRoot = document.getElementById('globalSettingsModal');
        document.getElementById('assistantAgent')?.addEventListener('change', () => { window.__settingsRaceChanges.assistant += 1; });
        document.getElementById('rustRuleMode')?.addEventListener('change', () => { window.__settingsRaceChanges.rust += 1; });
    });

    await Promise.all([
        waitForFile(path.join(gateDir, 'get-agents-1.observed.json')),
        waitForFile(path.join(gateDir, 'get-rust-assistant-config-1.observed.json')),
    ]);
    const generationA = await page.evaluate(async () => {
        const module = await import('./modules/ui-system/settings-surface-session.js');
        return module.currentSettingsSurfaceGeneration();
    });

    await page.evaluate(() => {
        window.uiHelperFunctions.closeModal('globalSettingsModal');
        window.uiHelperFunctions.openModal('globalSettingsModal');
    });
    await Promise.all([
        waitForFile(path.join(gateDir, 'get-agents-2.observed.json')),
        waitForFile(path.join(gateDir, 'get-rust-assistant-config-2.observed.json')),
    ]);
    const generationB = await page.evaluate(async () => {
        const module = await import('./modules/ui-system/settings-surface-session.js');
        if (window.__settingsRaceRoot !== document.getElementById('globalSettingsModal')) {
            throw new Error('global settings test requires the real reusable modal DOM');
        }
        return module.currentSettingsSurfaceGeneration();
    });
    assert.ok(generationB > generationA, `${generationB} must supersede ${generationA}`);

    const rustB = {
        useRustAssistant: true,
        debugMode: false,
        whitelist: ['generation-b'],
        blacklist: [],
        screenshotApps: [],
        runtimeThresholds: {},
    };
    await fs.writeFile(path.join(gateDir, 'get-rust-assistant-config-2.release.json'), JSON.stringify({ override: rustB }), 'utf8');
    await fs.writeFile(path.join(gateDir, 'get-agents-2.release.json'), JSON.stringify({
        override: [{ id: 'generation-b', name: 'Generation B' }],
    }), 'utf8');
    await page.waitForFunction(() => (
        document.getElementById('assistantAgent')?.value === 'generation-b'
        && document.getElementById('rustRuleMode')?.value === 'whitelist'
    ), { timeout: timeoutMs });
    await page.waitForFunction(expectedGeneration => (
        window.__settingsRaceEvents?.filter(event => event.generation === expectedGeneration).length >= 2
    ), { timeout: timeoutMs }, generationB);
    await sleep(50);

    const beforeLateA = await page.evaluate(() => ({
        events: [...window.__settingsRaceEvents],
        changes: { ...window.__settingsRaceChanges },
        refreshCount: (() => {
            const source = document.getElementById('assistantAgent');
            const controller = window.VCPUI?.getController?.(source);
            if (!controller?.refresh) throw new Error('assistant WA controller refresh is required');
            const original = controller.refresh.bind(controller);
            window.__settingsRaceRefreshCount = 0;
            controller.refresh = (...args) => {
                window.__settingsRaceRefreshCount += 1;
                return original(...args);
            };
            return window.__settingsRaceRefreshCount;
        })(),
    }));
    await fs.writeFile(path.join(gateDir, 'get-rust-assistant-config-1.release.json'), JSON.stringify({ override: {
        ...rustB,
        whitelist: [],
        blacklist: ['generation-a'],
    } }), 'utf8');
    await fs.writeFile(path.join(gateDir, 'get-agents-1.release.json'), JSON.stringify({
        override: [{ id: 'generation-a', name: 'Generation A' }],
    }), 'utf8');
    await sleep(300);

    const finalState = await page.evaluate(() => {
        const assistant = document.getElementById('assistantAgent');
        const rust = document.getElementById('rustRuleMode');
        return {
            assistantValue: assistant?.value,
            assistantOptions: [...(assistant?.options || [])].map(option => option.value),
            rustValue: rust?.value,
            whitelistVisible: getComputedStyle(document.getElementById('rustWhitelistPanel')).display !== 'none',
            events: [...window.__settingsRaceEvents],
            changes: { ...window.__settingsRaceChanges },
            refreshCount: window.__settingsRaceRefreshCount,
            assistantProxyValue: assistant?.nextElementSibling?.matches?.('wa-select')
                ? assistant.nextElementSibling.value
                : null,
            rustProxyValue: rust?.nextElementSibling?.matches?.('wa-select')
                ? rust.nextElementSibling.value
                : null,
        };
    });
    assert.equal(finalState.assistantValue, 'generation-b');
    assert.ok(finalState.assistantOptions.includes('generation-b'));
    assert.ok(!finalState.assistantOptions.includes('generation-a'));
    assert.equal(finalState.rustValue, 'whitelist');
    assert.equal(finalState.whitelistVisible, true);
    assert.ok(beforeLateA.events.length >= 2, 'B must publish renderer and Rust terminal events');
    assert.ok(beforeLateA.events.every(event => event.generation === generationB), 'only B may publish terminal events');
    assert.deepEqual(finalState.events, beforeLateA.events, 'late A must not publish a terminal surface event');
    assert.equal(finalState.refreshCount, beforeLateA.refreshCount, 'late A must not refresh the B presentation');
    assert.deepEqual(finalState.changes, { assistant: 0, rust: 0 }, 'hydration must not manufacture business change events');
    assert.equal(finalState.assistantProxyValue, 'generation-b', 'WA assistant proxy mirrors B');
    assert.equal(finalState.rustProxyValue, 'whitelist', 'WA Rust proxy mirrors B');
    assert.equal(await fileExists(path.join(gateDir, 'get-agents-3.observed.json')), false, 'one getAgents request per open');
    assert.equal(await fileExists(path.join(gateDir, 'get-rust-assistant-config-3.observed.json')), false, 'one Rust request per open');
    console.log(`Settings surface generation race passed (A=${generationA}, B=${generationB}).`);
} finally {
    for (const channel of ['get-agents', 'get-rust-assistant-config']) {
        for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
            await fs.writeFile(path.join(gateDir, `${channel}-${ordinal}.release.json`), '{}', 'utf8').catch(() => {});
        }
    }
    try { await browser?.disconnect(); } catch {}
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    if (!await waitForChildExit(child)) {
        child.kill('SIGKILL');
        await waitForChildExit(child);
    }
    await fs.rm(appData, { recursive: true, force: true });
    await fs.rm(gateDir, { recursive: true, force: true });
    if (!readyMarkerExisted) await fs.rm(readyMarker, { force: true });
}
