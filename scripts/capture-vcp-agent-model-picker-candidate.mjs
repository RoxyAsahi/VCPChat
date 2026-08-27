import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = process.platform === 'darwin'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeout = 45_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = url => new Promise((resolve, reject) => {
    http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject);
});

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-agent-model-picker-'));
await fs.mkdir(path.join(appData, 'Agents', 'PickerProbe'), { recursive: true });
await fs.writeFile(path.join(appData, 'Agents', 'PickerProbe', 'config.json'), JSON.stringify({
    name: 'Picker Probe', model: 'picker-probe', promptMode: 'original',
    originalSystemPrompt: 'Picker probe', systemPrompt: 'Picker probe', stripRegexes: [],
}), 'utf8');
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', assistantAgent: 'PickerProbe', currentThemeMode: 'light',
    vcpServerUrl: 'http://127.0.0.1:1', vcpApiKey: 'picker-probe',
}), 'utf8');

let port = 0;
const probe = http.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', () => { port = probe.address().port; probe.close(resolve); }));
const child = spawn(electron, ['.', '--allow-multiple-instances', `--user-data-dir=${path.join(appData, 'ElectronProfile')}`, `--remote-debugging-port=${port}`], {
    cwd: root,
    env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000); });
const stopChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(1_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.unref();
};
let browser;
try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try { await request(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(100); }
    }
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
    assert.ok(page, `Agent Model Picker renderer missing: ${stderr}`);
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout });
    const evidence = await page.evaluate(async () => {
        const host = document.createElement('div');
        host.dataset.vcpCandidateAgentModelPicker = 'true';
        host.style.cssText = 'position:fixed;left:80px;top:120px;width:280px;height:220px;padding:16px;background:#fff;color:#0f1115;border:1px solid rgba(0,0,0,.08);border-radius:12px';
        document.body.append(host);
        const scope = new window.VCPLifecycle.LifecycleScope('test:candidate-agent-model-picker');
        const selected = [];
        const efforts = [];
        const picker = window.VCPUIUX.mountAgentModelPicker(host, {
            label: 'Agent model', selectedId: 'gpt-4o', selectedEffort: 'balanced',
            efforts: [
                { id: 'balanced', label: 'Balanced', description: 'Provider default' },
                { id: 'deep', label: 'Deep reasoning', description: 'More reasoning effort' },
            ],
            options: async signal => {
                if (signal.aborted) return [];
                return [
                    { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', favorite: true },
                    { id: 'claude-3-7', label: 'Claude 3.7 Sonnet', provider: 'Anthropic' },
                    { id: 'local-llama', label: 'Llama 3.3', provider: 'Local', disabled: true },
                ];
            },
            onSelect: option => selected.push(option.id),
            onEffortSelect: option => efforts.push(option.id),
        }, scope);
        picker.open();
        await new Promise(resolve => setTimeout(resolve, 0));
        const rootPane = {
            expanded: picker.trigger.getAttribute('aria-expanded'),
            triggerHeight: getComputedStyle(picker.trigger).height,
            cardPresent: Boolean(host.querySelector('.vcp-harness-popup-select-card')),
            modelRowVisible: host.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden === false,
            effortRowVisible: host.querySelectorAll('.vcp-harness-agent-model-picker-cell')[1]?.hidden === false,
        };
        const modelRow = host.querySelector('.vcp-harness-agent-model-picker-cell');
        modelRow?.click();
        await new Promise(resolve => setTimeout(resolve, 0));
        const modelPane = {
            searchVisible: host.querySelector('.vcp-harness-popup-select-search')?.hidden === false,
            optionCount: host.querySelectorAll('[role="option"]').length,
            selectedOption: host.querySelector('[role="option"][aria-selected="true"]')?.textContent?.trim() || null,
        };
        const menu = host.querySelector('.vcp-harness-popup-select-card');
        const menuStyle = menu ? getComputedStyle(menu) : null;
        const menuRules = [...document.styleSheets].flatMap(sheet => {
            try { return [...sheet.cssRules]; } catch { return []; }
        }).filter(rule => rule.selectorText?.includes('.vcp-harness-popup-select-card'));
        const declaration = property => menuRules.map(rule => rule.style?.getPropertyValue(property)).find(Boolean) || null;
        const menuRect = menu?.getBoundingClientRect();
        const search = host.querySelector('.vcp-harness-popup-select-search');
        search?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const keyboardNavigation = {
            activeOption: host.querySelector('[role="option"][aria-selected="true"]')?.textContent?.trim() || null,
        };
        const card = host.querySelector('.vcp-harness-popup-select-card');
        card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const modelEscape = {
            returnedToRoot: host.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden === false,
            searchHidden: host.querySelector('.vcp-harness-popup-select-search')?.hidden === true,
        };
        picker.setPane('effort');
        await new Promise(resolve => setTimeout(resolve, 0));
        const effortPane = {
            optionCount: host.querySelectorAll('.vcp-harness-agent-model-picker-option').length,
            selected: host.querySelector('.vcp-harness-agent-model-picker-option[aria-checked="true"]')?.textContent?.trim() || null,
        };
        card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const effortEscape = {
            returnedToRoot: host.querySelector('.vcp-harness-agent-model-picker-cell')?.hidden === false,
            effortHidden: host.querySelector('.vcp-harness-agent-model-picker-effort-list')?.hidden === true,
        };
        picker.close();
        await new Promise(resolve => setTimeout(resolve, 0));
        const focusRestored = document.activeElement === picker.trigger;
        const triggerStyle = getComputedStyle(picker.trigger);
        const screenshot = {
            source: 'VCP generated AgentModelPicker Candidate Electron capture',
            provenance: 'deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx',
            viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
            rootPane, modelPane, keyboardNavigation, modelEscape, effortPane, effortEscape, focusRestored,
            dom: host.querySelector('.vcp-harness-agent-model-picker')?.outerHTML || '',
            trigger: {
                tag: picker.trigger.tagName.toLowerCase(),
                role: picker.trigger.getAttribute('role'),
                ariaHaspopup: picker.trigger.getAttribute('aria-haspopup'),
                ariaExpanded: picker.trigger.getAttribute('aria-expanded'),
                height: triggerStyle.height,
                borderRadius: triggerStyle.borderRadius,
                padding: triggerStyle.padding,
                gap: triggerStyle.gap,
            },
            menu: menuStyle ? {
                tag: menu.tagName.toLowerCase(),
                role: menu.getAttribute('role'),
                borderRadius: menuStyle.borderRadius,
                padding: menuStyle.padding,
                minWidth: menuStyle.minWidth,
                rect: menuRect ? {
                    x: menuRect.x, y: menuRect.y, width: menuRect.width, height: menuRect.height,
                } : null,
                cssContract: {
                    borderRadius: declaration('border-radius'),
                    padding: declaration('padding'),
                    minWidth: declaration('min-width'),
                },
            } : null,
            selected, efforts,
            productionConsumer: false,
            status: 'candidate-interaction-active',
        };
        await picker.dispose();
        await scope.dispose('candidate-agent-model-picker-complete');
        screenshot.disposed = host.querySelector('.vcp-harness-agent-model-picker') === null;
        host.remove();
        return screenshot;
    });
    assert.deepEqual(evidence.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
    assert.equal(evidence.rootPane.expanded, 'true');
    assert.equal(evidence.rootPane.cardPresent, true);
    assert.equal(evidence.rootPane.modelRowVisible, true);
    assert.equal(evidence.rootPane.effortRowVisible, true);
    assert.equal(evidence.modelPane.searchVisible, true);
    assert.equal(evidence.modelPane.optionCount, 3);
    assert.equal(evidence.effortPane.optionCount, 2);
    assert.equal(evidence.modelEscape.returnedToRoot, true);
    assert.equal(evidence.modelEscape.searchHidden, true);
    assert.equal(evidence.effortEscape.returnedToRoot, true);
    assert.equal(evidence.effortEscape.effortHidden, true);
    assert.equal(evidence.focusRestored, true);
    assert.equal(evidence.disposed, true);
    await fs.mkdir(path.join(root, 'reports'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'reports', 'vcp-agent-model-picker-candidate.png') });
    await fs.writeFile(path.join(root, 'reports', 'vcp-agent-model-picker-candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(evidence, null, 2));
} finally {
    // Disconnect without waiting for DevTools target shutdown; Electron is
    // explicitly terminated below and lingering inspector handles must not
    // keep this standalone capture alive.
    browser?.disconnect?.();
    await stopChild();
}
// Puppeteer can retain an inspector/socket handle after the browser target
// closes; this standalone evidence command must terminate once cleanup is
// complete so automation runs do not remain alive indefinitely.
process.exit(0);
