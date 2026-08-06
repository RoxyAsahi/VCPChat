import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
const fixture = path.join(root, 'scripts', 'fixtures', 'fake-codex-app-server.mjs');
const timeoutMs = 45_000;
const startupTimeoutMs = 90_000;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function withTimeout(promise, label, milliseconds = timeoutMs) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
        }),
    ]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate, message, milliseconds = timeoutMs) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
        try {
            const value = await withTimeout(predicate(), message, Math.min(5_000, deadline - Date.now()));
            if (value) return value;
        } catch {}
        await sleep(100);
    }
    throw new Error(message);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { body += chunk; });
            response.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
            });
        });
        request.setTimeout(5_000, () => request.destroy(new Error(`HTTP request timed out: ${url}`)));
        request.on('error', reject);
    });
}

async function launchElectron(appData, launcherPath, statePath) {
    const port = await freePort();
    const output = { value: '' };
    const child = spawn(electron, [
        `--user-data-dir=${appData}`,
        `--remote-debugging-port=${port}`,
        '--enable-logging=stderr',
        '.',
        '--allow-multiple-instances',
    ], {
        cwd: root,
        env: {
            ...process.env,
            VCPCHAT_APP_DATA_DIR: appData,
            VCPCHAT_E2E_TEST: '1',
            VCP_CODEX_APP_SERVER: launcherPath,
            VCP_FAKE_CODEX_STATE: statePath,
            VCP_FAKE_CODEX_OMIT_TOOLS_ON_READ: '1',
            VCP_FAKE_CODEX_OMIT_REASONING_ON_READ: '1',
            VCP_FAKE_CODEX_REWRITE_ITEMS_ON_READ: '1',
            VCP_FAKE_CODEX_AUTO_COMPLETE_TURNS: '1',
            VCP_FAKE_CODEX_TOOL_BURST_ON_PROMPT: 'cold reopen burst',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const capture = (chunk) => { output.value = `${output.value}${chunk}`.slice(-24_000); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    await waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Electron exited during startup: ${output.value}`);
        try { await requestJson(`http://127.0.0.1:${port}/json/version`); return true; } catch { return false; }
    }, `Electron debugger did not start: ${output.value}`, startupTimeoutMs);
    const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
    const page = await waitFor(async () => (
        (await browser.pages()).find((candidate) => candidate.url().includes('main.html')) || null
    ), `Electron renderer did not appear: ${output.value}`, startupTimeoutMs);
    await waitFor(() => page.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true'),
        `Electron renderer did not become ready: ${output.value}`, startupTimeoutMs);
    return {
        child,
        browser,
        page,
        async close() {
            await browser.close().catch(() => null);
            browser.disconnect();
            if (child.exitCode === null) child.kill();
            await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(5_000)]).catch(() => null);
        },
    };
}

async function openAgentWorkbench(page) {
    await page.waitForFunction(() => Boolean(window.nextUiApps?.get?.('agent-workbench')), { timeout: timeoutMs });
    if (await page.$('#nextUiInternalAppHost .agent-workbench-root')) return;
    await page.click('#nextUiAddTabBtn');
    await page.waitForSelector('.next-ui-internal-app-item[title="VCPBUILD"]', { visible: true, timeout: timeoutMs });
    await page.evaluate(() => document.querySelector('.next-ui-internal-app-item[title="VCPBUILD"]')?.click());
    await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
}

async function selectNova(page) {
    await page.waitForFunction(() => [...document.querySelectorAll('#nextUiInternalAppHost .sidebar-tab-button')]
        .some((tab) => tab.textContent?.trim() === '助手'), { timeout: timeoutMs });
    await page.evaluate(() => [...document.querySelectorAll('#nextUiInternalAppHost .sidebar-tab-button')]
        .find((tab) => tab.textContent?.trim() === '助手')?.click());
    await page.waitForFunction(() => [...document.querySelectorAll('#nextUiInternalAppHost .agent-chat-agent-row')]
        .some((row) => row.querySelector('.agent-name')?.textContent?.trim() === 'Nova'), { timeout: timeoutMs });
    await page.evaluate(() => [...document.querySelectorAll('#nextUiInternalAppHost .agent-chat-agent-row')]
        .find((row) => row.querySelector('.agent-name')?.textContent?.trim() === 'Nova')?.click());
}

async function selectSessionTimeline(page, sessionId, marker = 'assistant-result:cold reopen') {
    await waitFor(async () => page.evaluate((id, expectedMarker) => {
        const rows = [...document.querySelectorAll(
            '#nextUiInternalAppHost .agent-chat-session-row[data-session-id]',
        )];
        const row = rows.find((candidate) => candidate.dataset.sessionId === id);
        const active = document.querySelector(
            '#nextUiInternalAppHost .agent-chat-session-row.active[data-session-id]',
        );
        const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages');
        if (active?.dataset.sessionId === id && feed?.textContent?.includes(expectedMarker)) return true;
        row?.click();
        return false;
    }, sessionId, marker), `Session ${sessionId} did not render`);
    return page.evaluate(async (id) => {
        const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages');
        const snapshot = await (window.chatAPI || window.electronAPI).agentSessionRead({ sessionId: id });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return {
            kinds: [...(feed?.querySelectorAll('[data-agent-timeline-kind]') || [])]
                .map((row) => row.dataset.agentTimelineKind),
            ids: [...(feed?.querySelectorAll('[data-agent-timeline-key]') || [])]
                .map((row) => row.dataset.agentTimelineKey),
            toolCount: feed?.querySelectorAll('.agent-chat-tool-activity').length || 0,
            feedText: feed?.textContent || '',
            snapshot: (snapshot?.messages || []).map((message) => ({
                messageId: message.messageId, turnId: message.turnId, role: message.role,
                sourceOrder: message.sourceOrder, blocks: (message.blocks || []).map((block) => block.kind),
            })),
        };
    }, sessionId);
}

function assertToolIsInsideTurn(timeline, label, prompts) {
    assert.ok(timeline.toolCount >= 1, `${label} must render the ToolBox card`);
    const byTurn = new Map();
    for (const message of timeline.snapshot) {
        const entries = byTurn.get(message.turnId) || [];
        entries.push(message);
        byTurn.set(message.turnId, entries);
    }
    assert.equal(byTurn.size, prompts.length, `${label} must retain every Turn`);
    for (const [turnId, entries] of byTurn) {
        const kinds = entries.map((message) => message.blocks[0]);
        assert.deepEqual(kinds, ['message', 'reasoning', 'tool', 'message'],
            `${label} must keep tool ${turnId} between its Turn reasoning and assistant continuation`);
    }
    const markers = prompts.flatMap((prompt) => [
        prompt,
        `reasoning-summary:${prompt}`,
        'FileOperator',
        `assistant-result:${prompt}`,
    ]);
    let cursor = -1;
    for (const marker of markers) {
        const next = timeline.feedText.indexOf(marker, cursor + 1);
        assert.ok(next > cursor, `${label} must render ${marker} in Turn-local visual order`);
        cursor = next;
    }
}

function assertBurstToolPlacement(timeline, label) {
    const expectedSnapshotKinds = [
        'message', 'reasoning', 'message',
        'tool', 'tool', 'tool', 'message',
        'tool', 'message',
        'tool', 'tool', 'message',
        'tool', 'tool', 'tool', 'message',
        'tool', 'tool', 'message',
    ];
    assert.equal(timeline.toolCount, 11, `${label} must render every tool card`);
    assert.deepEqual(timeline.snapshot.map((message) => message.blocks[0]), expectedSnapshotKinds,
        `${label} must retain all five tool batches between their original assistant continuations`);
    assert.deepEqual(timeline.kinds, [
        'message', 'message', 'message', 'tool-group', 'message', 'tool', 'message',
        'tool-group', 'message', 'tool-group', 'message', 'tool-group', 'message',
    ], `${label} must render the five batches at their durable timeline positions`);
    const markers = [
        'reasoning-summary:cold reopen burst',
        'assistant-part-1:cold reopen burst', 'FileOperator',
        'assistant-part-2:cold reopen burst', 'FileOperator',
        'assistant-part-3:cold reopen burst', 'FileOperator',
        'assistant-part-4:cold reopen burst', 'FileOperator',
        'assistant-part-5:cold reopen burst', 'FileOperator',
        'assistant-part-6:cold reopen burst',
    ];
    let cursor = -1;
    for (const marker of markers) {
        const next = timeline.feedText.indexOf(marker, cursor + 1);
        assert.ok(next > cursor, `${label} must render ${marker} after the preceding timeline batch`);
        cursor = next;
    }
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-codex-cold-reopen-'));
const statePath = path.join(appData, 'fake-codex-state.json');
const launcherPath = path.join(appData, process.platform === 'win32' ? 'codex-app-server.cmd' : 'codex-app-server');
if (process.platform === 'win32') {
    await fs.writeFile(launcherPath, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
} else {
    await fs.writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
}
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next',
    enableDistributedServer: false,
    ChatDataServiceEnabled: false,
    agentRuntime: { codex: { executable: launcherPath, model: 'fixture-model' } },
}), 'utf8');

let first;
let second;
try {
    first = await launchElectron(appData, launcherPath, statePath);
    const seeded = await withTimeout(first.page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        api.agentRuntimeSetWorkbenchPresence(true);
        const session = await api.agentSessionCreate({ agentId: 'Nova', title: 'Cold reopen' });
        await api.agentRuntimeEnsureSessionRuntime({ sessionId: session.sessionId });
        await api.agentRuntimeStartTurn({ sessionId: session.sessionId, prompt: 'cold reopen first' });
        await new Promise((resolve) => setTimeout(resolve, 250));
        await api.agentRuntimeStartTurn({ sessionId: session.sessionId, prompt: 'cold reopen second' });
        await new Promise((resolve) => setTimeout(resolve, 250));
        await api.agentSessionRead({ sessionId: session.sessionId });
        const burstSession = await api.agentSessionCreate({ agentId: 'Nova', title: 'Cold reopen burst' });
        await api.agentRuntimeEnsureSessionRuntime({ sessionId: burstSession.sessionId });
        await api.agentRuntimeStartTurn({ sessionId: burstSession.sessionId, prompt: 'cold reopen burst' });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await api.agentSessionRead({ sessionId: burstSession.sessionId });
        return { sessionId: session.sessionId, burstSessionId: burstSession.sessionId };
    }), 'seed and reconcile cold-reopen Session');
    await openAgentWorkbench(first.page);
    await selectNova(first.page);
    const beforeClose = await selectSessionTimeline(first.page, seeded.sessionId);
    const prompts = ['cold reopen first', 'cold reopen second'];
    assertToolIsInsideTurn(beforeClose, 'live reconciled timeline', prompts);
    assert.equal(beforeClose.toolCount, 2, 'the live timeline must contain one tool card per Turn');
    const burstBeforeClose = await selectSessionTimeline(
        first.page, seeded.burstSessionId, 'assistant-part-6:cold reopen burst',
    );
    assertBurstToolPlacement(burstBeforeClose, 'live reconciled burst timeline');
    await first.page.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeStop());
    await first.close();
    first = null;

    second = await launchElectron(appData, launcherPath, statePath);
    await openAgentWorkbench(second.page);
    await selectNova(second.page);
    const afterReopen = await selectSessionTimeline(second.page, seeded.sessionId);
    assertToolIsInsideTurn(afterReopen, 'cold-reopened timeline', prompts);
    assert.equal(afterReopen.toolCount, 2, 'cold reopen must retain one tool card per Turn');
    assert.deepEqual(afterReopen.snapshot, beforeClose.snapshot,
        'a full Electron restart must preserve stable normalized Block identity and order');
    assert.deepEqual(afterReopen.kinds, beforeClose.kinds,
        'a full Electron restart must preserve the visible DOM timeline order');
    assert.deepEqual(afterReopen.ids, beforeClose.ids,
        'a full Electron restart must preserve the visible DOM timeline identities');
    const burstAfterReopen = await selectSessionTimeline(
        second.page, seeded.burstSessionId, 'assistant-part-6:cold reopen burst',
    );
    assertBurstToolPlacement(burstAfterReopen, 'cold-reopened burst timeline');
    assert.deepEqual(burstAfterReopen.snapshot, burstBeforeClose.snapshot,
        'cold reopen must preserve the exact 11-tool normalized timeline');
    assert.deepEqual(burstAfterReopen.kinds, burstBeforeClose.kinds,
        'cold reopen must preserve every visible burst boundary');
    assert.deepEqual(burstAfterReopen.ids, burstBeforeClose.ids,
        'cold reopen must preserve the burst DOM identities');
    const screenshotPath = String(process.env.VCP_E2E_SCREENSHOT_PATH || '').trim();
    if (screenshotPath) {
        await second.page.evaluate(() => {
            const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages-container');
            if (feed) feed.scrollTop = 0;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        await second.page.screenshot({ path: screenshotPath });
    }
    console.log(JSON.stringify({
        fullElectronRestart: true,
        omittedToolInThreadRead: true,
        omittedReasoningInThreadRead: true,
        rewrittenHistoryItemIdentity: true,
        toolCards: afterReopen.toolCount + burstAfterReopen.toolCount,
        burstToolCards: burstAfterReopen.toolCount,
        timelineKinds: afterReopen.snapshot.map((message) => message.blocks[0]),
        burstTimelineKinds: burstAfterReopen.snapshot.map((message) => message.blocks[0]),
    }));
} finally {
    if (first) await first.close();
    if (second) await second.close();
    await fs.rm(appData, { recursive: true, force: true });
}
