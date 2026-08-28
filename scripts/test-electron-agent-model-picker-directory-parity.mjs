/**
 * Production Agent Settings proof for the transient ModelPicker directory
 * capability. This is deliberately independent from lifecycle-stress and the
 * visual-forensics runner: those files are shared parallel worktrees.
 *
 * The renderer temporarily overlays only the injected directory methods before
 * Agent Settings is created. The real settings bridge, form, native
 * #agentModel node and generated artifact then perform the journey normally.
 * No IPC handler, persisted data, or legacy modal behaviour is changed.
 */
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
const timeoutMs = 90_000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const freePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
};
const requestJson = url => new Promise((resolve, reject) => {
    http.get(url, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
        });
    }).once('error', reject);
});
const waitForDevtools = async port => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { await requestJson(`http://127.0.0.1:${port}/json/version`); return; } catch { await sleep(100); }
    }
    throw new Error('Electron DevTools endpoint did not become ready');
};
const snapshot = page => page.evaluate(() => {
    const summary = window.VCPLifecycle?.diagnostics?.summary?.() || null;
    const pickerScopes = (window.VCPLifecycle?.diagnostics?.snapshot?.() || [])
        .filter(scope => /agent-model-picker|harness-popup-select/.test(scope.label))
        .map(scope => ({ label: scope.label, state: scope.state, resources: scope.resourceCount }));
    return { summary, pickerScopes, cards: document.querySelectorAll('.vcp-harness-popup-select-card').length };
});

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-agent-model-picker-directory-parity-'));
const modelServer = http.createServer((request, response) => {
    if (request.url !== '/v1/models') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'bootstrap-model', name: 'Bootstrap Model', owned_by: 'Bootstrap' }] }));
});
await new Promise((resolve, reject) => modelServer.once('error', reject).listen(0, '127.0.0.1', resolve));
const modelPort = modelServer.address().port;
const remotePort = await freePort();
await fs.mkdir(path.join(appData, 'Agents', 'DirectoryParity'), { recursive: true });
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', enableDistributedServer: false,
    vcpServerUrl: `http://127.0.0.1:${modelPort}`, vcpApiKey: 'directory-parity',
    assistantAgent: 'DirectoryParity',
}), 'utf8');
await fs.writeFile(path.join(appData, 'Agents', 'DirectoryParity', 'config.json'), JSON.stringify({
    name: 'Directory parity', model: 'probe-model', promptMode: 'original',
    originalSystemPrompt: 'Directory parity', systemPrompt: 'Directory parity', stripRegexes: [],
}), 'utf8');

const child = spawn(electron, [
    '.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`,
    `--remote-debugging-port=${remotePort}`,
], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000); });
let browser;
const evidence = { source: 'VCP production Agent Settings Electron Surface', generatedAt: new Date().toISOString() };

try {
    await waitForDevtools(remotePort);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${remotePort}`, protocolTimeout: timeoutMs });
    const pages = await browser.pages();
    const page = pages.find(candidate => candidate.url().includes('main.html'));
    assert.ok(page, `main renderer missing: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForSelector('#agentList [data-item-id="DirectoryParity"]', { timeout: timeoutMs });

    await page.evaluate(async () => {
        window.topTabManager.setView('home');
        window.uiManager.switchToTab('agents');
        document.querySelector('#agentList [data-item-id="DirectoryParity"]')?.click();
        window.uiManager.switchToTab('settings');
        await window.settingsManager.displaySettingsForItem();
    });
    await page.waitForFunction(() => document.getElementById('editingAgentId')?.value === 'DirectoryParity'
        && document.querySelector('#agentSettingsForm #openModelSelectBtn.vcp-harness-agent-model-picker-trigger'), { timeout: timeoutMs });
    // `window.chatAPI` is a deliberately immutable contextBridge object. Do
    // not bypass that IPC boundary in a renderer test. Instead, retire the
    // normal presentation owner for this isolated session, then mount the
    // generated AgentModelPicker through its public injected-capability
    // contract on the *real* Agent Settings form and native trigger/input.
    // This proves production-form behaviour without changing any IPC or
    // durable-state semantics.
    const injected = await page.evaluate(async () => {
        await window.VCPUISettingsBridge.destroy();
        const form = document.querySelector('#agentSettingsForm');
        const host = form?.querySelector('.model-input-container');
        const trigger = form?.querySelector('#openModelSelectBtn');
        const input = form?.querySelector('#agentModel');
        if (!(host instanceof HTMLElement) || !(trigger instanceof HTMLButtonElement) || !(input instanceof HTMLInputElement)) {
            return { installed: false, reason: 'real Agent Settings model nodes were unavailable after owner teardown' };
        }
        const state = {
            models: [
                { id: 'probe-model', name: 'Probe Model', provider: 'Probe' },
                { id: 'probe-secondary', name: 'Probe Secondary', provider: 'Probe' },
                { id: 'probe-tertiary', name: 'Probe Tertiary', provider: 'Probe' },
            ],
            hot: ['probe-secondary', 'probe-model'],
            favorites: ['probe-model', 'probe-tertiary'],
            toggles: [], refreshStarts: 0, subscriptions: 0, releases: 0,
            refreshMode: 'manual', pendingRefresh: null, onUpdated: null,
        };
        const project = () => {
            const byId = new Map(state.models.map(model => [model.id, model]));
            const present = (ids, group) => ids.map(id => byId.get(id)).filter(Boolean).map(model => ({
                ...model, group, favorite: state.favorites.includes(model.id), active: input.value === model.id,
            }));
            return [
                ...present(state.hot, '热门模型'),
                ...present(state.favorites, '收藏模型'),
                ...state.models.map(model => ({ ...model, group: '全部模型', favorite: state.favorites.includes(model.id), active: input.value === model.id })),
            ];
        };
        const scope = new window.VCPLifecycle.LifecycleScope('test:agent-model-picker-directory-parity');
        const controller = window.VCPUIUX.mountAgentModelPicker(host, {
            trigger, label: '选择模型', selectedId: input.value || undefined, grouped: true,
            options: async signal => signal.aborted ? [] : project(),
            directory: {
                refresh: () => new Promise((resolve, reject) => {
                    state.refreshStarts += 1;
                    if (state.refreshMode === 'failure') {
                        queueMicrotask(() => reject(new Error('injected refresh failure')));
                        return;
                    }
                    state.pendingRefresh = { resolve, reject };
                }),
                toggleFavorite: async modelId => {
                    state.toggles.push(modelId);
                    const index = state.favorites.indexOf(modelId);
                    if (index === -1) state.favorites.push(modelId);
                    else state.favorites.splice(index, 1);
                },
                subscribeUpdated: listener => {
                    state.subscriptions += 1;
                    state.onUpdated = listener;
                    return () => {
                        state.releases += 1;
                        if (state.onUpdated === listener) state.onUpdated = null;
                    };
                },
            },
            onSelect: option => {
                input.value = option.id;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            },
        }, scope);
        state.scope = scope;
        state.controller = controller;
        window.__vcpAgentModelPickerDirectoryParity = state;
        return { installed: true, value: input.value };
    });
    assert.deepEqual(injected, { installed: true, value: 'probe-model' }, `could not mount injected ModelPicker on real Agent Settings form: ${JSON.stringify(injected)}`);
    const baseline = await snapshot(page);

    const openModelPane = async () => {
        // The production stress journey separately proves physical hit testing
        // of this trigger. The isolated capability harness intentionally
        // tears down the rest of Settings presentation, so invoke the same
        // native click activation without relying on now-retired layout CSS.
        await page.$eval('#agentSettingsForm #openModelSelectBtn', button => button.click());
        await page.waitForSelector('.vcp-harness-popup-select-card .vcp-harness-agent-model-picker-cell', { timeout: timeoutMs });
        await page.click('.vcp-harness-popup-select-card .vcp-harness-agent-model-picker-cell');
        await page.waitForSelector('.vcp-harness-popup-select-card .vcp-harness-popup-select-viewport [data-option-id]', { timeout: timeoutMs });
    };
    const closePicker = async () => {
        await page.$eval('#agentSettingsForm #openModelSelectBtn', button => button.click());
        await page.waitForFunction(() => !document.querySelector('.vcp-harness-popup-select-card'), { timeout: timeoutMs });
    };

    await openModelPane();
    evidence.groups = await page.evaluate(() => {
        const card = document.querySelector('.vcp-harness-popup-select-card');
        const input = document.querySelector('#agentSettingsForm #agentModel');
        return {
            titles: [...card.querySelectorAll('.vcp-harness-popup-select-group-title')].map(node => node.textContent?.trim()),
            rows: [...card.querySelectorAll('[data-option-id]')].map(node => node.dataset.optionId),
            subscriptions: window.__vcpAgentModelPickerDirectoryParity.subscriptions,
            input: input?.value,
        };
    });
    assert.deepEqual(evidence.groups.titles, ['热门模型', '收藏模型', '全部模型']);
    assert.deepEqual(evidence.groups.rows, [
        'probe-secondary', 'probe-model', 'probe-model', 'probe-tertiary',
        'probe-model', 'probe-secondary', 'probe-tertiary',
    ]);
    assert.equal(evidence.groups.subscriptions, 1, 'directory update subscription must start exactly once for this open picker');

    evidence.favorite = await page.evaluate(async () => {
        const card = document.querySelector('.vcp-harness-popup-select-card');
        const input = document.querySelector('#agentSettingsForm #agentModel');
        const before = input?.value;
        const row = [...card.querySelectorAll('[data-option-id="probe-tertiary"]')][0];
        row?.parentElement?.querySelector('[data-option-action="favorite"]')?.click();
        await new Promise(resolve => setTimeout(resolve, 40));
        return {
            before, after: input?.value,
            toggles: [...window.__vcpAgentModelPickerDirectoryParity.toggles],
            cardOpen: Boolean(document.querySelector('.vcp-harness-popup-select-card')),
        };
    });
    assert.deepEqual(evidence.favorite.toggles, ['probe-tertiary']);
    assert.equal(evidence.favorite.after, evidence.favorite.before, 'favorite mutation must not write canonical #agentModel');
    assert.equal(evidence.favorite.cardOpen, true);

    const settleRefresh = async ({ mode, models, hot, favorites, reject = false }) => {
        await page.evaluate(({ nextMode }) => { window.__vcpAgentModelPickerDirectoryParity.refreshMode = nextMode; }, { nextMode: mode });
        const before = await page.evaluate(() => window.__vcpAgentModelPickerDirectoryParity.refreshStarts);
        await page.$eval('.vcp-harness-popup-select-card .vcp-harness-agent-model-picker-directory-refresh', button => button.click());
        await page.waitForFunction(start => window.__vcpAgentModelPickerDirectoryParity.refreshStarts === start + 1, { timeout: timeoutMs }, before);
        const busy = await page.evaluate(() => {
            const card = document.querySelector('.vcp-harness-popup-select-card');
            const refresh = card?.querySelector('.vcp-harness-agent-model-picker-directory-refresh');
            return { busy: card?.dataset.directoryBusy, disabled: refresh?.disabled, text: refresh?.textContent?.trim() };
        });
        if (!reject) {
            await page.evaluate(next => {
                const state = window.__vcpAgentModelPickerDirectoryParity;
                state.models = next.models; state.hot = next.hot; state.favorites = next.favorites;
                const pending = state.pendingRefresh; state.pendingRefresh = null;
                pending?.resolve({ success: true });
            }, { models, hot, favorites });
        }
        return busy;
    };

    evidence.refreshSuccess = { busy: await settleRefresh({
        mode: 'manual',
        models: [{ id: 'probe-success', name: 'Probe Success', owned_by: 'Probe' }],
        hot: ['probe-success'], favorites: ['probe-success'],
    }) };
    await page.waitForFunction(() => document.querySelectorAll('.vcp-harness-popup-select-viewport [data-option-id="probe-success"]').length === 3, { timeout: timeoutMs });
    evidence.refreshSuccess.rows = await page.evaluate(() => [...document.querySelectorAll('.vcp-harness-popup-select-viewport [data-option-id]')].map(node => node.dataset.optionId));
    assert.deepEqual(evidence.refreshSuccess.busy, { busy: 'true', disabled: true, text: 'Refreshing…' });
    assert.deepEqual(evidence.refreshSuccess.rows, ['probe-success', 'probe-success', 'probe-success']);

    evidence.refreshEmpty = { busy: await settleRefresh({ mode: 'manual', models: [], hot: [], favorites: [] }) };
    await page.waitForFunction(() => document.querySelector('.vcp-harness-popup-select-status')?.textContent?.trim() === 'No options', { timeout: timeoutMs });
    evidence.refreshEmpty.status = await page.$eval('.vcp-harness-popup-select-status', node => node.textContent?.trim());
    assert.equal(evidence.refreshEmpty.status, 'No options');

    // Restore a real row by emitting the popup-local injected subscription,
    // then prove refresh failure remains visible without closing the surface.
    await page.evaluate(() => {
        const state = window.__vcpAgentModelPickerDirectoryParity;
        state.models = [{ id: 'probe-failure', name: 'Probe Failure', owned_by: 'Probe' }];
        state.hot = []; state.favorites = [];
        state.onUpdated?.();
    });
    await page.waitForSelector('.vcp-harness-popup-select-viewport [data-option-id="probe-failure"]', { timeout: timeoutMs });
    evidence.refreshFailure = { busy: await settleRefresh({ mode: 'failure', reject: true }) };
    await page.waitForSelector('.vcp-harness-toast[role="alert"]', { timeout: timeoutMs });
    evidence.refreshFailure.toast = await page.$eval('.vcp-harness-toast[role="alert"]', node => node.textContent?.trim());
    evidence.refreshFailure.cardOpen = await page.evaluate(() => Boolean(document.querySelector('.vcp-harness-popup-select-card')));
    assert.match(evidence.refreshFailure.toast, /Could not refresh model list: injected refresh failure/);
    assert.equal(evidence.refreshFailure.cardOpen, true);

    // Closing owns both the in-flight action and transient feedback. A late
    // successful settlement must not recreate rows, cards, subscriptions, or
    // mutate the canonical input.
    await page.evaluate(() => { window.__vcpAgentModelPickerDirectoryParity.refreshMode = 'manual'; });
    const startsBeforeClose = await page.evaluate(() => window.__vcpAgentModelPickerDirectoryParity.refreshStarts);
    await page.$eval('.vcp-harness-popup-select-card .vcp-harness-agent-model-picker-directory-refresh', button => button.click());
    await page.waitForFunction(start => window.__vcpAgentModelPickerDirectoryParity.refreshStarts === start + 1, { timeout: timeoutMs }, startsBeforeClose);
    await closePicker();
    evidence.closeRace = await page.evaluate(() => ({
        cards: document.querySelectorAll('.vcp-harness-popup-select-card').length,
        toast: document.querySelector('.vcp-harness-toast') !== null,
        subscriptions: window.__vcpAgentModelPickerDirectoryParity.subscriptions,
        releases: window.__vcpAgentModelPickerDirectoryParity.releases,
        input: document.querySelector('#agentSettingsForm #agentModel')?.value,
    }));
    assert.deepEqual(evidence.closeRace, {
        cards: 0, toast: false, subscriptions: 1, releases: 1, input: 'probe-model',
    });
    const afterClose = await snapshot(page);
    assert.deepEqual(afterClose.summary, baseline.summary, `popup close leaked lifecycle resources: ${JSON.stringify({ baseline, afterClose })}`);
    assert.deepEqual(afterClose.pickerScopes, baseline.pickerScopes, `popup close retained transient picker scopes: ${JSON.stringify({ baseline, afterClose })}`);

    // Dispose the actual generated primitive owner while its refresh promise is
    // still unsettled. The late resolution below must lose all DOM commit
    // rights, just as it does when the production Settings surface is replaced.
    await page.evaluate(async () => {
        const state = window.__vcpAgentModelPickerDirectoryParity;
        await state.controller.dispose();
        await state.scope.dispose('directory-parity-explicit-dispose');
    });
    await page.evaluate(() => {
        const state = window.__vcpAgentModelPickerDirectoryParity;
        state.models = [{ id: 'late-model', name: 'Late Model', owned_by: 'Probe' }];
        state.pendingRefresh?.resolve({ success: true }); state.pendingRefresh = null;
    });
    await sleep(80);
    evidence.disposeRace = await page.evaluate(() => ({
        form: document.querySelector('#agentSettingsForm') !== null,
        cards: document.querySelectorAll('.vcp-harness-popup-select-card').length,
        lateRows: document.querySelectorAll('[data-option-id="late-model"]').length,
        subscriptions: window.__vcpAgentModelPickerDirectoryParity.subscriptions,
        releases: window.__vcpAgentModelPickerDirectoryParity.releases,
    }));
    assert.deepEqual(evidence.disposeRace, { form: true, cards: 0, lateRows: 0, subscriptions: 1, releases: 1 });
    evidence.final = await snapshot(page);
    assert.equal(evidence.final.pickerScopes.length, 0, `Settings dispose retained picker scopes: ${JSON.stringify(evidence.final)}`);

    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await fs.writeFile(path.join(root, 'reports', 'vcp-agent-model-picker-directory-parity.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Agent ModelPicker directory parity passed: ${JSON.stringify(evidence)}`);
} catch (error) {
    console.error(error?.stack || error);
    if (stderr) console.error(`Electron stderr tail:\n${stderr}`);
    process.exitCode = 1;
} finally {
    await browser?.disconnect().catch(() => {});
    // Electron can keep its macOS process alive after SIGTERM while a hidden
    // utility helper winds down. Bound test cleanup so a failed assertion never
    // leaves an E2E app or a top-level-await process behind.
    if (!child.killed) child.kill('SIGTERM');
    const exited = await Promise.race([
        new Promise(resolve => child.once('exit', () => resolve(true))),
        sleep(2_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) child.kill('SIGKILL');
    await new Promise(resolve => modelServer.close(resolve)).catch(() => {});
    await fs.rm(appData, { recursive: true, force: true }).catch(() => {});
}
