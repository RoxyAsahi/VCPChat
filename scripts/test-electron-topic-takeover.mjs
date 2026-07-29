import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

// This is deliberately an Electron-level test rather than another direct
// daemon test.  It proves the visible Workbench path: a second GUI observes a
// busy Rust Topic, asks its owner to release it, and attaches only after the
// lease/checkpoint boundary has become safe.  No model request is sent.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeoutMs = 35_000;
const topicId = 'electron-takeover-topic';

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

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

async function waitForDebugger(port, child, stderr) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Electron exited before debugger startup: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            return;
        } catch (error) {
            lastError = error;
            await sleep(150);
        }
    }
    throw new Error(`Timed out waiting for Electron debugger: ${lastError?.message || 'unknown error'}\n${stderr.value}`);
}

async function launch(appData) {
    const port = await freePort();
    const stderr = { value: '' };
    const child = spawn(electron, ['.', '--allow-multiple-instances', `--remote-debugging-port=${port}`], {
        cwd: root,
        env: { ...process.env, VCPCHAT_APP_DATA_DIR: appData, VCPCHAT_E2E_TEST: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
    });
    child.stderr.on('data', chunk => { stderr.value = `${stderr.value}${chunk}`.slice(-8_000); });
    await waitForDebugger(port, child, stderr);
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('main.html')) || null;
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, 'Electron must expose a main renderer page');
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    return { child, browser, page };
}

async function close(instance) {
    if (!instance) return;
    try {
        const closed = await Promise.race([instance.browser.close().then(() => true).catch(() => false), sleep(8_000).then(() => false)]);
        if (!closed) instance.browser.disconnect();
    } finally {
        if (instance.child.exitCode === null) {
            await Promise.race([new Promise(resolve => instance.child.once('exit', resolve)), sleep(3_000)]);
            if (instance.child.exitCode === null) instance.child.kill();
        }
    }
}

async function removeTemporaryAppData(target) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
            await fs.rm(target, { recursive: true, force: true, maxRetries: 0 });
            return;
        } catch (error) {
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
            await sleep(200);
        }
    }
}

async function writeFixture(appData) {
    const createdAt = Date.now();
    const agentDirectory = path.join(appData, 'Agents', 'Nova');
    const topicDirectory = path.join(appData, 'UserData', 'nova', 'topics', topicId);
    await fs.mkdir(agentDirectory, { recursive: true });
    await fs.mkdir(topicDirectory, { recursive: true });
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
        uiMode: 'next',
        vcpServerUrl: 'http://127.0.0.1:9',
        vcpApiKey: 'test-only-placeholder',
        agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra', defaultAgentId: 'Nova' } },
    }), 'utf8');
    await fs.writeFile(path.join(agentDirectory, 'config.json'), JSON.stringify({
        name: 'Nova', model: 'gpt-5.6-terra', systemPrompt: '{{Nova}}',
    }), 'utf8');
    await fs.writeFile(path.join(topicDirectory, 'agent-state.json'), JSON.stringify({
        version: 1,
        title: 'Electron 协作接管',
        snapshot: { version: 1, messages: [{ role: 'user', content: [{ type: 'text', text: '此 checkpoint 必须只由一位 owner 写入。' }] }] },
        usage: null,
        workspaceRef: root,
        model: 'gpt-5.6-terra',
        updatedAt: createdAt,
    }), 'utf8');
    await fs.writeFile(path.join(topicDirectory, 'history.json'), JSON.stringify([
        { id: 'takeover-history', role: 'user', content: '此 checkpoint 必须只由一位 owner 写入。', timestamp: createdAt },
    ]), 'utf8');
}

async function openWorkbench(page) {
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCP Agent"]', { visible: true, timeout: timeoutMs });
    await page.click('.next-ui-internal-app-item[title="VCP Agent"]');
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    await page.waitForSelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`, { visible: true, timeout: timeoutMs });
}

async function selectTopic(page) {
    const clicked = await page.evaluate((id) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${id}"]`);
        row?.click();
        return Boolean(row);
    }, topicId);
    assert.ok(clicked, 'the seeded Topic must be visible in the Workbench session sidebar');
}

async function waitForActiveTopic(page, label) {
    await page.waitForFunction(async (id) => {
        const api = window.chatAPI || window.electronAPI;
        const status = await api.agentRuntimeGetStatus();
        const attachment = status?.attachment;
        return attachment?.topicId === id
            && !document.querySelector('.agent-chat-message-input')?.disabled;
    }, { timeout: timeoutMs }, topicId);
    assert.match(await page.$eval('.agent-chat-title', node => node.textContent || ''), /Electron 协作接管/,
        `${label} must display the restored Rust Topic title`);
    const checkpointText = await page.$eval('.message-item.user .md-content', node => node.textContent || '');
    assert.match(checkpointText, /此 checkpoint 必须只由一位 owner 写入/,
        `${label} must rebuild the exact Rust Topic checkpoint, not an empty or JS-replayed transcript`);
}

let first;
let second;
let appData;
try {
    await fs.access(electron);
    appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-electron-takeover-'));
    await writeFixture(appData);

    first = await launch(appData);
    await openWorkbench(first.page);
    await selectTopic(first.page);
    await waitForActiveTopic(first.page, 'the original GUI owner');

    second = await launch(appData);
    await openWorkbench(second.page);
    await second.page.waitForFunction((id) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${id}"]`);
        return row?.textContent?.includes('使用中');
    }, { timeout: timeoutMs }, topicId);
    await selectTopic(second.page);
    await second.page.waitForFunction(() => document.body.textContent?.includes('已请求当前 Topic 持有者安全释放会话'), { timeout: timeoutMs });
    await waitForActiveTopic(second.page, 'the replacement GUI owner');

    const secondState = await second.page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status?.attachment || null;
    });
    assert.equal(secondState?.topicId, topicId, 'replacement GUI must obtain the requested Topic only after owner release');
    const state = JSON.parse(await fs.readFile(path.join(appData, 'UserData', 'nova', 'topics', topicId, 'agent-state.json'), 'utf8'));
    assert.equal(state.title, 'Electron 协作接管', 'cooperative takeover must retain the checkpoint instead of deleting or duplicating it');
    console.log('Electron GUI cooperative Topic takeover test passed.');
} finally {
    await close(second);
    await close(first);
    await removeTemporaryAppData(appData);
}
