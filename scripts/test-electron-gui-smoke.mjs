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
// Individual live gates may run independently after a prior FileOperator
// proof.  Keeping this explicit prevents a flaky model response in the
// read-only tool precondition from hiding the approval-card result.
const skipLiveFileOperator = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_SKIP_FILEOPERATOR === '1';
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
// R3-B visual probes remain opt-in: they require an operator-provided
// ToolBox and are intentionally not a source of CI model traffic.
const liveToolBoxWs = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_WS === '1';
const liveLongStream = liveToolBox && process.env.VCPCHAT_E2E_LIVE_TOOLBOX_LONG_STREAM === '1';
// This is a diagnostic escape hatch for the UI-only portion of the suite.
// It is deliberately opt-in and never changes the default R2 crash/reconnect
// gate. Some Windows test hosts terminate their containing job when a child
// daemon is force-stopped, which would otherwise make the preceding R3 visual
// assertions produce neither a pass record nor a failure report.
const skipCrashRecovery = process.env.VCPCHAT_E2E_SKIP_CRASH_RECOVERY === '1';
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
const smokeResultFile = process.env.VCPCHAT_E2E_RESULT_FILE
    ? path.resolve(process.env.VCPCHAT_E2E_RESULT_FILE)
    : null;
let smokePhase = 'boot';

async function confirmTopicFlow(page, label) {
    await page.waitForSelector('.agent-chat-topic-flow-dialog', { visible: true, timeout: timeoutMs });
    // Opening a persisted Topic starts with an explicit Rust read-topic
    // loading state. Wait for the requested action instead of racing the
    // first visible dialog frame, which only contains the safe Cancel action.
    await page.waitForFunction((buttonLabel) => {
        const dialog = document.querySelector('.agent-chat-topic-flow-dialog');
        return [...(dialog?.querySelectorAll('button') || [])]
            .some((candidate) => candidate.textContent?.trim() === buttonLabel && !candidate.disabled);
    }, { timeout: timeoutMs }, label);
    const clicked = await page.evaluate((buttonLabel) => {
        const dialog = document.querySelector('.agent-chat-topic-flow-dialog');
        const button = [...(dialog?.querySelectorAll('button') || [])]
            .find((candidate) => candidate.textContent?.trim() === buttonLabel);
        if (button) {
            button.click();
            return { clicked: true, text: dialog?.textContent?.slice(0, 1_200) || '' };
        }
        return { clicked: false, text: dialog?.textContent?.slice(0, 1_200) || '' };
    }, label);
    assert.ok(clicked.clicked, `Topic flow must expose ${label}: ${clicked.text}`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function recordSmokeResult(status, phase = null, failure = null) {
    if (phase) smokePhase = phase;
    if (!smokeResultFile) return;
    // This is a test-harness liveness receipt, not product persistence. It
    // deliberately contains no settings, endpoint, credentials or tool data.
    await fs.writeFile(smokeResultFile, JSON.stringify({
        status,
        liveToolBox,
        skipLiveFileOperator,
        liveToolBoxWs,
        liveLongStream,
        liveHighRiskApproval,
        skipCrashRecovery,
        phase,
        // Keep a short, credential-safe failure hint for harnesses whose
        // enclosing Windows job is terminated before stderr can flush.
        failure: failure ? String(failure)
            .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
            .slice(0, 1200) : null,
        timestamp: Date.now(),
    }), 'utf8');
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

async function findDaemonChildren(parentPid) {
    if (process.platform !== 'win32') return null;
    const numericParentPid = Number(parentPid);
    if (!Number.isSafeInteger(numericParentPid) || numericParentPid <= 0) return [];
    const shell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : 'powershell.exe';
    // A missing child is a normal polling state during daemon restart.  Avoid
    // treating a transient CIM query failure as a test crash; waitForDaemonChild
    // will retry and then report the actual attachment failure if it persists.
    const script = `Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ParentProcessId -eq ${numericParentPid} -and $_.Name -ieq 'vcp-agentd.exe' } | Select-Object -ExpandProperty ProcessId`;
    try {
        const { stdout } = await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true,
            timeout: 5_000,
        });
        return String(stdout).split(/\s+/)
            .map(value => Number.parseInt(value, 10))
            .filter(pid => Number.isSafeInteger(pid) && pid > 0);
    } catch {
        return [];
    }
}

async function findDaemonChild(parentPid) {
    return (await findDaemonChildren(parentPid))[0] || null;
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

// A deterministic companion to the opt-in provider long-stream check. The
// daemon/live gate proves the actual stream; this one keeps the CSS layout
// contract reproducible when the provider is unavailable. It deliberately
// uses the same message-item/md-content structure rendered by the Workbench.
async function assertResponsiveLongMessageLayout(page) {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate(async () => {
            const feed = document.querySelector('.agent-chat-messages-container');
            const items = document.querySelector('.agent-chat-messages');
            if (!feed || !items) return null;
            document.querySelector('.agent-chat-long-layout-fixture')?.remove();
            const row = document.createElement('article');
            row.className = 'message-item assistant agent-chat-long-layout-fixture';
            const content = document.createElement('div');
            content.className = 'md-content';
            content.textContent = '长流视觉回归内容。'.repeat(900);
            row.append(content);
            items.append(row);
            // Read synchronously after insertion. Awaiting animation frames
            // lets the live Workbench's independently scheduled projection
            // replaceChildren() race this synthetic CSS fixture away.
            void row.offsetHeight;
            const rowStyle = getComputedStyle(row);
            const feedStyle = getComputedStyle(feed);
            const itemsStyle = getComputedStyle(items);
            const contentRect = content.getBoundingClientRect();
            const feedRect = feed.getBoundingClientRect();
            const maxScroll = Math.max(0, feed.scrollHeight - feed.clientHeight);
            feed.scrollTop = Math.floor(maxScroll / 2);
            const anchor = feed.scrollTop;
            const result = {
                viewportWidth: window.innerWidth,
                documentScrollWidth: document.documentElement.scrollWidth,
                feedScrollHeight: feed.scrollHeight,
                feedClientHeight: feed.clientHeight,
                feedScrollTop: anchor,
                rowHeight: row.getBoundingClientRect().height,
                contentHeight: contentRect.height,
                contentVisibility: rowStyle.contentVisibility,
                feedFlexDirection: feedStyle.flexDirection,
                itemsDisplay: itemsStyle.display,
                itemsFlex: itemsStyle.flex,
                itemsMinHeight: itemsStyle.minHeight,
                itemsHeight: items.getBoundingClientRect().height,
                itemsOverflow: itemsStyle.overflow,
                rowDisplay: rowStyle.display,
                rowVisibility: rowStyle.visibility,
                rowPosition: rowStyle.position,
                rowChildren: row.childElementCount,
                feed: { left: feedRect.left, right: feedRect.right },
            };
            row.remove();
            return result;
        });
        assert.ok(layout, `Agent feed must exist for the long-message layout check at ${viewport.width}px`);
        // Chromium reports the initial `visible` value as an empty string on
        // some Electron builds. The invariant is that Agent rows never retain
        // the shared main-chat `auto` optimization.
        assert.notEqual(layout.contentVisibility, 'auto', `Agent long messages must not inherit content-visibility:auto at ${viewport.width}px`);
        assert.ok(layout.rowHeight > layout.feedClientHeight,
            `a long Agent message must receive a real rendered height at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.feedScrollHeight > layout.feedClientHeight,
            `Agent feed must remain scrollable for a long streamed message at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.feedScrollTop > 0,
            `Agent feed must accept a non-bottom reading anchor at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.documentScrollWidth <= layout.viewportWidth + 1,
            `long Agent content must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
    }
}

async function assertResponsiveReadinessLayout(page) {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate(() => {
            const rect = (element) => {
                if (!element) return null;
                const value = element.getBoundingClientRect();
                return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
            };
            const cards = [...document.querySelectorAll('.agent-chat-readiness-card')];
            cards[0]?.scrollIntoView({ block: 'center', inline: 'nearest' });
            return {
                viewportWidth: window.innerWidth,
                scrollWidth: document.documentElement.scrollWidth,
                root: rect(document.querySelector('.agent-chat-root')),
                main: rect(document.querySelector('.agent-chat-main-content')),
                panel: rect(document.querySelector('.agent-chat-activity-panel')),
                cards: cards.map(rect),
                labels: cards.map((card) => card.dataset.readiness || ''),
            };
        });
        assert.deepEqual(layout.labels.sort(), ['capability', 'profile', 'server', 'toolbox'],
            `connection panel must render exactly the four daemon-owned readiness facts at ${viewport.width}px`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 1,
            `readiness cards must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.panel && layout.panel.width > 0, `readiness panel must be open at ${viewport.width}px`);
        for (const card of layout.cards) {
            assert.ok(card && card.left >= -1 && card.right <= layout.viewportWidth + 1 && card.width > 0 && card.height > 0,
                `each readiness card must remain visible and readable at ${viewport.width}px: ${JSON.stringify({ card, root: layout.root, main: layout.main, panel: layout.panel, scrollWidth: layout.scrollWidth })}`);
        }
    }
}

async function assertResponsiveToolboxWsCardLayout(page) {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate(() => {
            const card = document.querySelector('.agent-chat-toolbox-ws-card');
            card?.scrollIntoView({ block: 'center', inline: 'nearest' });
            const rect = card?.getBoundingClientRect();
            return {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                card: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null,
                textLength: card?.textContent?.length || 0,
            };
        });
        assert.ok(layout.card && layout.textLength > 0,
            `a real ToolBox WS observation must remain mounted at ${viewport.width}px`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 1,
            `a ToolBox WS card must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.card.left >= -1 && layout.card.right <= layout.viewportWidth + 1
            && layout.card.top >= -1 && layout.card.bottom <= layout.viewportHeight + 1,
        `a ToolBox WS card must be scrollable into view at ${viewport.width}px: ${JSON.stringify(layout)}`);
    }
}

async function assertWorkbenchSidebarTabs(page) {
    for (const label of ['会话', '设置', '助手']) {
        const clicked = await page.evaluate((tabLabel) => {
            const button = [...document.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
                .find((candidate) => candidate.textContent?.trim() === tabLabel);
            button?.click();
            return Boolean(button);
        }, label);
        assert.ok(clicked, `Agent sidebar must expose the ${label} tab`);
        await page.waitForFunction((tabLabel) => {
            const selected = [...document.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
                .find((candidate) => candidate.textContent?.trim() === tabLabel);
            const active = document.querySelector('.agent-chat-sidebar .sidebar-tab-content.active');
            const primary = tabLabel === '助手'
                ? document.querySelector('.agent-chat-sidebar .agent-chat-agent-row .agent-name')
                : tabLabel === '会话'
                    ? document.querySelector('.agent-chat-sidebar .next-ui-create-topic-trigger')
                    : document.querySelector('.agent-chat-sidebar .agent-chat-setting-input');
            return selected?.getAttribute('aria-selected') === 'true' && Boolean(active && primary);
        }, { timeout: timeoutMs }, label);
        const layout = await page.evaluate((tabLabel) => {
            const rect = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const value = element.getBoundingClientRect();
                return { left: value.left, right: value.right, width: value.width, height: value.height };
            };
            const content = document.querySelector('.agent-chat-sidebar .sidebar-tab-content.active');
            return {
                sidebar: rect('.agent-chat-sidebar'),
                content: rect('.agent-chat-sidebar .sidebar-tab-content.active'),
                hasMainPaneClass: content?.classList.contains('agent-chat-pane') || false,
                horizontalOverflow: content ? content.scrollWidth > content.clientWidth + 1 : true,
                primaryControl: tabLabel === '助手'
                    ? rect('.agent-chat-sidebar .agent-chat-agent-row .agent-name')
                    : tabLabel === '会话'
                        ? rect('.agent-chat-sidebar .next-ui-create-topic-trigger')
                        : rect('.agent-chat-sidebar .agent-chat-setting-input'),
                settingsPadding: tabLabel === '设置'
                    ? Number.parseFloat(getComputedStyle(document.querySelector('.agent-chat-settings-pane') || content).paddingLeft || '0')
                    : null,
            };
        }, label);
        assert.ok(layout.sidebar && layout.content && layout.content.width >= layout.sidebar.width * 0.8,
            `${label} content must use the sidebar width instead of collapsing into a narrow main-pane column: ${JSON.stringify(layout)}`);
        assert.ok(layout.primaryControl && layout.primaryControl.width >= layout.sidebar.width * 0.35,
            `${label} primary content must remain horizontally readable: ${JSON.stringify(layout)}`);
        assert.equal(layout.hasMainPaneClass, false, `${label} content must not inherit agent-chat-pane`);
        assert.equal(layout.horizontalOverflow, false, `${label} content must not overflow horizontally`);
        if (label === '设置') {
            assert.ok(layout.settingsPadding > 0, `settings must keep a real left page margin, got ${layout.settingsPadding}px`);
        }
    }
}

async function assertResponsiveTopicFlow(page, expectedButton) {
    const viewports = [
        { width: 680, height: 900 },
        { width: 960, height: 900 },
        { width: 1440, height: 960 },
    ];
    for (const viewport of viewports) {
        await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await page.waitForFunction((expectedWidth) => window.innerWidth === expectedWidth, {}, viewport.width);
        const layout = await page.evaluate((buttonLabel) => {
            const rect = (element) => {
                if (!element) return null;
                const value = element.getBoundingClientRect();
                return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
            };
            const dialog = document.querySelector('.agent-chat-topic-flow-dialog');
            const action = [...(dialog?.querySelectorAll('button') || [])]
                .find((candidate) => candidate.textContent?.trim() === buttonLabel);
            return {
                viewportWidth: window.innerWidth,
                viewportHeight: window.innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                dialog: rect(dialog),
                action: rect(action),
                visibleText: dialog?.textContent || '',
            };
        }, expectedButton);
        assert.ok(layout.dialog && layout.action,
            `Topic flow must show its dialog and ${expectedButton} action at ${viewport.width}px: ${JSON.stringify(layout)}`);
        assert.ok(layout.scrollWidth <= layout.viewportWidth + 1,
            `Topic flow must not create horizontal document overflow at ${viewport.width}px: ${JSON.stringify(layout)}`);
        for (const [name, rect] of Object.entries({ dialog: layout.dialog, action: layout.action })) {
            assert.ok(rect.left >= -1 && rect.right <= layout.viewportWidth + 1 && rect.width > 0 && rect.height > 0,
                `Topic flow ${name} must stay visible and usable at ${viewport.width}px: ${JSON.stringify(rect)}`);
        }
        assert.ok(layout.dialog.top >= -1 && layout.dialog.bottom <= layout.viewportHeight + 1,
            `Topic flow dialog must fit the active viewport at ${viewport.width}px: ${JSON.stringify(layout.dialog)}`);
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
                // Local approval deliberately makes deny the prominent/default
                // action. "允许一次" remains a visible secondary action.
                allow: card?.querySelector('.agent-chat-approval-actions button.secondary')?.getBoundingClientRect().toJSON?.() || null,
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
    if (!child) return;
    // Electron is the direct parent of the daemon. Capture only those exact
    // child PIDs *before* browser.close()/Stop-Process can orphan them; a
    // parent-only Windows termination otherwise leaks vcp-agentd.exe and its
    // temporary Topic lease after a successful smoke run.
    const daemonPids = await findDaemonChildren(child.pid);
    if (child.exitCode !== null) {
        await Promise.all(daemonPids.map(pid => stopTestDaemon(pid).catch(() => {})));
        return;
    }
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
        const forced = await Promise.race([
            exited,
            sleep(2_000),
        ]);
        if (!forced && child.exitCode === null && process.platform === 'win32') {
            // `ChildProcess.kill()` is best-effort on Windows and can leave
            // an Electron process alive after its CDP endpoint has gone away.
            // This is the exact PID spawned above (never a name/glob/tree
            // scan), so forcing it cannot touch the operator's VCPChat.
            const pid = Number(child.pid);
            if (Number.isSafeInteger(pid) && pid > 0) {
                const shell = process.env.SystemRoot
                    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
                    : 'powershell.exe';
                await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force`], {
                    windowsHide: true,
                    timeout: 5_000,
                }).catch(() => {});
                await Promise.race([exited, sleep(2_000)]);
            }
        }
        if (child.exitCode === null) {
            console.warn(`Electron GUI smoke could not confirm termination for its isolated PID ${child.pid}.`);
        }
    }
    // Never use taskkill /T here: a test runner may share a Windows job with
    // its Electron child. These PIDs were proved to be children of this exact
    // isolated Electron instance, so stopping them is narrow and cannot touch
    // an operator's VCPChat daemon.
    await Promise.all(daemonPids.map(pid => stopTestDaemon(pid).catch(() => {})));
}

async function removeTemporaryAppData(target) {
    if (!target) return;
    if (process.env.VCPCHAT_E2E_KEEP_APP_DATA === '1') {
        console.warn(`Electron GUI smoke retained isolated AppData for diagnostics: ${target}`);
        return;
    }
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
async function seedDurableWorkbenchTopic(appDataRoot, ordinal = 0) {
    const topicId = ordinal === 0 ? 'gui-rust-snapshot-reopen' : `gui-rust-snapshot-preview-${ordinal}`;
    const updatedAt = Date.now();
    const topicDirectory = path.join(appDataRoot, 'AgentRuntimeData', 'nova', 'topics', topicId);
    const history = [
        { id: `seed-user-${ordinal}`, messageId: `seed-user-${ordinal}`, turnId: `seed-turn-${ordinal}`, role: 'user', content: `来自 Rust checkpoint 的问题 #${ordinal}`, timestamp: updatedAt - 1 },
        { id: `seed-assistant-${ordinal}`, messageId: `seed-assistant-${ordinal}`, turnId: `seed-turn-${ordinal}`, role: 'assistant', content: `Rust snapshot #${ordinal} 只应由 read-topic 恢复。`, timestamp: updatedAt },
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
    const topicDirectory = path.join(appDataRoot, 'AgentRuntimeData', 'Nova', 'topics', topicId);
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

    // The daemon-owned turn.started event must establish both pieces of live
    // UI state before any assistant/tool result arrives: the submitted user
    // message and the cancellable stop control. This prevents ACK-only
    // regressions where replies render but the user's side stays invisible.
    await page.waitForFunction((submitted) => {
        const userVisible = [...document.querySelectorAll('.message-item.user .md-content')]
            .some((node) => (node.textContent || '').includes(submitted));
        const send = document.querySelector('.agent-chat-send-button');
        return userVisible
            && send?.classList.contains('interrupt-mode')
            && send?.querySelector('.vcp-ui-icon')?.textContent === 'stop'
            && send?.getAttribute('aria-label') === '取消当前任务';
    }, { timeout: timeoutMs }, prompt);

    try {
        const outcome = await page.waitForFunction(async (initialCount) => {
            const cards = [...document.querySelectorAll('.agent-chat-tool-activity')];
            const completed = cards.some((card) => {
                const title = card.querySelector('.agent-chat-tool-title')?.textContent || '';
                const state = card.querySelector('.agent-chat-tool-status-badge')?.textContent || card.dataset.status || '';
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
                    state: card.querySelector('.agent-chat-tool-status-badge')?.textContent || card.dataset.status || '',
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

async function runLiveToolBoxWsVisualRegression(page, rendererErrors) {
    // The Rust daemon is the only observer. This gate neither opens a WebSocket
    // from Electron nor fabricates an event; it waits for a real read-only
    // VCPlog/vcpinfo observation generated by the preceding live tool turn.
    const opened = await page.evaluate(() => {
        const panel = document.querySelector('.agent-chat-activity-panel');
        if (panel?.getAttribute('aria-hidden') !== 'false') {
            document.querySelector('.agent-chat-status-chip[data-action="connection"]')?.click();
        }
        return Boolean(panel);
    });
    assert.ok(opened, 'the ToolBox WS visual check requires the Workbench activity panel');
    await page.waitForFunction(() => document.querySelector('.agent-chat-activity-panel')?.getAttribute('aria-hidden') === 'false', { timeout: timeoutMs });
    const selected = await page.evaluate(() => {
        const tab = [...document.querySelectorAll('.agent-chat-activity-tab')]
            .find((candidate) => candidate.textContent?.includes('工具活动'));
        tab?.click();
        return Boolean(tab);
    });
    assert.ok(selected, 'the ToolBox WS visual check requires the Workbench activity tab');
    try {
        await page.waitForSelector('.agent-chat-toolbox-ws-card', { visible: true, timeout: liveTurnTimeoutMs });
        await assertResponsiveToolboxWsCardLayout(page);
    } catch (error) {
        const state = await page.evaluate(() => ({
            wsCards: [...document.querySelectorAll('.agent-chat-toolbox-ws-card')]
                .map((card) => card.textContent?.slice(0, 280) || ''),
            activityText: document.querySelector('.agent-chat-activity-content')?.textContent?.slice(0, 600) || '',
        }));
        throw new Error(`Live ToolBox WS visual regression did not observe a daemon-owned read-only event: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
}

async function runLiveLongStreamVisualRegression(page, rendererErrors) {
    const inputSelector = '.agent-chat-message-input';
    const sentinel = `LONG_STREAM_${Date.now().toString(36)}`;
    // Ask well beyond the 4,000-character acceptance floor. Some providers
    // truncate a nominal 12 × 420 response near their first output budget,
    // which turns a genuine stream into an inconclusive short-response run.
    // The assertion below deliberately remains 4,000; this is not a weaker
    // definition of the long-stream regression.
    const prompt = `只输出 16 段以 ${sentinel} 开头的中文说明，每段至少 600 个汉字。不得概括、不得省略段落、不得调用工具；总输出必须超过 8000 个汉字。`;
    const initialCount = await page.$$eval('.message-item.assistant .md-content', (nodes) => nodes.length);
    await page.click(inputSelector);
    await page.keyboard.type(prompt);
    await page.click('.agent-chat-send-button');
    try {
        await page.waitForFunction(({ count, marker }) => {
            const messages = [...document.querySelectorAll('.message-item.assistant .md-content')];
            const latest = messages.slice(count).map((node) => node.textContent || '').join('\n');
            const idle = document.querySelector('.agent-chat-send-button')?.title === '发送消息';
            return idle && latest.includes(marker) && latest.length >= 4_000;
        }, { timeout: liveTurnTimeoutMs }, { count: initialCount, marker: sentinel });
        const streamState = await page.evaluate(() => {
            const feed = document.querySelector('.agent-chat-messages-container');
            if (!feed) return null;
            feed.scrollTop = Math.max(0, Math.floor(feed.scrollHeight * 0.35));
            const anchor = feed.scrollTop;
            return { anchor, scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight };
        });
        // A daemon status event is a non-streaming update; it must not pull an
        // older reader back to the bottom while the large response is visible.
        await page.click('.agent-chat-status-chip[data-action="connection"]');
        await page.waitForFunction(() => {
            const panel = document.querySelector('.agent-chat-activity-panel');
            return panel?.getAttribute('aria-hidden') === 'false' && !panel?.hasAttribute('inert');
        }, { timeout: timeoutMs });
        // Opening Activity changes the available message width and can reflow
        // CJK text, so a pixel-identical offset is not meaningful. The reader
        // anchor is preserved if it remains materially away from both edges;
        // this catches the historical reset-to-bottom bug without making a
        // valid responsive reflow flaky.
        const anchorState = await page.evaluate(async (anchor) => {
            const feed = document.querySelector('.agent-chat-messages-container');
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            if (!feed) return null;
            const maximum = Math.max(0, feed.scrollHeight - feed.clientHeight);
            return { anchor, scrollTop: feed.scrollTop, maximum };
        }, streamState?.anchor ?? 0);
        assert.ok(anchorState && anchorState.maximum > 0,
            `long-stream feed must remain scrollable after opening Activity: ${JSON.stringify(anchorState)}`);
        assert.ok(anchorState.scrollTop > 48 && anchorState.scrollTop < anchorState.maximum - 48,
            `opening Activity must preserve a readable, non-edge scroll anchor: ${JSON.stringify(anchorState)}`);
    } catch (error) {
        const state = await page.evaluate(() => ({
            responseLengths: [...document.querySelectorAll('.message-item.assistant .md-content')]
                .map((node) => (node.textContent || '').length),
            feed: (() => {
                const feed = document.querySelector('.agent-chat-messages-container');
                return feed ? { scrollTop: feed.scrollTop, scrollHeight: feed.scrollHeight, clientHeight: feed.clientHeight } : null;
            })(),
            latestAssistant: (() => {
                const content = [...document.querySelectorAll('.message-item.assistant .md-content')].at(-1);
                const row = content?.closest('.message-item');
                if (!content || !row) return null;
                const contentStyle = getComputedStyle(content);
                const rowStyle = getComputedStyle(row);
                const rect = row.getBoundingClientRect();
                return {
                    rowHeight: rect.height,
                    rowScrollHeight: row.scrollHeight,
                    contentHeight: content.getBoundingClientRect().height,
                    contentScrollHeight: content.scrollHeight,
                    rowContentVisibility: rowStyle.contentVisibility,
                    rowContain: rowStyle.contain,
                    contentOverflow: contentStyle.overflow,
                };
            })(),
        }));
        throw new Error(`Live long-stream visual regression did not preserve a readable scroll anchor: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.message}`);
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
    // Keep this aligned with the direct Rust tool contract.  The daemon's
    // test-only `tool_choice=required` hook enforces a native call on the
    // first model round; repeating a pseudo-schema in user text made some
    // providers answer about the schema rather than choose the actual tool.
    const prompt = '请务必调用 PowerShellExecutor 执行 Get-Location，不要用别的方法。';
    assert.ok(await page.$('.agent-chat-message-input'), 'high-risk GUI approval test requires the live Agent session');
    await page.click(inputSelector);
    await page.keyboard.type(prompt);
    await page.click('.agent-chat-send-button');
    try {
        // The tool lifecycle is daemon-owned. Once it has reached the local
        // gate, explicitly open the user-facing Activity → Approvals surface
        // before measuring the card. A preceding completed tool can leave the
        // panel collapsed, and a collapsed (but mounted) card is not visual
        // proof that a user can review or deny it.
        await page.waitForFunction(() => [...document.querySelectorAll('.agent-chat-tool-activity')]
            .some((card) => /PowerShellExecutor/i.test(card.textContent || '')
                && /awaiting_local_approval/i.test(card.dataset.status || card.textContent || '')),
        { timeout: liveTurnTimeoutMs });
        await page.evaluate(() => {
            const panel = document.querySelector('.agent-chat-activity-panel');
            if (panel?.getAttribute('aria-hidden') !== 'false') {
                document.querySelector('.agent-chat-status-chip[data-action="connection"]')?.click();
            }
        });
        await page.waitForFunction(() => document.querySelector('.agent-chat-activity-panel')?.getAttribute('aria-hidden') === 'false', { timeout: timeoutMs });
        const approvalsTab = await page.evaluate(() => {
            const tab = [...document.querySelectorAll('.agent-chat-activity-tab')]
                .find((candidate) => candidate.textContent?.includes('审批'));
            tab?.click();
            return Boolean(tab);
        });
        assert.ok(approvalsTab, 'a pending local approval must expose the Activity approvals tab');
        // The product assertion is the daemon-owned approval card.  A user
        // message block can be coalesced with the immediate native tool call
        // during a renderer frame, so using it as an intermediate timing gate
        // turns a valid approval into a flaky false failure.
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
        const localDenyOutcome = await page.evaluate(() => [...document.querySelectorAll('.agent-chat-tool-activity')]
            .filter((card) => /PowerShellExecutor/i.test(card.textContent || ''))
            .map((card) => card.dataset.status || card.querySelector('.agent-chat-tool-status-badge')?.textContent || ''));
        assert.equal(localDenyOutcome.some((state) => /running|started|completed|完成|success/i.test(state)), false,
            `a locally denied high-risk call must not render a started ToolBox card: ${JSON.stringify(localDenyOutcome)}`);
    } catch (error) {
        const state = await page.evaluate(() => ({
            approvals: [...document.querySelectorAll('.agent-chat-approval-card')].map((card) => card.textContent?.slice(0, 240) || ''),
            tools: [...document.querySelectorAll('.agent-chat-tool-activity')].map((card) => ({
                text: card.textContent?.slice(0, 240) || '',
                state: card.dataset.status || card.querySelector('.agent-chat-tool-status-badge')?.textContent || '',
            })),
            messages: [...document.querySelectorAll('.message-item')].slice(-4).map((message) => ({
                role: message.classList.contains('assistant') ? 'assistant' : message.classList.contains('user') ? 'user' : 'other',
                text: message.textContent?.slice(0, 240) || '',
            })),
            recovery: document.querySelector('.agent-chat-activity-connection')?.textContent || null,
        }));
        throw new Error(`Live high-risk GUI approval did not complete safely: ${JSON.stringify(state)}\n${rendererErrors.join('\n')}\n${error.stack || error.message}`);
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
            const button = card?.querySelector('.agent-chat-approval-actions button.secondary');
            button?.click();
            return Boolean(button);
        });
        assert.ok(allowed, 'the visible high-risk local approval card must expose an allow-once action');
        await page.waitForFunction(() => {
            const cards = [...document.querySelectorAll('.agent-chat-tool-activity')];
            const completed = cards.some((card) => {
                const title = card.querySelector('.agent-chat-tool-title')?.textContent || '';
                const state = card.querySelector('.agent-chat-tool-status-badge')?.textContent || card.dataset.status || '';
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
                    state: card.querySelector('.agent-chat-tool-status-badge')?.textContent || card.dataset.status || '',
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
let previewTopics;
let exitCode = 0;
try {
    await recordSmokeResult('running', 'bootstrap');
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
    previewTopics = [
        durableWorkbenchTopic,
        ...await Promise.all(Array.from({ length: 9 }, (_, index) => seedDurableWorkbenchTopic(appData, index + 1))),
    ];
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
        // VCPCHAT_APP_DATA_DIR isolates shared settings/Topics, but Chromium
        // localStorage lives under Electron's userData profile. Keep that
        // profile isolated too, otherwise a previous smoke's lastTopic pointer
        // can legitimately auto-resume this run's fixture before its explicit
        // open-flow assertion.
        `--user-data-dir=${path.join(appData, 'electron-profile')}`,
        `--remote-debugging-port=${port}`,
    ], {
        cwd: root,
        env: environment,
        stdio: ['ignore', 'ignore', 'pipe'],
        // A smoke Electron child must not share the invoking terminal's
        // visible console job. On Windows, closing that child can otherwise
        // terminate the caller before it reports the assertion outcome.
        windowsHide: true
    });
    child.stderr.on('data', chunk => {
        stderr.value = `${stderr.value}${chunk}`.slice(-8_000);
    });

    await waitForDebugger(port, child, stderr);
    // The VCPChat renderer can be legitimately busy restoring the Next shell
    // and an isolated Rust checkpoint at the same time. Keep Puppeteer's CDP
    // transport alive longer than an individual UI assertion so a slow first
    // paint reports the actual selector/state failure instead of a generic
    // protocol timeout.
    browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${port}`,
        protocolTimeout: Math.max(timeoutMs * 4, liveTurnTimeoutMs + 30_000),
    });
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
    await recordSmokeResult('running', 'main-chat-ready');
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
    // Submit the production form without changing the seeded isolated endpoint.
    // The daemon later consumes that exact setting for its readiness probe;
    // modifying it here adds no coverage and can invalidate the runtime fixture.
    await page.click('.settings-nav-item[data-section="server-connection"]');
    await page.waitForFunction(() => document.getElementById('section-server-connection')?.classList.contains('active'), { timeout: timeoutMs });
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
    // Opening the launcher can redraw when the daemon emits readiness. Click
    // the current document rather than keeping Puppeteer's ElementHandle
    // across that independently scheduled renderer update.
    assert.equal(await page.evaluate(() => {
        const item = document.querySelector('.next-ui-internal-app-item[title="VCP Agent"]');
        item?.click();
        return Boolean(item);
    }), true, 'the Agent launchpad item must remain actionable during daemon startup');
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    await page.waitForSelector('.next-ui-tab[data-view-id="app:agent-workbench"]', { visible: true, timeout: timeoutMs });
    await recordSmokeResult('running', 'workbench-mounted');
    await assertResponsiveWorkbench(page);
    await assertWorkbenchSidebarTabs(page);
    // R4: readiness is emitted by Rust and only projected by the Renderer.
    // The fixture intentionally uses an unused loopback port unless an
    // explicitly opt-in live ToolBox run supplied an isolated real endpoint.
    // Either result is daemon-owned: the Workbench itself never probes it.
    // Runtime readiness can redraw the header between Puppeteer resolving the
    // selector and issuing its synthetic pointer event.  Click in the current
    // document instead of retaining a detached ElementHandle across that
    // daemon-authored render.
    const openedConnection = await page.evaluate(() => {
        const trigger = document.querySelector('.agent-chat-status-chip[data-action="connection"]');
        trigger?.click();
        return Boolean(trigger);
    });
    assert.ok(openedConnection, 'Workbench must expose a connection-status trigger');
    await page.waitForFunction(() => document.querySelectorAll('.agent-chat-readiness-card').length === 4, { timeout: timeoutMs });
    await recordSmokeResult('running', 'readiness-cards-mounted');
    try {
        await page.waitForFunction((expectReady) => {
            const toolbox = document.querySelector('[data-readiness="toolbox"]');
            const text = toolbox?.textContent || '';
            // Rust reports the canonical success state as “就绪”; older
            // wording used “可用”.  Both are daemon-owned ready states, while
            // “不可用” is explicitly distinct and must never satisfy this
            // branch through substring matching.
            return Boolean(toolbox && (expectReady
                ? /(?:就绪|可用)/.test(text) && !/不可用/.test(text)
                : /不可用/.test(text)));
        }, { timeout: timeoutMs }, liveToolBox);
    } catch (error) {
        const readiness = await page.evaluate(() => ({
            cards: [...document.querySelectorAll('.agent-chat-readiness-card')].map((card) => ({
                key: card.dataset.readiness || '',
                text: card.textContent || '',
            })),
        }));
        throw new Error(`daemon-owned ToolBox readiness did not settle to unavailable: ${JSON.stringify(readiness)}\n${error.message}`);
    }
    await assertResponsiveReadinessLayout(page);
    await page.click('.agent-chat-activity-close');
    await page.waitForFunction(() => document.querySelector('.agent-chat-activity-panel')?.getAttribute('aria-hidden') === 'true', { timeout: timeoutMs });

    // The Agent sidebar is a projection of the same VCPChat assistant
    // catalog.  It must use the same create/search affordances as the main
    // sidebar and, crucially, an inactive Topic-flow layer may not intercept
    // those clicks.
    const agentSidebar = '#nextUiInternalAppHost .agent-chat-sidebar';
    await page.waitForSelector(`${agentSidebar} .next-ui-create-item-trigger`, { visible: true, timeout: timeoutMs });
    await page.waitForSelector(`${agentSidebar} .next-ui-agent-search-trigger`, { visible: true, timeout: timeoutMs });
    const sidebarHitTest = await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        const box = button?.getBoundingClientRect();
        const target = box && document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
            hidden: document.querySelector('.agent-chat-topic-flow-layer')?.hidden === true,
            hitCreate: Boolean(button && target && (target === button || button.contains(target))),
        };
    }, `${agentSidebar} .next-ui-create-item-trigger`);
    assert.deepEqual(sidebarHitTest, { hidden: true, hitCreate: true },
        'an inactive Topic flow must not cover or absorb clicks from Agent sidebar controls');
    await page.click(`${agentSidebar} .next-ui-agent-search-trigger`);
    await page.waitForSelector(`${agentSidebar} .agents-header.is-searching .topic-search-input`, { visible: true, timeout: timeoutMs });
    await page.click(`${agentSidebar} .next-ui-agent-search-close`);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains('is-searching'), { timeout: timeoutMs }, `${agentSidebar} .agents-header`);
    await page.click(`${agentSidebar} .next-ui-create-item-trigger`);
    // The host deliberately has zero layout height: its fixed overlay is the
    // visible surface.  Assert the actual dialog instead of making Puppeteer
    // mistake the zero-height positioning wrapper for a failed interaction.
    await page.waitForSelector('.next-ui-create-dialog-host .vcp-ui-modal', { visible: true, timeout: timeoutMs });
    await page.waitForFunction(() => document.querySelector('.next-ui-create-dialog-host')?.textContent?.includes('创建助手或群组'), { timeout: timeoutMs });
    const dismissedCreate = await page.evaluate(() => {
        const host = document.querySelector('.next-ui-create-dialog-host');
        const button = [...(host?.querySelectorAll('button') || [])].find((candidate) => candidate.textContent?.trim() === '取消');
        button?.click();
        return Boolean(button);
    });
    assert.ok(dismissedCreate, 'Agent assistant create control must invoke the shared main-chat create dialog');
    await page.waitForSelector('.next-ui-create-dialog-host .vcp-ui-modal', { hidden: true, timeout: timeoutMs });

    // Agent sessions use the same three-control Topic toolbar as main chat:
    // new, manage, and expandable search. These controls must not fall back
    // to an always-visible, narrower custom input.
    await page.evaluate(() => {
        const tab = [...document.querySelectorAll('.agent-chat-sidebar .sidebar-tab-button')]
            .find((candidate) => candidate.textContent.trim() === '会话');
        tab?.click();
    });
    await page.waitForSelector(`${agentSidebar} .next-ui-create-topic-trigger`, { visible: true, timeout: timeoutMs });
    await page.waitForSelector(`${agentSidebar} .next-ui-topic-icon-trigger[aria-label="管理会话"]`, { visible: true, timeout: timeoutMs });
    await page.waitForSelector(`${agentSidebar} .next-ui-topic-icon-trigger[aria-label="搜索会话"]`, { visible: true, timeout: timeoutMs });
    await page.click(`${agentSidebar} .next-ui-topic-icon-trigger[aria-label="管理会话"]`);
    await page.waitForSelector(`${agentSidebar} .agent-chat-sidebar-content.is-managing .agent-chat-topic-manage-panel`, { visible: true, timeout: timeoutMs });
    await page.click(`${agentSidebar} .agent-chat-topic-manage-panel [aria-label="退出会话管理"]`);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains('is-managing'), { timeout: timeoutMs }, `${agentSidebar} .agent-chat-sidebar-content`);
    await page.click(`${agentSidebar} .next-ui-topic-icon-trigger[aria-label="搜索会话"]`);
    await page.waitForSelector(`${agentSidebar} .topics-header-container.is-searching .topic-search-input`, { visible: true, timeout: timeoutMs });
    await page.click(`${agentSidebar} .topics-header-container .next-ui-topic-search-close`);
    await page.waitForFunction((selector) => !document.querySelector(selector)?.classList.contains('is-searching'), { timeout: timeoutMs }, `${agentSidebar} .topics-header-container`);

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
    const durableTopicLease = await page.evaluate(async (topicId) => {
        const api = window.chatAPI || window.electronAPI;
        const topics = await api.agentRuntimeListTopics({ agentId: 'Nova' });
        const topic = (Array.isArray(topics) ? topics : topics?.topics || [])
            .find((candidate) => candidate?.id === topicId);
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`);
        return {
            daemonInUse: topic?.inUse,
            daemonReadOnly: topic?.readOnly,
            rowClass: row?.className || null,
            rowText: row?.textContent || null,
        };
    }, durableWorkbenchTopic.topicId);
    assert.equal(durableTopicLease.daemonInUse, false,
        `a read-only control daemon must not claim the durable Topic lease: ${JSON.stringify(durableTopicLease)}`);
    assert.equal(durableTopicLease.daemonReadOnly, false,
        `a free Topic must remain writable after control-plane reads: ${JSON.stringify(durableTopicLease)}`);
    // Topic actions are a Workbench-local context menu: the Rust daemon still
    // owns every mutation, but the fixed body-level popover must work both
    // from the three-dot affordance and from a native-looking right click.
    const durableTopicSelector = `.agent-chat-persisted-topic[data-topic-id="${durableWorkbenchTopic.topicId}"]`;
    // A control-plane refresh may replace Topic rows between Puppeteer's
    // hover and click. Resolve the trigger from the current renderer frame;
    // the right-click branch below still validates a physical pointer path.
    assert.equal(await page.evaluate((selector) => {
        const trigger = document.querySelector(`${selector} .agent-chat-session-menu`);
        trigger?.click();
        return Boolean(trigger);
    }, durableTopicSelector), true, 'the current Topic row must expose an actionable three-dot trigger');
    await page.waitForSelector('.agent-chat-topic-context-menu', { visible: true, timeout: timeoutMs });
    const threeDotMenu = await page.evaluate(() => {
        const menu = document.querySelector('.agent-chat-topic-context-menu');
        const trigger = document.querySelector('.agent-chat-persisted-topic .agent-chat-session-menu');
        const deleteItem = menu?.querySelector('.context-menu-item.danger-item');
        const rect = menu?.getBoundingClientRect();
        return {
            parentIsBody: menu?.parentElement === document.body,
            role: menu?.getAttribute('role'),
            labels: [...(menu?.querySelectorAll('[role="menuitem"]') || [])].map((item) => item.textContent?.trim()),
            usesMainMenuClass: menu?.classList.contains('context-menu') || false,
            itemIcons: menu?.querySelectorAll('.context-menu-item > i.fas').length || 0,
            triggerUsesSvg: Boolean(trigger?.querySelector('svg')),
            triggerUsesTextIcon: Boolean(trigger?.querySelector('.vcp-ui-icon')),
            deleteUsesMainDangerClass: deleteItem?.classList.contains('danger-item') || false,
            rect: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
            width: window.innerWidth,
            height: window.innerHeight,
        };
    });
    assert.equal(threeDotMenu.parentIsBody, true, 'the Topic menu must not be clipped by the sidebar scroll container');
    assert.equal(threeDotMenu.role, 'menu', 'the Topic action popover must expose a menu role');
    assert.ok(threeDotMenu.labels.includes('重命名') && threeDotMenu.labels.some((label) => label.includes('删除')),
        `a free Topic must expose Rust-backed rename/delete actions: ${JSON.stringify(threeDotMenu)}`);
    assert.ok(threeDotMenu.usesMainMenuClass && threeDotMenu.itemIcons >= 4,
        `Topic actions must reuse the main-chat context-menu primitive and icon hierarchy: ${JSON.stringify(threeDotMenu)}`);
    assert.deepEqual({ triggerUsesSvg: threeDotMenu.triggerUsesSvg, triggerUsesTextIcon: threeDotMenu.triggerUsesTextIcon },
        { triggerUsesSvg: true, triggerUsesTextIcon: false },
        `the Topic three-dot trigger must not degrade to an unloaded icon-font dash: ${JSON.stringify(threeDotMenu)}`);
    assert.equal(threeDotMenu.deleteUsesMainDangerClass, true,
        `the destructive Topic action must use the main-chat danger-item contract: ${JSON.stringify(threeDotMenu)}`);
    assert.ok(threeDotMenu.rect.left >= 0 && threeDotMenu.rect.top >= 0
        && threeDotMenu.rect.right <= threeDotMenu.width && threeDotMenu.rect.bottom <= threeDotMenu.height,
    `the Topic action menu must remain inside the Electron viewport: ${JSON.stringify(threeDotMenu)}`);
    if (process.env.VCPCHAT_E2E_SCREENSHOT_PATH) {
        await page.screenshot({ path: process.env.VCPCHAT_E2E_SCREENSHOT_PATH, fullPage: false });
    }
    await page.keyboard.press('Escape');
    await page.waitForSelector('.agent-chat-topic-context-menu', { hidden: true, timeout: timeoutMs });
    await page.click(durableTopicSelector, { button: 'right' });
    await page.waitForSelector('.agent-chat-topic-context-menu', { visible: true, timeout: timeoutMs });
    const rightClickMenu = await page.$$eval('.agent-chat-topic-context-menu [role="menuitem"]', (items) => items.map((item) => item.textContent?.trim()));
    assert.ok(rightClickMenu.includes('打开会话') && rightClickMenu.includes('复制 Topic ID'),
        `right-click must open the same Topic context menu: ${JSON.stringify(rightClickMenu)}`);
    const legacyTopicDecorations = await page.evaluate((selector) => {
        const row = document.querySelector(selector);
        const count = row?.querySelector('.message-count');
        return {
            rowBefore: row ? getComputedStyle(row, '::before').display : null,
            rowAfter: row ? getComputedStyle(row, '::after').display : null,
            countAfter: count ? getComputedStyle(count, '::after').display : null,
            emptyCountDisplay: count?.textContent?.trim() === '' ? getComputedStyle(count).display : null,
        };
    }, durableTopicSelector);
    assert.equal(legacyTopicDecorations.rowBefore, 'none',
        `Agent Topic rows must not inherit a legacy leading glass-line: ${JSON.stringify(legacyTopicDecorations)}`);
    assert.equal(legacyTopicDecorations.rowAfter, 'none',
        `Agent Topic rows must not inherit a legacy trailing glass-line: ${JSON.stringify(legacyTopicDecorations)}`);
    // The Rust Topic projection no longer renders the legacy message-count
    // decoration. If an older row shape supplies one, it must remain hidden.
    assert.ok(
        legacyTopicDecorations.countAfter === null
            || (legacyTopicDecorations.countAfter === 'none' && legacyTopicDecorations.emptyCountDisplay === 'none'),
        `Agent Topic rows must not expose the legacy message-count decoration: ${JSON.stringify(legacyTopicDecorations)}`
    );
    await page.keyboard.press('Escape');
    const attachmentBeforePreview = await page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status?.attachment?.topicId || null;
    });
    const openedDurableTopic = await page.evaluate((topicId) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`);
        row?.click();
        return Boolean(row);
    }, durableWorkbenchTopic.topicId);
    assert.ok(openedDurableTopic, 'a durable Rust Topic row must remain actionable while control-plane refreshes redraw the sidebar');
    await page.waitForFunction((text) => [...document.querySelectorAll('.message-item.assistant .md-content')]
        .some((node) => node.textContent.includes(text)), { timeout: timeoutMs }, durableWorkbenchTopic.assistantText);
    const previewState = await page.evaluate(async (topicId) => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`);
        const composer = document.querySelector('.agent-chat-message-input');
        return {
            attachmentTopicId: status?.attachment?.topicId || null,
            selected: row?.classList.contains('active') || false,
            composerDisabled: composer?.disabled ?? true,
            topicFlowOpen: Boolean(document.querySelector('.agent-chat-topic-flow-dialog')),
        };
    }, durableWorkbenchTopic.topicId);
    assert.equal(previewState.attachmentTopicId, attachmentBeforePreview,
        `clicking a Topic must only read its Rust snapshot; attachment changes only when sending: ${JSON.stringify(previewState)}`);
    assert.equal(previewState.selected, true,
        `the clicked Topic row must update in place as the current preview: ${JSON.stringify(previewState)}`);
    assert.equal(previewState.composerDisabled, false,
        `an idle snapshot preview must keep its composer ready for send-time attachment: ${JSON.stringify(previewState)}`);
    assert.equal(previewState.topicFlowOpen, false,
        `opening a free Topic must not force an attachment or takeover dialog: ${JSON.stringify(previewState)}`);
    const previewDaemonPid = await page.evaluate(async () => {
        const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
        return status?.worker?.pid || null;
    });
    assert.ok(Number.isSafeInteger(previewDaemonPid) && previewDaemonPid > 0,
        'Topic preview must keep a single live Rust control daemon');
    for (const topic of previewTopics.slice(1)) {
        const clicked = await page.evaluate((topicId) => {
            const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`);
            row?.click();
            return Boolean(row);
        }, topic.topicId);
        assert.ok(clicked, `preview Topic ${topic.topicId} must remain selectable without a sidebar rebuild`);
        await page.waitForFunction((text) => [...document.querySelectorAll('.message-item.assistant .md-content')]
            .some((node) => node.textContent.includes(text)), { timeout: timeoutMs }, topic.assistantText);
        const switchState = await page.evaluate(async () => {
            const status = await (window.chatAPI || window.electronAPI).agentRuntimeGetStatus();
            return { pid: status?.worker?.pid || null, attachmentTopicId: status?.attachment?.topicId || null };
        });
        assert.equal(switchState.pid, previewDaemonPid,
            `preview Topic ${topic.topicId} must not respawn the Rust daemon`);
        assert.equal(switchState.attachmentTopicId, attachmentBeforePreview,
            `preview Topic ${topic.topicId} must not acquire a writable attachment before send`);
    }
    // Restore the original snapshot so the existing reload assertion also
    // proves the localStorage pointer is only a Topic ID, never a transcript.
    assert.equal(await page.evaluate((topicId) => {
        const row = document.querySelector(`.agent-chat-persisted-topic[data-topic-id="${topicId}"]`);
        row?.click();
        return Boolean(row);
    }, durableWorkbenchTopic.topicId), true, 'the first preview Topic must remain selectable after rapid sibling previews');
    await page.waitForFunction((text) => [...document.querySelectorAll('.message-item.assistant .md-content')]
        .some((node) => node.textContent.includes(text)), { timeout: timeoutMs }, durableWorkbenchTopic.assistantText);
    // v1.7: two Topics may have independent Rust Hosts in one daemon. This
    // uses the real preload/Main bridge, then returns the Workbench to a
    // snapshot preview without creating a model request.
    const concurrentRuntime = await page.evaluate(async ({ firstTopicId, secondTopicId }) => {
        const api = window.chatAPI || window.electronAPI;
        const first = await api.agentRuntimeCreateSession({ resume: firstTopicId, agent: 'Nova' });
        const second = await api.agentRuntimeCreateSession({ resume: secondTopicId, agent: 'Nova' });
        const status = await api.agentRuntimeGetStatus();
        await api.agentRuntimeCloseSession({ sessionId: first.sessionId });
        await api.agentRuntimeCloseSession({ sessionId: second.sessionId });
        return { first, second, status };
    }, { firstTopicId: durableWorkbenchTopic.topicId, secondTopicId: previewTopics[1].topicId });
    assert.notEqual(concurrentRuntime.first.sessionId, concurrentRuntime.second.sessionId,
        'two concurrent Topic Hosts must have distinct Rust session identities');
    assert.equal(concurrentRuntime.first.topicId, durableWorkbenchTopic.topicId);
    assert.equal(concurrentRuntime.second.topicId, previewTopics[1].topicId);
    assert.equal(concurrentRuntime.status?.runtimes?.filter((runtime) => (
        runtime.topicId === durableWorkbenchTopic.topicId || runtime.topicId === previewTopics[1].topicId
    )).length, 2, 'Electron must observe two resident Topic runtimes through one daemon manager');
    assert.equal(concurrentRuntime.status?.worker?.pid, previewDaemonPid,
        'creating a second Topic Host must not replace the daemon process');
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
    try {
        await page.waitForSelector('.agent-chat-usage-budget', { visible: true, timeout: timeoutMs });
    } catch (error) {
        const usageState = await page.evaluate(() => {
            const panel = document.querySelector('.agent-chat-activity-panel');
            const toggle = document.querySelector('.agent-chat-usage-toggle');
            const activeTab = document.querySelector('.agent-chat-activity-tab.is-active');
            return {
                panelClass: panel?.className || null,
                panelHidden: panel?.getAttribute('aria-hidden') || null,
                panelInert: panel?.hasAttribute('inert') || false,
                toggleExpanded: toggle?.getAttribute('aria-expanded') || null,
                activeTab: activeTab?.dataset.tab || null,
                hasUsageNode: Boolean(document.querySelector('.agent-chat-usage-budget')),
                tabs: [...document.querySelectorAll('.agent-chat-activity-tab')].map(tab => ({
                    id: tab.dataset.tab,
                    selected: tab.getAttribute('aria-selected'),
                })),
            };
        });
        throw new Error(`Agent Workbench usage action did not project its activity panel: ${JSON.stringify(usageState)}\n${rendererErrors.join('\n')}\n${error.message}`);
    }
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
    await page.waitForFunction(() => {
        const panel = document.querySelector('.agent-chat-activity-panel');
        return panel?.getAttribute('aria-hidden') === 'true' && panel?.hasAttribute('inert');
    }, { timeout: timeoutMs });

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
        const dialog = document.querySelector('.agent-chat-topic-flow-dialog');
        return Boolean(dialog && /共享 Agent/.test(dialog.textContent || '') && /共享模型/.test(dialog.textContent || '') && /工作目录/.test(dialog.textContent || ''));
    }, { timeout: timeoutMs });
    await assertResponsiveTopicFlow(page, '创建并打开');
    await confirmTopicFlow(page, '创建并打开');
    await page.waitForFunction(() => {
        const input = document.querySelector('.agent-chat-message-input');
        return Boolean(input && !input.disabled);
    }, { timeout: timeoutMs });
    await assertResponsiveLongMessageLayout(page);
    await recordSmokeResult('running', 'topic-created');
    if (liveToolBox) {
        await recordSmokeResult('running', 'live-toolbox');
        if (!skipLiveFileOperator) await runLiveToolBoxTurn(page, rendererErrors);
        if (liveToolBoxWs) await runLiveToolBoxWsVisualRegression(page, rendererErrors);
        if (liveLongStream) await runLiveLongStreamVisualRegression(page, rendererErrors);
        if (liveGuiCompaction) await runLiveGuiCompaction(page, compactionTopic, rendererErrors);
        if (liveRendererReload) await runLiveRendererReload(page, rendererErrors);
        if (liveHighRiskApproval) await runLiveHighRiskApproval(page, rendererErrors);
        if (liveBackendYolo) await runLiveBackendYolo(page, rendererErrors);
        if (liveCancellation) await runLiveCancellation(page, rendererErrors);
    }
    if (!skipCrashRecovery) {
        await recordSmokeResult('running', 'crash-recovery');
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
            'manual recovery must spawn a fresh daemon transport instead of reviving the crashed process');
    }
    await page.click('.next-ui-tab[data-view-id="app:agent-workbench"] .next-ui-tab-close');
    await page.waitForFunction(() => !document.querySelector('#nextUiInternalAppHost .agent-workbench-root'), { timeout: timeoutMs });

    await recordSmokeResult('passed');
    console.log(`Electron GUI smoke passed: renderer boot, main-chat Nova selection/topic/composer, global settings save, Next UI reload, daemon-owned readiness projection, budget readback,${liveToolBox && !skipLiveFileOperator ? ' opt-in live ToolBox FileOperator turn,' : ''}${liveToolBoxWs ? ' opt-in live ToolBox WS visual regression,' : ''}${liveLongStream ? ' opt-in live long-stream scroll-anchor regression,' : ''}${liveGuiCompaction ? ' opt-in live GUI compaction,' : ''}${liveRendererReload ? ' opt-in Agent renderer reload,' : ''}${liveHighRiskApproval ? ' opt-in denied PowerShell approval,' : ''}${liveBackendYolo ? ' opt-in allowed PowerShell backend-YOLO,' : ''}${liveCancellation ? ' opt-in cancellation,' : ''}${skipCrashRecovery ? ' crash/reconnect skipped by explicit diagnostic flag.' : ' and explicit Rust daemon crash recovery.'}`);
} catch (error) {
    exitCode = 1;
    // Electron can close its remote-debugging endpoint during cleanup. Emit the
    // actual assertion before that happens so a live UI regression is never
    // mistaken for a silent, successful smoke exit.
    await recordSmokeResult('failed', smokePhase, error?.message || error);
    console.error(`Electron GUI smoke failed: ${error?.stack || error}`);
} finally {
    // CDP Browser.close is an Electron-aware graceful shutdown. It avoids a
    // Windows process-tree kill that could take the Node test runner with it.
    if (browser) {
        const closed = await Promise.race([
            browser.close().then(() => true).catch(() => false),
            sleep(8_000).then(() => false),
        ]);
        // `Browser.close()` asks Electron to quit but Puppeteer's CDP socket
        // can still keep Node's event loop alive on Windows. Disconnect in
        // both outcomes; it is idempotent and never changes product state.
        browser.disconnect();
    }
    await terminate(child);
    await removeTemporaryAppData(appData);
}

// This executable only owns the isolated Electron child above.  Explicitly
// terminate the test runner after cleanup because an orphaned Puppeteer CDP
// socket otherwise keeps Windows CI alive after a result receipt was written.
process.exit(exitCode);
