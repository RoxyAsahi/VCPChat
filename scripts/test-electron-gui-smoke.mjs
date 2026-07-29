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
import { rustSourceRevision } from './rust-source-revision.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagedExecutable = process.env.VCPCHAT_E2E_PACKAGED_EXECUTABLE
    ? path.resolve(process.env.VCPCHAT_E2E_PACKAGED_EXECUTABLE)
    : null;
const electronBinary = packagedExecutable || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const timeoutMs = 30_000;
const liveTurnTimeoutMs = 180_000;
const execFileAsync = promisify(execFile);

// This smoke suite is hermetic by default.  A real GUI → Rust daemon →
// ToolBox request is deliberately opt-in because it consumes model capacity
// and needs an operator-approved ToolBox endpoint.
const liveToolBox = process.env.VCPCHAT_E2E_LIVE_TOOLBOX === '1';
// This remains a separate opt-in from the read-only live path. It proves the
// local approval boundary without allowing the requested command to execute.
const liveHighRiskApproval = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_HIGH_RISK === '1';
// This is intentionally a separate opt-in from the denial path. It requires
// a real VCPChat DistributedServer capability node already registered with
// ToolBox and executes only `Get-Location` after the visible local allow.
const liveBackendYolo = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_BACKEND_YOLO === '1';
const liveCancellation = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_CANCEL === '1';
const liveRendererReload = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_RELOAD === '1';
const liveGuiCompaction = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_COMPACTION === '1';
// Release smoke passes an isolated compiled daemon through this documented
// development override.  Assert the child command line below so a future
// fallback to the debug executable cannot turn that release test into a false
// green result.
const expectedDaemonOverride = process.env.VCP_AGENT_RUST_DAEMON_PATH
    ? path.resolve(process.env.VCP_AGENT_RUST_DAEMON_PATH)
    : null;
const expectedPackagedDaemon = packagedExecutable
    ? path.join(path.dirname(packagedExecutable), 'resources', 'vcp-agent', process.platform === 'win32' ? 'vcp-agentd.exe' : 'vcp-agentd')
    : null;
const expectedSourceDaemon = path.join(root, 'rust', 'target', 'release', process.platform === 'win32' ? 'vcp-agentd.exe' : 'vcp-agentd');
const expectedSourceRevision = rustSourceRevision(root);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function findDaemonChild(parentPid) {
    if (process.platform !== 'win32') return null;
    const numericParentPid = Number(parentPid);
    if (!Number.isSafeInteger(numericParentPid) || numericParentPid <= 0) return null;
    const shell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
    const script = `$parent = ${numericParentPid}; Get-CimInstance Win32_Process -Filter \"ParentProcessId = $parent\" | Where-Object { $_.Name -ieq 'vcp-agentd.exe' } | Select-Object -First 1 -ExpandProperty ProcessId`;
    const { stdout } = await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5_000,
    });
    const pid = Number.parseInt(String(stdout).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function waitForDaemonChild(parentPid) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pid = await findDaemonChild(parentPid);
        if (pid) return pid;
        await sleep(100);
    }
    throw new Error('Rust Agent daemon did not appear as an Electron child process');
}

async function stopTestDaemon(pid) {
    if (process.platform !== 'win32') return;
    const numericPid = Number(pid);
    if (!Number.isSafeInteger(numericPid) || numericPid <= 0) throw new Error('invalid daemon PID');
    const shell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
    // The PID is discovered from this smoke test's Electron child only. This
    // is a deliberate crash test, not a broad process-name termination.
    await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${numericPid} -Force`], {
        windowsHide: true,
        timeout: 5_000,
    });
}

async function readProcessCommandLine(pid) {
    if (process.platform !== 'win32') return '';
    const numericPid = Number(pid);
    if (!Number.isSafeInteger(numericPid) || numericPid <= 0) return '';
    const shell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
    const script = `Get-CimInstance Win32_Process -Filter \"ProcessId = ${numericPid}\" | Select-Object -ExpandProperty CommandLine`;
    const { stdout } = await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        timeout: 5_000,
    });
    return String(stdout).trim();
}

async function assertResponsiveWorkbench(page) {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate(() => {
            const rect = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const value = element.getBoundingClientRect();
                return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
            };
            return {
                viewportWidth: window.innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
                root: rect('#nextUiInternalAppHost .agent-workbench-root'),
                sidebar: rect('.agent-chat-sidebar'),
                header: rect('.agent-chat-header'),
                composer: rect('.agent-chat-composer'),
                input: rect('.agent-chat-message-input'),
            };
        });
        assert.ok(layout.root && layout.sidebar && layout.header && layout.composer && layout.input,
            `Workbench must retain its root, sidebar, header and composer at ${viewport.width}px`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 1,
            `Workbench must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
        for (const [name, rect] of Object.entries({ header: layout.header, composer: layout.composer, input: layout.input })) {
            assert.ok(rect.left >= -1 && rect.right <= layout.viewportWidth + 1 && rect.width > 0 && rect.height > 0,
                `${name} must stay visible and usable at ${viewport.width}px: ${JSON.stringify(rect)}`);
        }
        assert.ok(layout.sidebar.width > 0 && layout.sidebar.left >= -1 && layout.sidebar.right <= layout.viewportWidth + 1,
            `Agent sidebar must stay within the viewport at ${viewport.width}px: ${JSON.stringify(layout.sidebar)}`);
    }
}

async function focusToolCard(page, expectedToolName) {
    return page.evaluate((toolName) => {
        const card = [...document.querySelectorAll('.agent-chat-tool-activity')]
            .find((candidate) => (candidate.querySelector('.agent-chat-tool-title')?.textContent || '').includes(toolName));
        const feed = card?.closest('.agent-chat-messages-container');
        // Electron's nested flex scroller does not consistently honor
        // scrollIntoView after a viewport resize. Set its own scroll position
        // deterministically so this test observes the card a user can reach.
        if (card && feed) feed.scrollTop = Math.max(0, card.offsetTop - Math.max(0, (feed.clientHeight - card.offsetHeight) / 2));
        else card?.scrollIntoView({ block: 'center', inline: 'nearest' });
        const rect = card?.getBoundingClientRect();
        const style = card ? getComputedStyle(card) : null;
        return {
            rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
            visible: Boolean(card && style?.display !== 'none' && style?.visibility !== 'hidden' && Number(style?.opacity || 1) > 0),
            title: card?.querySelector('.agent-chat-tool-title')?.textContent || '',
        };
    }, expectedToolName);
}

async function assertResponsiveToolCardLayout(page, expectedToolName = 'PowerShellExecutor') {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate((toolName) => {
            const rect = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const value = element.getBoundingClientRect();
                return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
            };
            const toolElement = [...document.querySelectorAll('.agent-chat-tool-activity')]
                .find((candidate) => (candidate.querySelector('.agent-chat-tool-title')?.textContent || '').includes(toolName));
            // A completed tool card can legitimately be above the newest
            // assistant message. Make the same card visible before measuring:
            // mounted-but-offscreen content is not a responsive UI success.
            const feed = toolElement?.closest('.agent-chat-messages-container');
            if (toolElement && feed) feed.scrollTop = Math.max(0, toolElement.offsetTop - Math.max(0, (feed.clientHeight - toolElement.offsetHeight) / 2));
            else toolElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
            const tool = toolElement ? (() => {
                const value = toolElement.getBoundingClientRect();
                return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
            })() : null;
            return {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                tool,
                toolVisible: Boolean(toolElement && getComputedStyle(toolElement).display !== 'none'
                    && getComputedStyle(toolElement).visibility !== 'hidden'
                    && Number(getComputedStyle(toolElement).opacity || 1) > 0),
                toolTitle: toolElement?.querySelector('.agent-chat-tool-title')?.textContent || '',
                composer: rect('.agent-chat-composer'),
                input: rect('.agent-chat-message-input'),
            };
        }, expectedToolName);
        assert.ok(layout.tool, `the completed ${expectedToolName} activity card must remain mounted at ${viewport.width}px`);
        assert.ok(layout.toolVisible, `the completed ${expectedToolName} activity card must be visibly rendered at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 1,
            `a completed tool card must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
        for (const [name, rect] of Object.entries({ tool: layout.tool, composer: layout.composer, input: layout.input })) {
            assert.ok(rect && rect.left >= -1 && rect.right <= layout.viewportWidth + 1 && rect.width > 0 && rect.height > 0,
                `${name} must remain visible and usable with a real tool card at ${viewport.width}px: ${JSON.stringify(layout)}`);
        }
        assert.ok(layout.tool.top >= -1 && layout.tool.bottom <= layout.viewportHeight + 1,
            `a real tool card must be scrollable into the visible viewport at ${viewport.width}px: ${JSON.stringify(layout)}`);
    }
}

async function assertResponsiveApprovalCardLayout(page) {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate(() => {
            const card = [...document.querySelectorAll('.agent-chat-approval-card')]
                .find((candidate) => /PowerShellExecutor/i.test(candidate.textContent || ''));
            card?.scrollIntoView({ block: 'center', inline: 'nearest' });
            const rect = card?.getBoundingClientRect();
            return {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                card: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
                allow: card?.querySelector('.agent-chat-approval-actions button.primary')?.getBoundingClientRect().toJSON?.() || null,
                deny: card?.querySelector('.agent-chat-approval-actions button.danger')?.getBoundingClientRect().toJSON?.() || null,
            };
        });
        assert.ok(layout.card, `a real PowerShell approval card must remain mounted at ${viewport.width}px`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 1,
            `an approval card must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
        for (const [name, rect] of Object.entries({ approval: layout.card, allow: layout.allow, deny: layout.deny })) {
            assert.ok(rect && rect.left >= -1 && rect.right <= layout.viewportWidth + 1 && rect.width > 0 && rect.height > 0,
                `${name} must stay visible and usable with a real approval card at ${viewport.width}px: ${JSON.stringify(layout)}`);
        }
        assert.ok(layout.card.top >= -1 && layout.card.bottom <= layout.viewportHeight + 1,
            `a real approval card must be scrollable into the visible viewport at ${viewport.width}px: ${JSON.stringify(layout)}`);
    }
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
        if (child.exitCode !== null) throw new Error(`Electron exited before the debugger became ready: ${stderr.value}`);
        try {
            await requestJson(`http://127.0.0.1:${port}/json/version`);
            return;
        } catch (error) {
            lastError = error;
            await sleep(200);
        }
    }
    throw new Error(`Timed out waiting for Electron remote debugging: ${lastError?.message || 'unknown error'}\n${stderr.value}`);
}

async function terminate(child) {
    if (!child || child.exitCode !== null) return;
    // `browser.close()` below asks Electron to quit through CDP.  Only wait
    // here: both `taskkill /T` and Node's Windows signal emulation can kill
    // the enclosing test job, hiding an assertion failure as a false pass.
    const exited = new Promise(resolve => child.once('exit', resolve));
    const result = await Promise.race([
        exited.then(() => 'exited'),
        sleep(5_000).then(() => 'timeout'),
    ]);
    if (result === 'timeout' && child.exitCode === null) {
        // This process was spawned by this test with an isolated AppData
        // directory. A hung CDP close must not leak it into subsequent GUI
        // tests or hold a temporary Topic lock forever.
        child.kill();
        await Promise.race([
            exited,
            sleep(2_000),
        ]);
        if (child.exitCode === null) {
            console.warn(`Electron GUI smoke could not confirm termination for PID ${child.pid}; it was isolated for diagnostics.`);
        }
    }
}

async function removeTemporaryAppData(target) {
    if (!target) return;
    let lastError = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
            await fs.rm(target, { recursive: true, force: true, maxRetries: 0 });
            return;
        } catch (error) {
            lastError = error;
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
            await sleep(200);
        }
    }
    // A delayed Windows handle must not turn a successful GUI assertion into
    // a false product failure. Leave the uniquely-named temp directory for
    // diagnostics and make the cleanup limitation explicit.
    console.warn(`Electron GUI smoke left temporary AppData after retries: ${target} (${lastError?.code || lastError})`);
}

async function writeMainChatFixture(appDataRoot) {
    const createdAt = Date.now();
    const agentId = 'Nova';
    const topicId = 'default';
    await fs.mkdir(path.join(appDataRoot, 'Agents', agentId), { recursive: true });
    await fs.mkdir(path.join(appDataRoot, 'UserData', agentId, 'topics', topicId), { recursive: true });
    await fs.writeFile(path.join(appDataRoot, 'Agents', agentId, 'config.json'), JSON.stringify({
        name: 'Nova',
        systemPrompt: '{{Nova}}',
        model: 'gpt-5.6-terra',
        temperature: 0.7,
        contextTokenLimit: 128000,
        maxOutputTokens: 4096,
        topics: [{ id: topicId, name: '主要对话', createdAt }],
        disableCustomColors: true,
        useThemeColorsInChat: true,
    }), 'utf8');
    await fs.writeFile(path.join(appDataRoot, 'UserData', agentId, 'topics', topicId, 'history.json'), '[]', 'utf8');
}

// This fixture deliberately uses the Rust Topic layout (lowercase safe Agent
// directory), not VCPChat's normal-chat history.  It gives the Electron test
// a durable transcript without a model call, so close/reopen can prove the
// Workbench rebuilds from `read-topic` rather than from renderer memory or a
// localStorage transcript cache.
async function seedDurableWorkbenchTopic(appDataRoot) {
    const topicId = 'gui-rust-snapshot-reopen';
    const updatedAt = Date.now();
    const topicDirectory = path.join(appDataRoot, 'UserData', 'nova', 'topics', topicId);
    const history = [
        { id: 'seed-user', messageId: 'seed-user', turnId: 'seed-turn', role: 'user', content: '来自 Rust checkpoint 的问题', timestamp: updatedAt - 1 },
        { id: 'seed-assistant', messageId: 'seed-assistant', turnId: 'seed-turn', role: 'assistant', content: 'Rust snapshot 只应由 read-topic 恢复。', timestamp: updatedAt },
    ];
    await fs.mkdir(topicDirectory, { recursive: true });
    await fs.writeFile(path.join(topicDirectory, 'agent-state.json'), JSON.stringify({
        version: 1,
        title: 'Rust 快照重开验收',
        snapshot: { version: 1, messages: history.map(({ id, messageId, timestamp, ...message }) => message) },
        usage: null,
        workspaceRef: root,
        model: 'gpt-5.6-terra',
        updatedAt,
    }), 'utf8');
    await fs.writeFile(path.join(topicDirectory, 'history.json'), JSON.stringify(history), 'utf8');
    return { topicId, assistantText: history[1].content };
}

async function seedLiveCompactionTopic(appDataRoot) {
    const topicId = 'gui-seed-compact';
    const topicDirectory = path.join(appDataRoot, 'UserData', 'Nova', 'topics', topicId);
    const messages = Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `GUI 压缩历史 ${index}：${'这是用于 Electron 真实上下文压缩验收的中文记录。'.repeat(120)}` }],
    }));
    await fs.mkdir(topicDirectory, { recursive: true });
    await fs.writeFile(path.join(topicDirectory, 'agent-state.json'), JSON.stringify({
        version: 1,
        title: 'Electron 真实压缩验收',
        snapshot: { version: 1, messages },
        usage: null,
        workspaceRef: root,
        model: 'gpt-5.6-terra',
        updatedAt: Date.now(),
    }), 'utf8');
    await fs.writeFile(path.join(topicDirectory, 'history.json'), '[]', 'utf8');
    return { topicId, topicDirectory };
}

async function readLiveToolBoxSettings() {
    if (!liveToolBox) return null;
    const source = process.env.VCP_AGENT_SETTINGS_PATH || path.join(root, 'AppData', 'settings.json');
    let parsed;
    try {
        parsed = JSON.parse(await fs.readFile(source, 'utf8'));
    } catch (error) {
        throw new Error(`VCPCHAT_E2E_LIVE_TOOLBOX=1 requires a readable VCP settings file: ${error.message}`);
    }
    const vcpServerUrl = String(process.env.VCP_SERVER_URL || parsed?.vcpServerUrl || '').trim();
    const vcpApiKey = String(process.env.VCP_API_KEY || parsed?.vcpApiKey || '').trim();
    if (!vcpServerUrl || !vcpApiKey) {
        throw new Error('VCPCHAT_E2E_LIVE_TOOLBOX=1 requires VCP Server URL and API Key through environment variables or the selected settings file');
    }
    // Never return or log the parsed settings object: it can contain unrelated
    // user configuration.  The isolated Electron instance needs only these
    // two values and receives them exclusively through its private AppData.
    return { vcpServerUrl, vcpApiKey };
}

async function runLiveToolBoxTurn(page, rendererErrors) {
    const inputSelector = '.agent-chat-message-input';
    // Keep this exactly aligned with the successful direct-Rust live fixture.
    // Some ToolBox models treat a dense JSON instruction as ordinary prose
    // even when `tool_choice: required` traverses a legacy gateway; this
    // natural-language form still requires the single native vcp_invoke but
    // avoids turning a UI smoke into an accidental model-prompt benchmark.
    const prompt = '请务必调用 FileOperator 的 ReadFile 读取当前工作区 package.json，只告诉我 name 字段。';
    await page.waitForSelector(inputSelector, { visible: true, timeout: timeoutMs });
    await page.waitForFunction((selector) => {
        const input = document.querySelector(selector);
        return Boolean(input && !input.disabled);
    }, { timeout: timeoutMs }, inputSelector);
    const initialAssistantMessages = await page.$$eval('.message-item.assistant .md-content', nodes => nodes.length);
    await page.click(inputSelector);
    await page.keyboard.type(prompt);
    await page.click('.agent-chat-send-button');

    try {
        const outcome = await page.waitForFunction(async (initialCount) => {
            const cards = [...document.querySelectorAll('.agent-chat-tool-activity')];
            const completed = cards.some((card) => {
                const title = card.querySelector('.agent-chat-tool-title')?.textContent || '';
                const state = card.querySelector('.agent-chat-tool-state')?.textContent || '';
                return title.includes('FileOperator') && /completed|完成|success/i.test(state);
            });
            if (completed) return 'tool-completed';
            // A model can decline the explicit tool instruction. Fail as soon
            // as the Rust runtime reports that the Turn ended, rather than
            // holding an Electron process for the full live timeout.
            const active = document.querySelector('.agent-chat-send-button')?.title !== '发送消息';
            const assistantMessages = document.querySelectorAll('.message-item.assistant .md-content').length;
            if (!active && assistantMessages > initialCount) return 'completed-without-tool';
            return null;
        }, { timeout: liveTurnTimeoutMs }, initialAssistantMessages);
        const value = await outcome.jsonValue();
        if (value !== 'tool-completed') {
            throw new Error('model completed the GUI turn without issuing the required FileOperator call');
        }
        await page.waitForFunction(() => {
            const messages = [...document.querySelectorAll('.message-item.assistant .md-content')];
            if (!messages.some((node) => String(node.textContent || '').trim().length > 0)) return false;
            const send = document.querySelector('.agent-chat-send-button');
            return send?.title === '发送消息'
                && !document.querySelector('.agent-chat-message-input')?.disabled
                && send?.title === '发送消息';
        }, { timeout: liveTurnTimeoutMs });
    } catch (error) {
        const state = await page.evaluate(async () => {
            const api = window.chatAPI || window.electronAPI;
            const status = await api.agentRuntimeGetStatus();
            return {
                toolCards: [...document.querySelectorAll('.agent-chat-tool-activity')].map((card) => ({
                    title: card.querySelector('.agent-chat-tool-title')?.textContent || '',
                    state: card.querySelector('.agent-chat-tool-state')?.textContent || '',
                })),
                approvalVisible: Boolean(document.querySelector('.agent-chat-approval-card')),
                recovery: document.querySelector('.agent-chat-activity-connection')?.textContent || null,
                notice: document.querySelector('.agent-chat-notice')?.textContent || null,
                assistantMessageCount: document.querySelectorAll('.message-item.assistant .md-content').length,
                runtime: {
                    state: status?.state || null,
                    attachment: status?.attachment || null,
                    lastError: status?.lastError || null,
                },
            };
        });
        throw new Error(`Live ToolBox GUI turn did not complete: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

async function runLiveGuiCompaction(page, compactionTopic, rendererErrors) {
    // Use the DOM to activate the shared session sidebar.
    await page.evaluate(() => {
        [...document.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
            .find((tab) => tab.textContent?.trim() === '会话')?.click();
    });
    await page.waitForSelector(`.agent-chat-persisted-topic[data-topic-id="${compactionTopic.topicId}"]`, { visible: true, timeout: timeoutMs });
    const selected = await page.evaluate((topicId) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`);
        row?.click();
        return Boolean(row);
    }, compactionTopic.topicId);
    assert.ok(selected, 'seeded compaction Topic must remain selectable while the Workbench refreshes its catalog');
    await page.waitForFunction(async (topicId) => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status?.attachment?.topicId === topicId
            && !document.querySelector('.agent-chat-message-input')?.disabled;
    }, { timeout: timeoutMs }, compactionTopic.topicId);
    await page.waitForFunction((title) => document.querySelector('.agent-chat-title')?.textContent?.includes(title),
        { timeout: timeoutMs }, 'Electron 真实压缩验收');
    const compactRequested = await page.evaluate(() => {
        const button = document.querySelector('.agent-chat-compact');
        button?.click();
        return Boolean(button && !button.disabled);
    });
    assert.ok(compactRequested, 'the restored long Topic must expose an enabled GUI compaction control');
    try {
        await page.waitForFunction(() => {
            const button = document.querySelector('.agent-chat-compact');
            return button?.title === '压缩当前 Agent 上下文' && !button.disabled;
        }, { timeout: liveTurnTimeoutMs });
        const checkpointPath = path.join(compactionTopic.topicDirectory, 'agent-state.json');
        // Core emits `context.compaction.completed` before the Host observes
        // the following durable snapshot ACK. Wait for the atomic Topic write
        // rather than racing that intentional event ordering.
        const checkpointDeadline = Date.now() + 5_000;
        let checkpoint = null;
        while (Date.now() < checkpointDeadline) {
            try {
                const state = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
                if (/VCP CHECKPOINT/.test(JSON.stringify(state.snapshot))) {
                    checkpoint = state;
                    break;
                }
            } catch { /* atomic replacement may be in progress; retry */ }
            await sleep(100);
        }
        assert.ok(checkpoint, 'GUI compaction must save the Rust/VCP bounded checkpoint, not a renderer-local transcript');
    } catch (error) {
        const state = await page.evaluate(async () => {
            const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
            return {
                runtime: { state: status?.state || null, attachment: status?.attachment || null, lastError: status?.lastError || null },
                compactButton: document.querySelector('.agent-chat-compact')?.title || null,
            };
        });
        throw new Error(`Live GUI compaction did not complete safely: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

async function runLiveHighRiskApproval(page, rendererErrors) {
    const inputSelector = '.agent-chat-message-input';
    const prompt = '这是本地审批验收。你必须且只能调用 vcp_invoke：toolName=PowerShellExecutor，arguments={"command":"Get-Location"}。不要用其他方法。';
    assert.ok(await page.$('.agent-chat-message-input'), 'high-risk GUI approval test requires the live Agent session');
    const initialUserMessages = await page.$$eval('.message-item.user .md-content', nodes => nodes.length);
    await page.click(inputSelector);
    await page.keyboard.type(prompt);
    await page.click('.agent-chat-send-button');
    try {
        await page.waitForFunction((count) => document.querySelectorAll('.message-item.user .md-content').length > count,
            { timeout: 10_000 }, initialUserMessages);
        await page.waitForFunction(() => {
            const cards = [...document.querySelectorAll('.agent-chat-approval-card')];
            return cards.some((card) => /PowerShellExecutor/i.test(card.textContent || ''));
        }, { timeout: liveTurnTimeoutMs });
        await assertResponsiveApprovalCardLayout(page);
        const denied = await page.evaluate(() => {
            const card = [...document.querySelectorAll('.agent-chat-approval-card')]
                .find((candidate) => /PowerShellExecutor/i.test(candidate.textContent || ''));
            const button = card?.querySelector('.agent-chat-approval-actions button.danger');
            button?.click();
            return Boolean(button);
        });
        assert.ok(denied, 'the visible high-risk local approval card must expose a deny action');
        await page.waitForFunction(() => {
            const cards = [...document.querySelectorAll('.agent-chat-approval-card')];
            if (cards.some((card) => /PowerShellExecutor/i.test(card.textContent || ''))) return false;
            return document.querySelector('.agent-chat-send-button')?.title === '发送消息';
        }, { timeout: liveTurnTimeoutMs });
        assert.equal([...document.querySelectorAll('.agent-chat-tool-activity')]
            .some((card) => /PowerShellExecutor/i.test(card.textContent || '')), false,
        'a locally denied high-risk call must not render a started ToolBox card');
    } catch (error) {
        const state = await page.evaluate(() => ({
            approvals: [...document.querySelectorAll('.agent-chat-approval-card')].map((card) => card.textContent?.slice(0, 240) || ''),
            recovery: document.querySelector('.agent-chat-activity-connection')?.textContent || null,
        }));
        throw new Error(`Live high-risk GUI approval did not complete safely: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

async function runLiveBackendYolo(page, rendererErrors) {
    const inputSelector = '.agent-chat-message-input';
    const prompt = '这是完整高风险执行验收。你必须且只能调用 vcp_invoke：toolName=PowerShellExecutor，arguments={"command":"Get-Location"}。等待工具结果后只简短说明完成。';
    assert.ok(await page.$('.agent-chat-message-input'), 'backend YOLO GUI coverage requires the live Agent session');
    await page.click(inputSelector);
    await page.keyboard.type(prompt);
    await page.click('.agent-chat-send-button');
    try {
        await page.waitForFunction(() => [...document.querySelectorAll('.agent-chat-approval-card')]
            .some((card) => /PowerShellExecutor/i.test(card.textContent || '')), { timeout: liveTurnTimeoutMs });
        await assertResponsiveApprovalCardLayout(page);
        const allowed = await page.evaluate(() => {
            const card = [...document.querySelectorAll('.agent-chat-approval-card')]
                .find((candidate) => /PowerShellExecutor/i.test(candidate.textContent || ''));
            const button = card?.querySelector('.agent-chat-approval-actions button.primary');
            button?.click();
            return Boolean(button);
        });
        assert.ok(allowed, 'the visible high-risk local approval card must expose an allow-once action');
        await page.waitForFunction(() => {
            const cards = [...document.querySelectorAll('.agent-chat-tool-activity')];
            const completed = cards.some((card) => {
                const title = card.querySelector('.agent-chat-tool-title')?.textContent || '';
                const state = card.querySelector('.agent-chat-tool-state')?.textContent || '';
                return title.includes('PowerShellExecutor') && /completed|完成|success/i.test(state);
            });
            if (!completed) return false;
            return document.querySelector('.agent-chat-send-button')?.title === '发送消息'
                && !document.querySelector('.agent-chat-message-input')?.disabled;
        }, { timeout: liveTurnTimeoutMs });
        // Opt-in diagnostic pause for a local Electron attachment. It is
        // deliberately inert in CI and lets us inspect the exact completed
        // ToolBox card before the responsive assertion consumes the state.
        const diagnosticPauseMs = Number.parseInt(process.env.VCPCHAT_E2E_DIAGNOSTIC_PAUSE_AFTER_TOOL_MS || '0', 10);
        if (Number.isSafeInteger(diagnosticPauseMs) && diagnosticPauseMs > 0) {
            await page.waitForTimeout(Math.min(diagnosticPauseMs, 60_000));
        }
        await assertResponsiveToolCardLayout(page, 'PowerShellExecutor');
        if (process.env.VCPCHAT_E2E_SCREENSHOT_PATH) {
            await page.setViewport({ width: 680, height: 900, deviceScaleFactor: 1 });
            const focused = await focusToolCard(page, 'PowerShellExecutor');
            assert.ok(focused.visible && focused.rect && focused.rect.top >= -1 && focused.rect.bottom <= 901,
                `the 680px screenshot must show the completed PowerShell tool card: ${JSON.stringify(focused)}`);
            await page.waitForTimeout(50);
            await page.screenshot({ path: process.env.VCPCHAT_E2E_SCREENSHOT_PATH, fullPage: false });
        }
    } catch (error) {
        const state = await page.evaluate(async () => {
            const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
            return {
                toolCards: [...document.querySelectorAll('.agent-chat-tool-activity')].map((card) => ({
                    title: card.querySelector('.agent-chat-tool-title')?.textContent || '',
                    state: card.querySelector('.agent-chat-tool-state')?.textContent || '',
                })),
                runtime: { state: status?.state || null, attachment: status?.attachment || null },
                recovery: document.querySelector('.agent-chat-activity-connection')?.textContent || null,
            };
        });
        throw new Error(`Live backend-YOLO GUI turn did not complete safely: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

async function runLiveCancellation(page, rendererErrors) {
    const inputSelector = '.agent-chat-message-input';
    assert.ok(await page.$('.agent-chat-message-input'), 'live cancellation test requires an active Agent session');
    const initialUserMessages = await page.$$eval('.message-item.user .md-content', nodes => nodes.length);
    await page.click(inputSelector);
    await page.keyboard.type('请开始一个较长的分析任务，稍后我会取消它。');
    await page.click('.agent-chat-send-button');
    try {
        await page.waitForFunction((count) => document.querySelectorAll('.message-item.user .md-content').length > count,
            { timeout: 10_000 }, initialUserMessages);
        await page.waitForFunction(() => document.querySelector('.agent-chat-send-button')?.title.includes('任务运行中'),
            { timeout: 10_000 });
        // With an empty composer the existing Workbench contract maps the
        // send control to cancel. Exercise that visible user path rather than
        // calling the preload API directly.
        await page.click('.agent-chat-send-button');
        await page.waitForFunction(() => {
            return document.querySelector('.agent-chat-send-button')?.title === '发送消息';
        }, { timeout: liveTurnTimeoutMs });
        const currentTopic = await page.evaluate(async () => {
            const api = window.chatAPI || window.electronAPI;
            const status = await api.agentRuntimeGetStatus();
            return status?.attachment?.topicId ? api.agentRuntimeReadTopic({ topicId: status.attachment.topicId }) : null;
        });
        assert.ok(currentTopic?.topicId, 'cancellation keeps a durable Rust Topic rather than a renderer-only session');
    } catch (error) {
        const state = await page.evaluate(() => ({
            sendTitle: document.querySelector('.agent-chat-send-button')?.title || null,
            recovery: document.querySelector('.agent-chat-activity-connection')?.textContent || null,
        }));
        throw new Error(`Live GUI cancellation did not restore an idle composer: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

async function runLiveRendererReload(page, rendererErrors) {
    const before = await page.evaluate(() => ({
        users: document.querySelectorAll('.message-item.user .md-content').length,
        assistants: document.querySelectorAll('.message-item.assistant .md-content').length,
    }));
    assert.ok(before.users > 0 && before.assistants > 0,
        'renderer reload coverage requires a completed live transcript');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    try {
        await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
        await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
        if (!await page.$('#nextUiInternalAppHost .agent-workbench-root')) {
            await page.click('#nextUiAddTabBtn');
            await page.waitForSelector('.next-ui-internal-app-item[title="VCP Agent"]', { visible: true, timeout: timeoutMs });
            await page.click('.next-ui-internal-app-item[title="VCP Agent"]');
        }
        await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
        await page.waitForFunction(async (expected) => {
            const users = document.querySelectorAll('.message-item.user .md-content').length;
            const assistants = document.querySelectorAll('.message-item.assistant .md-content').length;
            const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
            return users >= expected.users
                && assistants >= expected.assistants
                && status?.state === 'ready'
                && !document.querySelector('.agent-chat-message-input')?.disabled;
        }, { timeout: timeoutMs }, before);
    } catch (error) {
        const state = await page.evaluate(() => ({
            users: document.querySelectorAll('.message-item.user .md-content').length,
            assistants: document.querySelectorAll('.message-item.assistant .md-content').length,
            recovery: document.querySelector('.agent-chat-activity-connection')?.textContent || null,
        }));
        throw new Error(`Live renderer reload did not restore the Agent transcript: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

let browser;
let child;
let appData;
let compactionTopic;
let durableWorkbenchTopic;
try {
    await fs.access(electronBinary);
    const liveSettings = await readLiveToolBoxSettings();
    const port = await freePort();
    appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-electron-smoke-'));
    // Start in the redesigned shell so this is an actual smoke of the
    // user-visible account-dock settings entry rather than the legacy panel.
    await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
        uiMode: 'next',
        // The direct-daemon smoke below never sends a model request. These
        // harmless isolated values only let its control plane start, so no
        // user setting or real API key is needed for Electron coverage.
        vcpServerUrl: liveSettings?.vcpServerUrl || 'http://127.0.0.1:9',
        vcpApiKey: liveSettings?.vcpApiKey || 'test-only-placeholder',
        // A live developer VCPChat instance owns the actual local capability
        // node used by the backend-YOLO opt-in. The isolated smoke must not
        // create a competing listener on its fixed DistributedServer port.
        enableDistributedServer: false,
        agentRuntime: { tui: { defaultModel: 'gpt-5.6-terra', budget: { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 } } },
    }), 'utf8');
    // Keep this test hermetic while still exercising the real main-chat
    // selection path.  The fixture is deliberately an ordinary VCPChat
    // Agent config, not an Agent Workbench-specific replacement.
    await writeMainChatFixture(appData);
    durableWorkbenchTopic = await seedDurableWorkbenchTopic(appData);
    if (liveGuiCompaction) compactionTopic = await seedLiveCompactionTopic(appData);
    const stderr = { value: '' };
    const environment = {
        ...process.env,
        VCPCHAT_APP_DATA_DIR: appData,
        VCPCHAT_E2E_TEST: '1'
    };
    delete environment.ELECTRON_RUN_AS_NODE;

    child = spawn(electronBinary, [
        ...(packagedExecutable ? [] : ['.']),
        '--allow-multiple-instances',
        `--remote-debugging-port=${port}`,
    ], {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: false
    });
    child.stderr.on('data', chunk => {
        stderr.value = `${stderr.value}${chunk}`.slice(-8_000);
    });

    await waitForDebugger(port, child, stderr);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const deadline = Date.now() + timeoutMs;
    let page;
    while (Date.now() < deadline) {
        page = (await browser.pages()).find(candidate => candidate.url().includes('main.html'));
        if (page) break;
        await sleep(100);
    }
    assert.ok(page, 'main renderer page must be attached to the Electron process');
    const rendererErrors = [];
    page.on('pageerror', error => rendererErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
        if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
    });

    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.waitForSelector('#agentList li[data-item-id="Nova"][data-item-type="agent"]', { visible: true, timeout: timeoutMs });
    await page.click('#agentList li[data-item-id="Nova"][data-item-type="agent"]');
    await page.waitForFunction(() => {
        const input = document.getElementById('messageInput');
        return Boolean(input && !input.disabled);
    }, { timeout: timeoutMs });
    await page.click('#quickNewTopicBtn');
    await page.waitForFunction(() => {
        const title = document.getElementById('currentChatAgentName');
        const input = document.getElementById('messageInput');
        return Boolean(title?.textContent?.includes('Nova') && input && !input.disabled);
    }, { timeout: timeoutMs });
    await page.click('#messageInput');
    await page.keyboard.type('这是隔离主聊天 smoke 草稿');
    assert.equal(await page.$eval('#messageInput', input => input.value), '这是隔离主聊天 smoke 草稿',
        'selecting a normal Agent and creating a topic must unlock the main-chat composer');
    await page.waitForSelector('#nextUiAccountSettingsBtn', { visible: true, timeout: timeoutMs });
    await page.click('#nextUiAccountSettingsBtn');
    try {
        await page.waitForSelector('#globalSettingsModal', { visible: true, timeout: timeoutMs });
    } catch (error) {
        const modalState = await page.evaluate(() => {
            const button = document.getElementById('globalSettingsBtn');
            const modal = document.getElementById('globalSettingsModal');
            const template = document.getElementById('globalSettingsModalTemplate');
            return {
                buttonConnected: Boolean(button?.isConnected),
                buttonDisabled: Boolean(button?.disabled),
                modalExists: Boolean(modal),
                modalClassName: modal?.className || '',
                templateExists: Boolean(template),
                modalContainerChildren: document.getElementById('modal-container')?.childElementCount || 0,
                rendererReady: document.documentElement.dataset.vcpRendererReady || ''
            };
        });
        throw new Error(`Global settings modal did not become visible: ${JSON.stringify(modalState)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
    // The production form validates the server URL. A loopback discard port
    // proves form submission without calling a real ToolBox from this GUI-only
    // smoke instance.
    await page.click('.settings-nav-item[data-section="server-connection"]');
    await page.waitForFunction(() => document.getElementById('section-server-connection')?.classList.contains('active'), { timeout: timeoutMs });
    await page.click('#vcpServerUrl');
    await page.keyboard.type('http://127.0.0.1:9');
    await page.click('.settings-nav-item[data-section="render-settings"]');
    await page.waitForFunction(() => document.getElementById('section-render-settings')?.classList.contains('active'), { timeout: timeoutMs });
    // Custom Switch intentionally hides the native checkbox. Its value is
    // still part of the submitted form contract, but visibility is provided
    // by the adjacent slider label.
    await page.waitForSelector('#enableNextUi', { timeout: timeoutMs });
    const currentMode = await page.$eval('#enableNextUi', input => input.checked);
    if (!currentMode) await page.click('#enableNextUi');
    await page.click('#globalSettingsModal button[type="submit"][form="globalSettingsForm"]');
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    // The settings implementation removes the modal from the DOM rather than
    // consistently toggling its `hidden` class. `waitForFunction` can remain
    // attached to the old renderer execution context during that removal, so
    // use Puppeteer's selector lifecycle instead.
    await page.waitForSelector('#globalSettingsModal', { hidden: true, timeout: timeoutMs });

    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.uiMode === 'next', { timeout: timeoutMs });
    await page.waitForFunction(() => document.documentElement.dataset.vcpRendererReady === 'true', { timeout: timeoutMs });

    // Internal applications are part of the same Next UI lifecycle. Verify
    // that the Rust Agent surface can be opened from the real launchpad and
    // removed through its tab close control without leaving a mounted view.
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCP Agent"]', { visible: true, timeout: timeoutMs });
    await page.click('.next-ui-internal-app-item[title="VCP Agent"]');
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    await page.waitForSelector('.next-ui-tab[data-view-id="app:agent-workbench"]', { visible: true, timeout: timeoutMs });
    await assertResponsiveWorkbench(page);

    // R2: select an actual durable Rust Topic through the visible Workbench,
    // then tear down and remount that Workbench.  The only permitted source of
    // the transcript after remount is daemon `read-topic`; localStorage stores
    // the Topic pointer only, and Electron Main intentionally retains none of
    // the messages, tools or events.
    await page.evaluate(() => {
        const tab = [...document.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
            .find((candidate) => candidate.textContent.trim() === '会话');
        tab?.click();
    });
    await page.waitForFunction((topicId) => Boolean(document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`)), { timeout: timeoutMs }, durableWorkbenchTopic.topicId);
    await page.click(`.agent-chat-persisted-topic[data-topic-id="${durableWorkbenchTopic.topicId}"]`);
    await page.waitForFunction((text) => [...document.querySelectorAll('.message-item.assistant .md-content')]
        .some((node) => node.textContent.includes(text)), { timeout: timeoutMs }, durableWorkbenchTopic.assistantText);
    assert.deepEqual(await page.evaluate(() => JSON.parse(window.localStorage.getItem('vcpchat.agentWorkbench.lastTopic.v1'))), {
        topicId: durableWorkbenchTopic.topicId,
    }, 'Workbench localStorage may retain only the durable Rust Topic pointer');
    await page.click('.next-ui-tab[data-view-id="app:agent-workbench"] .next-ui-tab-close');
    await page.waitForFunction(() => !document.querySelector('#nextUiInternalAppHost .agent-workbench-root'), { timeout: timeoutMs });
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCP Agent"]', { visible: true, timeout: timeoutMs });
    await page.click('.next-ui-internal-app-item[title="VCP Agent"]');
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    await page.waitForFunction((text) => [...document.querySelectorAll('.message-item.assistant .md-content')]
        .some((node) => node.textContent.includes(text)), { timeout: timeoutMs }, durableWorkbenchTopic.assistantText);

    await page.waitForSelector('.agent-chat-usage-toggle', { visible: true, timeout: timeoutMs });
    const openedUsage = await page.evaluate(() => {
        const toggle = document.querySelector('.agent-chat-usage-toggle');
        toggle?.click();
        return Boolean(toggle);
    });
    assert.ok(openedUsage, 'Agent Workbench must provide a usage control in the real Electron surface');
    await page.waitForSelector('.agent-chat-usage-budget', { visible: true, timeout: timeoutMs });
    const configuredDaemonPid = await waitForDaemonChild(child.pid);
    const configuredDaemonCommand = await readProcessCommandLine(configuredDaemonPid);
    assert.ok(configuredDaemonCommand.includes(appData),
        `Rust daemon must receive this Electron instance's shared AppData paths, got: ${configuredDaemonCommand}`);
    if (expectedDaemonOverride) {
        assert.ok(configuredDaemonCommand.toLocaleLowerCase().includes(expectedDaemonOverride.toLocaleLowerCase()),
            `Rust daemon must use VCP_AGENT_RUST_DAEMON_PATH for release smoke, got: ${configuredDaemonCommand}`);
    }
    if (expectedPackagedDaemon) {
        assert.ok(configuredDaemonCommand.toLocaleLowerCase().includes(expectedPackagedDaemon.toLocaleLowerCase()),
            `packaged VCPChat must launch its extraResources daemon, got: ${configuredDaemonCommand}`);
    } else if (!expectedDaemonOverride) {
        assert.ok(configuredDaemonCommand.toLocaleLowerCase().includes(expectedSourceDaemon.toLocaleLowerCase()),
            `development VCPChat must launch the in-repository Rust daemon, got: ${configuredDaemonCommand}`);
    }
    const daemonRuntime = await page.evaluate(() => (window.chatAPI || window.electronAPI).agentRuntimeGetStatus());
    assert.equal(daemonRuntime?.worker?.buildRevision, expectedSourceRevision,
        'Electron must report the same Rust revision that the workspace builds');
    const daemonSettings = await page.evaluate(() => (window.chatAPI || window.electronAPI).agentRuntimeGetWorkbenchSettings());
    assert.deepEqual(daemonSettings?.budget, { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 },
        'the direct daemon must expose the isolated shared-settings budget before the Workbench projects it');
    try {
        await page.waitForFunction(() => document.querySelector('.agent-chat-usage-budget [name="maxRequestsPerTurn"]')?.value === '8', { timeout: timeoutMs });
    } catch (error) {
        const budgetState = await page.evaluate(() => ({
            requestLimit: document.querySelector('.agent-chat-usage-budget [name="maxRequestsPerTurn"]')?.value ?? null,
            tokenLimit: document.querySelector('.agent-chat-usage-budget [name="maxTokensPerTurn"]')?.value ?? null,
            recovery: document.querySelector('.agent-chat-activity-connection')?.textContent ?? null,
        }));
        throw new Error(`Agent Workbench did not receive its non-sensitive daemon budget snapshot: ${JSON.stringify(budgetState)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
    assert.equal(await page.$eval('.agent-chat-usage-budget [name="maxRequestsPerTurn"]', input => input.value), '8',
        'the real Electron Workbench must receive the Rust daemon budget snapshot without reading credentials');
    assert.equal(await page.$eval('.agent-chat-usage-budget [name="maxTokensPerTurn"]', input => input.value), '120000');
    // The usage panel lives in the Activity side-panel, not the header. Close it
    // before exercising the primary chat flow so the live-card assertions prove
    // the conversation surface itself rather than a settings panel covering it.
    const usageClosed = await page.evaluate(() => {
        const button = document.querySelector('.agent-chat-usage-toggle');
        button?.click();
        return Boolean(button);
    });
    assert.ok(usageClosed, 'the usage panel must be dismissible through its visible toggle');
    await page.waitForSelector('.agent-chat-usage-budget', { hidden: true, timeout: timeoutMs });

    // Establish a durable Topic without contacting a model, then terminate
    // only this Electron child's daemon. This validates the user-visible
    // crash boundary: there is no auto replay, only explicit reconnect.
    const openedSession = await page.evaluate(() => {
        const button = document.querySelector('.agent-chat-header-actions .agent-chat-icon-button[title="新建 Agent 会话"]');
        button?.click();
        return Boolean(button);
    });
    assert.ok(openedSession, 'Workbench must expose a real new-session action for daemon crash recovery');
    await page.waitForFunction(() => {
        const input = document.querySelector('.agent-chat-message-input');
        return Boolean(input && !input.disabled);
    }, { timeout: timeoutMs });
    if (liveToolBox) {
        await runLiveToolBoxTurn(page, rendererErrors);
        if (liveGuiCompaction) await runLiveGuiCompaction(page, compactionTopic, rendererErrors);
        if (liveRendererReload) await runLiveRendererReload(page, rendererErrors);
        if (liveHighRiskApproval) await runLiveHighRiskApproval(page, rendererErrors);
        if (liveBackendYolo) await runLiveBackendYolo(page, rendererErrors);
        if (liveCancellation) await runLiveCancellation(page, rendererErrors);
    }
    const attachedBeforeCrash = await page.evaluate(() => (window.chatAPI || window.electronAPI).agentRuntimeGetStatus());
    const crashedDaemonPid = Number(attachedBeforeCrash?.worker?.pid);
    assert.ok(Number.isSafeInteger(crashedDaemonPid) && crashedDaemonPid > 0,
        'runtime status must identify the currently attached daemon before the crash test');
    await stopTestDaemon(crashedDaemonPid);
    await page.waitForSelector('.agent-chat-connection-reconnect', { visible: true, timeout: timeoutMs });
    assert.match(await page.$eval('.agent-chat-activity-connection', node => node.textContent), /vcp-agentd exited/,
        'a direct daemon crash must surface a diagnostic rather than silently disabling Agent controls');
    const reconnectRequested = await page.evaluate(() => {
        const button = document.querySelector('.agent-chat-connection-reconnect');
        button?.click();
        return Boolean(button);
    });
    assert.ok(reconnectRequested, 'crashed daemon recovery must be explicit and user initiated');
    await page.waitForFunction(async () => {
        const input = document.querySelector('.agent-chat-message-input');
        if (!input || input.disabled || document.querySelector('.agent-chat-connection-reconnect')) return false;
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status?.state === 'ready' && status?.worker?.available === true;
    }, { timeout: timeoutMs });
    const recoveredRuntime = await page.evaluate(() => (window.chatAPI || window.electronAPI).agentRuntimeGetStatus());
    assert.equal(recoveredRuntime?.state, 'ready', 'manual recovery must leave the Rust runtime ready');
    assert.equal(recoveredRuntime?.worker?.available, true, 'manual recovery must own a fresh daemon transport');
    const recoveredDaemonPid = Number(recoveredRuntime?.worker?.pid);
    assert.ok(Number.isSafeInteger(recoveredDaemonPid) && recoveredDaemonPid > 0,
        'manual recovery must report its newly attached daemon process');
    assert.notEqual(recoveredDaemonPid, crashedDaemonPid,
        'manual recovery must spawn a fresh daemon process instead of reviving the crashed transport');
    await page.click('.next-ui-tab[data-view-id="app:agent-workbench"] .next-ui-tab-close');
    await page.waitForFunction(() => !document.querySelector('#nextUiInternalAppHost .agent-workbench-root'), { timeout: timeoutMs });

    console.log(`Electron GUI smoke passed: renderer boot, main-chat Nova selection/topic/composer, global settings save, Next UI reload, daemon-owned budget readback,${liveToolBox ? ' opt-in live ToolBox FileOperator turn,' : ''}${liveGuiCompaction ? ' opt-in live GUI compaction,' : ''}${liveRendererReload ? ' opt-in Agent renderer reload,' : ''}${liveHighRiskApproval ? ' opt-in denied PowerShell approval,' : ''}${liveBackendYolo ? ' opt-in allowed PowerShell backend-YOLO,' : ''}${liveCancellation ? ' opt-in cancellation,' : ''} and explicit Rust daemon crash recovery.`);
} catch (error) {
    // Electron can close its remote-debugging endpoint during cleanup. Emit the
    // actual assertion before that happens so a live UI regression is never
    // mistaken for a silent, successful smoke exit.
    console.error(`Electron GUI smoke failed: ${error?.stack || error}`);
    throw error;
} finally {
    // CDP Browser.close is an Electron-aware graceful shutdown. It avoids a
    // Windows process-tree kill that could take the Node test runner with it.
    if (browser) {
        const closed = await Promise.race([
            browser.close().then(() => true).catch(() => false),
            sleep(8_000).then(() => false),
        ]);
        if (!closed) browser.disconnect();
    }
    await terminate(child);
    await removeTemporaryAppData(appData);
}
