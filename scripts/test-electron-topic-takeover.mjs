import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';

// This is deliberately an Electron-level test rather than another direct
// daemon test.  It proves the visible Workbench path: a second GUI observes a
// busy Rust Topic, asks its owner to release it, and attaches only after the
// lease/checkpoint boundary has become safe.  No model request is sent.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeoutMs = 35_000;
const topicId = 'electron-takeover-topic';
const execFileAsync = promisify(execFile);
// A Windows Electron child can occasionally close the parent job before
// stderr flushes.  Keep a compact, credential-free receipt so this R3-A
// cooperative-takeover gate always leaves machine-readable evidence instead
// of looking like a silent success or failure.
const resultFile = process.env.VCPCHAT_E2E_RESULT_FILE
    ? path.resolve(process.env.VCPCHAT_E2E_RESULT_FILE)
    : path.join(os.tmpdir(), `vcpchat-topic-takeover-${process.pid}.json`);
// Optional visual evidence for focused Workbench layout checks. It is never
// created by the normal hermetic gate and contains only its synthetic fixture.
const takeoverScreenshotPath = process.env.VCPCHAT_E2E_TOPIC_TAKEOVER_SCREENSHOT_PATH
    ? path.resolve(process.env.VCPCHAT_E2E_TOPIC_TAKEOVER_SCREENSHOT_PATH)
    : null;
let phase = 'boot';

async function recordResult(status, nextPhase = null, failure = null) {
    if (nextPhase) phase = nextPhase;
    await fs.writeFile(resultFile, JSON.stringify({
        status,
        phase,
        topicId,
        // Never include app settings, endpoint paths, raw checkpoints, or
        // daemon output in a test receipt.
        failure: failure ? String(failure).slice(0, 1_200) : null,
        timestamp: Date.now(),
    }), 'utf8');
}

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
        // Always detach the CDP client. `Browser.close()` can resolve before
        // the local websocket releases its Node event-loop handle.
        instance.browser.disconnect();
    } finally {
        if (instance.child.exitCode === null) {
            await Promise.race([new Promise(resolve => instance.child.once('exit', resolve)), sleep(3_000)]);
            if (instance.child.exitCode === null) instance.child.kill();
            await Promise.race([new Promise(resolve => instance.child.once('exit', resolve)), sleep(2_000)]);
            if (instance.child.exitCode === null && process.platform === 'win32') {
                // Exact test-child PID only: never terminate by name or touch
                // the developer's independently running VCPChat instance.
                const pid = Number(instance.child.pid);
                if (Number.isSafeInteger(pid) && pid > 0) {
                    const shell = process.env.SystemRoot
                        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
                        : 'powershell.exe';
                    await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force`], {
                        windowsHide: true,
                        timeout: 5_000,
                    }).catch(() => {});
                }
            }
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
    const topicDirectory = path.join(appData, 'AgentRuntimeData', 'nova', 'topics', topicId);
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

async function openWorkbench(page, appData) {
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCP Agent"]', { visible: true, timeout: timeoutMs });
    await page.click('.next-ui-internal-app-item[title="VCP Agent"]');
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    const openedSessions = await page.evaluate(() => {
        const button = [...document.querySelectorAll('#nextUiInternalAppHost .sidebar-tab-button')]
            .find(candidate => candidate.textContent?.trim() === '会话');
        button?.click();
        return Boolean(button);
    });
    assert.ok(openedSessions, 'Agent Workbench must expose the current 会话 tab');
    try {
        // On a re-open the same Rust Topic may already be the sole live
        // attachment, so it is intentionally rendered as the live row rather
        // than duplicated as a persisted preview row.
        await page.waitForSelector(`.agent-chat-session-row[data-topic-id="${topicId}"]`, { visible: true, timeout: timeoutMs });
    } catch (error) {
        const projection = await page.evaluate(async () => {
            const rows = [...document.querySelectorAll('.agent-chat-session-row')].map(row => ({
                topicId: row.dataset.topicId,
                text: row.textContent,
            }));
            const api = window.chatAPI || window.electronAPI;
            return {
                rows,
                status: await api.agentRuntimeGetStatus().catch(reason => ({ error: String(reason) })),
                body: document.body.textContent?.slice(-4000),
            };
        });
        const topicRoot = path.join(appData, 'AgentRuntimeData');
        const disk = await fs.readdir(topicRoot, { recursive: true }).catch(reason => [`ERROR:${reason}`]);
        throw new Error(`seeded Topic missing from Workbench; projection=${JSON.stringify(projection)} disk=${JSON.stringify(disk)}`, { cause: error });
    }
}

async function selectTopic(page, actionLabel) {
    const clicked = await page.evaluate((id) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${id}"]`);
        row?.click();
        return Boolean(row);
    }, topicId);
    assert.ok(clicked, 'the seeded Topic must be visible in the Workbench session sidebar');
    if (actionLabel === '打开并恢复') {
        // R3-A/R3-D separate immediate Topic preview from the first writable
        // attachment. This fixture deliberately has no model server, so it
        // cannot use the visible send button to create the owner. First prove
        // the GUI took the preview path, then use the same narrowed Main API
        // to establish a writer for the independent lease/takeover scenario.
        await page.waitForFunction(async (id) => {
            const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
            return status?.attachment?.topicId !== id
                && document.querySelector(`.agent-chat-session-row[data-topic-id="${id}"]`)?.classList.contains('active')
                && !document.querySelector('.agent-chat-topic-flow-dialog');
        }, { timeout: timeoutMs }, topicId);
        const attached = await page.evaluate(async (id) => {
            const api = window.chatAPI || window.electronAPI;
            return api.agentRuntimeCreateSession({ resume: id, agent: 'Nova' });
        }, topicId);
        assert.equal(attached?.topicId, topicId, 'fixture owner attachment must be created through the narrowed Rust Runtime API');
        await page.waitForFunction(async (id) => {
            const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
            return status?.attachment?.topicId === id
                && !document.querySelector('.agent-chat-message-input')?.disabled;
        }, { timeout: timeoutMs }, topicId);
        // The direct fixture attachment intentionally bypasses the Workbench
        // controller (there is no model server to send through). Reloading
        // proves the actual snapshot-first mount path rebuilds the title and
        // transcript from the Rust attachment rather than a JS transcript.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
        await openWorkbench(page, appData);
        return;
    }
    if (actionLabel === '请求接管') {
        await page.waitForSelector('.agent-chat-topic-conflict-dialog', { visible: true, timeout: timeoutMs });
        const conflict = await page.$eval('.agent-chat-topic-conflict-dialog', (dialog) => ({
            text: dialog.textContent || '',
            actions: [...dialog.querySelectorAll('button')].map(button => button.textContent?.trim()),
            legacyFlow: Boolean(document.querySelector('.agent-chat-topic-flow-dialog')),
            preview: Boolean(document.querySelector('.agent-chat-occupied-banner')),
        }));
        assert.match(conflict.text, /会话正在其他位置使用/);
        assert.deepEqual(conflict.actions, ['暂不接管', '接管并继续']);
        assert.equal(conflict.legacyFlow, false);
        assert.equal(conflict.preview, false);
        if (takeoverScreenshotPath) await page.screenshot({ path: takeoverScreenshotPath, fullPage: false });
        const requested = await page.evaluate(() => {
            const dialog = document.querySelector('.agent-chat-topic-conflict-dialog');
            const action = [...(dialog?.querySelectorAll('button') || [])]
                .find(candidate => candidate.textContent?.trim() === '接管并继续');
            action?.click();
            return Boolean(action);
        });
        assert.ok(requested, 'occupied Topic conflict must expose an explicit cooperative takeover action');
        return;
    }
    await page.waitForSelector('.agent-chat-topic-flow-dialog', { visible: true, timeout: timeoutMs });
    const confirmed = await page.evaluate((label) => {
        const dialog = document.querySelector('.agent-chat-topic-flow-dialog');
        const action = [...(dialog?.querySelectorAll('button') || [])]
            .find(candidate => candidate.textContent?.trim() === label);
        action?.click();
        return Boolean(action);
    }, actionLabel);
    assert.ok(confirmed, `Topic checkpoint flow must expose ${actionLabel}`);
}

async function waitForActiveTopic(page, label, diagnostics = null) {
    try {
        await page.waitForFunction(async (id) => {
            const api = window.chatAPI || window.electronAPI;
            const status = await api.agentRuntimeGetStatus();
            const attachment = status?.attachment;
            return attachment?.topicId === id
                && !document.querySelector('.agent-chat-message-input')?.disabled;
        }, { timeout: timeoutMs }, topicId);
    } catch (error) {
        const current = await page.evaluate(async () => ({
            status: await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus(),
            rows: [...document.querySelectorAll('.agent-chat-persisted-topic')].map(row => ({
                topicId: row.dataset.topicId,
                text: row.textContent,
            })),
            notices: [...document.querySelectorAll('.agent-chat-toast, .vcp-ui-toast')].map(node => node.textContent),
        }));
        const extra = diagnostics ? await diagnostics() : null;
        throw new Error(`${label} did not attach; current=${JSON.stringify(current)} extra=${JSON.stringify(extra)}`, { cause: error });
    }
    assert.match(await page.$eval('.agent-chat-title', node => node.textContent || ''), /Electron 协作接管/,
        `${label} must display the restored Rust Topic title`);
    const checkpointText = await page.$eval('.message-item.user .md-content', node => node.textContent || '');
    assert.match(checkpointText, /此 checkpoint 必须只由一位 owner 写入/,
        `${label} must rebuild the exact Rust Topic checkpoint, not an empty or JS-replayed transcript`);
}

let first;
let second;
let appData;
let exitCode = 0;
try {
    await recordResult('running');
    await fs.access(electron);
    appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-electron-takeover-'));
    await writeFixture(appData);

    first = await launch(appData);
    await recordResult('running', 'first-owner-opened');
    await openWorkbench(first.page, appData);
    await selectTopic(first.page, '打开并恢复');
    await waitForActiveTopic(first.page, 'the original GUI owner');

    second = await launch(appData);
    await recordResult('running', 'second-observer-opened');
    await openWorkbench(second.page, appData);
    await second.page.waitForFunction((id) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${id}"]`);
        // Lease state must not be rendered as a sidebar label. The following
        // explicit action is the only visible conflict proof.
        return Boolean(row) && !/使用中|占用/.test(row.textContent || '');
    }, { timeout: timeoutMs }, topicId);
    await selectTopic(second.page, '请求接管');
    await recordResult('running', 'takeover-requested');
    await second.page.waitForFunction(() => document.body.textContent?.includes('已请求当前 Topic 持有者安全释放会话'), { timeout: timeoutMs });
    await waitForActiveTopic(second.page, 'the replacement GUI owner', async () => {
        const topicDirectory = path.join(appData, 'AgentRuntimeData', 'nova', 'topics', topicId);
        const files = await fs.readdir(topicDirectory).catch(error => [`ERROR:${error}`]);
        const read = async (name) => fs.readFile(path.join(topicDirectory, name), 'utf8').catch(error => `ERROR:${error}`);
        return {
            firstStatus: await first.page.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeGetStatus()),
            files,
            lock: await read('.vcp-agent.topic-lock.json'),
            takeover: await read('.vcp-agent.topic-takeover.json'),
        };
    });

    const secondState = await second.page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status?.attachment || null;
    });
    assert.equal(secondState?.topicId, topicId, 'replacement GUI must obtain the requested Topic only after owner release');
    const state = JSON.parse(await fs.readFile(path.join(appData, 'AgentRuntimeData', 'nova', 'topics', topicId, 'agent-state.json'), 'utf8'));
    assert.equal(state.title, 'Electron 协作接管', 'cooperative takeover must retain the checkpoint instead of deleting or duplicating it');
    await recordResult('passed', 'replacement-attached');
    console.log('Electron GUI cooperative Topic takeover test passed.');
} catch (error) {
    exitCode = 1;
    await recordResult('failed', phase, error?.stack || error);
    console.error(`Electron GUI cooperative Topic takeover test failed; receipt=${resultFile}: ${error?.stack || error}`);
} finally {
    await close(second);
    await close(first);
    await removeTemporaryAppData(appData);
}

// Puppeteer/WebSocket handles can survive a successful Browser.close on
// Windows. This is a standalone test process and all owned Electron children
// were closed above, so force the recorded result instead of letting a stale
// CDP handle turn a completed R3-A gate into an indefinitely running job.
process.exit(exitCode);
