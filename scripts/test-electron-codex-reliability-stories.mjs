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
        await sleep(75);
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
    const rendererErrors = [];
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
            VCP_FAKE_CODEX_AUTO_COMPLETE_TURNS: '1',
            VCP_FAKE_CODEX_SLOW_PROMPT: 'reliability pause',
            VCP_FAKE_CODEX_SLOW_DELAY_MS: '10000',
            VCP_FAKE_CODEX_PARTIAL_ON_INTERRUPT: '1',
            VCP_FAKE_CODEX_DUPLICATE_TERMINAL: '1',
            VCP_FAKE_CODEX_OMIT_TOOLS_ON_READ: '1',
            VCP_FAKE_CODEX_OMIT_REASONING_ON_READ: '1',
            VCP_FAKE_CODEX_REWRITE_ITEMS_ON_READ: '1',
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
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error?.stack || error}`));
    page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(`console.error: ${message.text()}`);
    });
    await waitFor(() => page.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true'),
        `Electron renderer did not become ready: ${output.value}`, startupTimeoutMs);
    return {
        child, browser, page, output, rendererErrors,
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
    if (!await page.$('#nextUiInternalAppHost .agent-workbench-root')) {
        await page.click('#nextUiAddTabBtn');
        await page.waitForSelector('.next-ui-internal-app-item[title="VCPBUILD"]', { visible: true, timeout: timeoutMs });
        await page.evaluate(() => document.querySelector('.next-ui-internal-app-item[title="VCPBUILD"]')?.click());
        await page.waitForSelector('#nextUiInternalAppHost .agent-workbench-root', { visible: true, timeout: timeoutMs });
    }
    await page.waitForFunction(() => [...document.querySelectorAll('#nextUiInternalAppHost .sidebar-tab-button')]
        .some((tab) => tab.textContent?.trim() === '助手'), { timeout: timeoutMs });
    await page.evaluate(() => [...document.querySelectorAll('#nextUiInternalAppHost .sidebar-tab-button')]
        .find((tab) => tab.textContent?.trim() === '助手')?.click());
    await page.waitForFunction(() => [...document.querySelectorAll('#nextUiInternalAppHost .agent-chat-agent-row')]
        .some((row) => row.querySelector('.agent-name')?.textContent?.trim() === 'Nova'), { timeout: timeoutMs });
    await page.evaluate(() => [...document.querySelectorAll('#nextUiInternalAppHost .agent-chat-agent-row')]
        .find((row) => row.querySelector('.agent-name')?.textContent?.trim() === 'Nova')?.click());
}

async function activeSessionId(page) {
    return page.evaluate(() => document.querySelector(
        '#nextUiInternalAppHost .agent-chat-session-row.active[data-session-id]',
    )?.dataset.sessionId || null);
}

async function sessionIds(page) {
    return page.evaluate(() => [...new Set([...document.querySelectorAll(
        '#nextUiInternalAppHost .agent-chat-session-row[data-session-id]',
    )].map((row) => row.dataset.sessionId).filter(Boolean))]);
}

async function selectSession(page, sessionId, marker = null) {
    await waitFor(() => page.evaluate((id, expected) => {
        const row = [...document.querySelectorAll(
            '#nextUiInternalAppHost .agent-chat-session-row[data-session-id]',
        )].find((candidate) => candidate.dataset.sessionId === id);
        const active = document.querySelector(
            '#nextUiInternalAppHost .agent-chat-session-row.active[data-session-id]',
        );
        const feed = document.querySelector('#nextUiInternalAppHost .agent-chat-messages');
        if (active?.dataset.sessionId === id && (!expected || feed?.textContent?.includes(expected))) return true;
        row?.click();
        return false;
    }, sessionId, marker), `Session ${sessionId} did not become active`);
}

async function sendFromComposer(page, prompt) {
    await page.evaluate((value) => {
        const input = document.querySelector('#nextUiInternalAppHost .agent-chat-message-input');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, prompt);
    await page.click('#nextUiInternalAppHost .agent-chat-send-button');
}

async function openMessageAction(page, marker, action) {
    await waitFor(() => page.evaluate((text) => {
        const rows = [...document.querySelectorAll(
            '#nextUiInternalAppHost .agent-chat-messages .message-item[data-agent-timeline-kind="message"]',
        )];
        const row = rows.find((candidate) => candidate.textContent?.includes(text));
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true, clientX: rect.left + 20, clientY: rect.top + 20,
        }));
        return true;
    }, marker), `Message action target was not found: ${marker}`);
    await page.waitForSelector(`#chatContextMenu [data-agent-action="${action}"]`, { visible: true, timeout: timeoutMs });
    await page.click(`#chatContextMenu [data-agent-action="${action}"]`);
}

async function submitEditDialog(page, value) {
    await page.waitForSelector('.vcp-ui-dialog-form textarea', { visible: true, timeout: timeoutMs });
    await page.evaluate((nextValue) => {
        const input = document.querySelector('.vcp-ui-dialog-form textarea');
        input.value = nextValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }, value);
}

async function projectionDigest(page, sessionId) {
    return page.evaluate(async (id) => {
        const snapshot = await (window.chatAPI || window.electronAPI).agentSessionRead({
            sessionId: id, reconcile: false,
        });
        return (snapshot.messages || []).map((message) => ({
            messageId: message.messageId,
            turnId: message.turnId,
            role: message.role,
            status: message.status,
            blocks: (message.blocks || []).map((block) => ({
                blockId: block.blockId,
                kind: block.kind,
                status: block.status,
                content: block.content,
            })),
        }));
    }, sessionId);
}

async function feedText(page) {
    return page.evaluate(() => document.querySelector(
        '#nextUiInternalAppHost .agent-chat-messages',
    )?.textContent || '');
}

async function visibleRunState(page) {
    return page.evaluate(() => {
        const placeholder = document.querySelector('#nextUiInternalAppHost .agent-chat-turn-starting');
        const send = document.querySelector('#nextUiInternalAppHost .agent-chat-send-button');
        const active = document.querySelector(
            '#nextUiInternalAppHost .agent-chat-session-row.active[data-session-id]',
        );
        return {
            activeSessionId: active?.dataset.sessionId || null,
            placeholder: placeholder?.textContent || null,
            sendClass: send?.className || null,
            sendLabel: send?.getAttribute('aria-label') || null,
            sendTitle: send?.getAttribute('title') || null,
            sendDisabled: send?.disabled ?? null,
            feedText: document.querySelector('#nextUiInternalAppHost .agent-chat-messages')?.textContent || '',
        };
    });
}

async function fakeState(statePath) {
    return JSON.parse(await fs.readFile(statePath, 'utf8'));
}

function digestText(digest) {
    return JSON.stringify(digest);
}

function semanticDigest(digest) {
    return digest.map((message) => ({
        turnId: message.turnId,
        role: message.role,
        status: message.status,
        blocks: message.blocks.map((block) => ({
            kind: block.kind, status: block.status, content: block.content,
        })),
    }));
}

const appData = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-codex-reliability-'));
const statePath = path.join(appData, 'fake-codex-state.json');
const launcherPath = path.join(appData, process.platform === 'win32' ? 'codex-app-server.cmd' : 'codex-app-server');
if (process.platform === 'win32') {
    await fs.writeFile(launcherPath, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
} else {
    await fs.writeFile(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`, { mode: 0o755 });
}
await fs.writeFile(path.join(appData, 'settings.json'), JSON.stringify({
    uiMode: 'next', enableDistributedServer: false, ChatDataServiceEnabled: false,
}), 'utf8');

let first = null;
let second = null;
try {
    first = await launchElectron(appData, launcherPath, statePath);
    const original = await first.page.evaluate(async () => {
        const api = window.chatAPI || window.electronAPI;
        await api.agentRuntimeStart();
        const session = await api.agentSessionCreate({ agentId: 'Nova', title: 'Reliability original' });
        await api.agentRuntimeEnsureSessionRuntime({ sessionId: session.sessionId });
        return session;
    });
    await openAgentWorkbench(first.page);
    await selectSession(first.page, original.sessionId);

    await sendFromComposer(first.page, 'reliability pause');
    await waitFor(async () => (await feedText(first.page)).includes('reliability pause'),
        'UI send did not render the user message');
    try {
        await waitFor(() => first.page.evaluate(() => {
            const placeholder = document.querySelector('#nextUiInternalAppHost .agent-chat-turn-starting');
            const send = document.querySelector('#nextUiInternalAppHost .agent-chat-send-button');
            const label = `${send?.getAttribute('aria-label') || ''} ${send?.getAttribute('title') || ''}`;
            return Boolean(placeholder?.textContent?.includes('回复中')
                && send?.classList.contains('interrupt-mode')
                && !send.disabled
                && /暂停|中止/.test(label));
        }), 'Slow Turn did not expose the reply placeholder and pause action', 10_000);
    } catch (error) {
        throw new Error(`${error.message}: ${JSON.stringify({
            ui: await visibleRunState(first.page),
            fixture: await fakeState(statePath),
        })}`);
    }
    await first.page.click('#nextUiInternalAppHost .agent-chat-send-button');
    await waitFor(async () => (await fakeState(statePath)).interrupts === 1,
        'Pause did not reach the fake App Server turn/interrupt boundary');
    await waitFor(() => first.page.evaluate(() => {
        const send = document.querySelector('#nextUiInternalAppHost .agent-chat-send-button');
        return !document.querySelector('#nextUiInternalAppHost .agent-chat-turn-starting')
            && !send?.classList.contains('interrupt-mode');
    }), 'Interrupted Turn did not settle its placeholder and composer state');
    const interruptedText = digestText(await projectionDigest(first.page, original.sessionId));
    assert.match(interruptedText, /reliability pause/);
    assert.match(interruptedText, /assistant-partial:reliability pause/);
    assert.doesNotMatch(interruptedText, /assistant-result:reliability pause/,
        'a cancelled delayed response must not arrive after the interrupted terminal event');

    await sendFromComposer(first.page, 'reliability original answer');
    await waitFor(async () => (await feedText(first.page)).includes('assistant-result:reliability original answer'),
        'Normal UI send did not produce a completed answer');
    const originalBeforeBranches = await projectionDigest(first.page, original.sessionId);
    const originalTurnIds = [...new Set(originalBeforeBranches.map((message) => message.turnId).filter(Boolean))];
    assert.equal(originalTurnIds.length, 2, 'the original Session must retain the interrupted and completed Turns');

    const idsBeforeRetry = await sessionIds(first.page);
    await openMessageAction(first.page, 'assistant-result:reliability original answer', 'retry');
    const retrySessionId = await waitFor(async () => {
        const active = await activeSessionId(first.page);
        return active && active !== original.sessionId ? active : null;
    }, 'Retry did not select its new branch');
    await waitFor(async () => (await sessionIds(first.page)).length === idsBeforeRetry.length + 1,
        'Retry branch did not appear in the Session list');
    await waitFor(async () => (await feedText(first.page)).includes('assistant-result:reliability original answer'),
        'Retry branch did not complete the replacement Turn');
    const retryDigest = await projectionDigest(first.page, retrySessionId);
    const retryTurnIds = [...new Set(retryDigest.map((message) => message.turnId).filter(Boolean))];
    assert.equal(retryTurnIds.length, 2, 'retry must copy the earlier interrupted Turn and add one replacement Turn');
    assert.equal(retryTurnIds.includes(originalTurnIds[1]), false,
        'retry with beforeTurnId must not retain the replaced original Turn');

    const idsBeforeEdit = await sessionIds(first.page);
    await openMessageAction(first.page, 'assistant-result:reliability original answer', 'edit');
    await submitEditDialog(first.page, 'reliability edited answer');
    const editSessionId = await waitFor(async () => {
        const active = await activeSessionId(first.page);
        return active && active !== retrySessionId ? active : null;
    }, 'Edit and resend did not select its new branch');
    await waitFor(async () => (await sessionIds(first.page)).length === idsBeforeEdit.length + 1,
        'Edit branch did not appear in the Session list');
    await waitFor(async () => (await feedText(first.page)).includes('assistant-result:reliability edited answer'),
        'Edited replacement Turn did not complete');
    const editText = digestText(await projectionDigest(first.page, editSessionId));
    assert.match(editText, /reliability edited answer/);
    assert.doesNotMatch(editText, /assistant-result:reliability original answer/,
        'edit and resend must replace the selected Turn instead of retaining its answer');

    const idsBeforeFork = await sessionIds(first.page);
    await openMessageAction(first.page, 'assistant-result:reliability edited answer', 'fork');
    const forkSessionId = await waitFor(async () => {
        const active = await activeSessionId(first.page);
        return active && active !== editSessionId ? active : null;
    }, 'Explicit Fork did not select its new Session');
    await waitFor(async () => (await sessionIds(first.page)).length === idsBeforeFork.length + 1,
        'Explicit Fork did not appear in the Session list');
    assert.deepEqual(
        semanticDigest(await projectionDigest(first.page, forkSessionId)),
        semanticDigest(await projectionDigest(first.page, editSessionId)),
        'an explicit Fork must initially preserve the selected Turn history exactly');
    await sendFromComposer(first.page, 'reliability branch only');
    await waitFor(async () => (await feedText(first.page)).includes('assistant-result:reliability branch only'),
        'Explicit branch did not accept its own follow-up Turn');

    const sessionExpectations = new Map([
        [original.sessionId, ['assistant-result:reliability original answer']],
        [retrySessionId, ['assistant-result:reliability original answer']],
        [editSessionId, ['assistant-result:reliability edited answer']],
        [forkSessionId, ['assistant-result:reliability edited answer', 'assistant-result:reliability branch only']],
    ]);
    const forbiddenBySession = new Map([
        [original.sessionId, ['assistant-result:reliability edited answer', 'assistant-result:reliability branch only']],
        [retrySessionId, ['assistant-result:reliability edited answer', 'assistant-result:reliability branch only']],
        [editSessionId, ['assistant-result:reliability original answer', 'assistant-result:reliability branch only']],
        [forkSessionId, ['assistant-result:reliability original answer']],
    ]);
    const beforeReload = new Map();
    for (const [sessionId, markers] of sessionExpectations) {
        await selectSession(first.page, sessionId, markers.at(-1));
        const text = await feedText(first.page);
        markers.forEach((marker) => assert.match(text, new RegExp(marker)));
        forbiddenBySession.get(sessionId).forEach((marker) => assert.doesNotMatch(text, new RegExp(marker)));
        beforeReload.set(sessionId, await projectionDigest(first.page, sessionId));
    }
    const expectedSessionIds = [...sessionExpectations.keys()].sort();
    assert.deepEqual((await sessionIds(first.page)).filter((id) => sessionExpectations.has(id)).sort(), expectedSessionIds,
        'the live Session list must contain every reliability branch');

    await first.page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await waitFor(() => first.page.evaluate(() => document.documentElement.dataset.vcpRendererReady === 'true'),
        'Renderer did not recover after reload');
    await openAgentWorkbench(first.page);
    for (const [sessionId, markers] of sessionExpectations) {
        await selectSession(first.page, sessionId, markers.at(-1));
        assert.deepEqual(await projectionDigest(first.page, sessionId), beforeReload.get(sessionId),
            `Renderer reload changed durable message identity for ${sessionId}`);
    }
    assert.equal((await fakeState(statePath)).forks, 3,
        'retry, edit-resend, and explicit fork must each use one real thread/fork request');
    assert.deepEqual(first.rendererErrors, [], `Renderer errors were reported: ${first.rendererErrors.join('\n')}`);

    await first.page.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeStop());
    await first.close();
    first = null;

    second = await launchElectron(appData, launcherPath, statePath);
    await openAgentWorkbench(second.page);
    for (const [sessionId, markers] of sessionExpectations) {
        await selectSession(second.page, sessionId, markers.at(-1));
        const digest = await projectionDigest(second.page, sessionId);
        assert.deepEqual(digest, beforeReload.get(sessionId),
            `cold reopen changed or removed branch history for ${sessionId}`);
        const text = await feedText(second.page);
        forbiddenBySession.get(sessionId).forEach((marker) => assert.doesNotMatch(text, new RegExp(marker)));
    }
    assert.deepEqual((await sessionIds(second.page)).filter((id) => sessionExpectations.has(id)).sort(), expectedSessionIds,
        'cold reopen must retain the complete Session list');
    assert.deepEqual(second.rendererErrors, [], `Renderer errors were reported: ${second.rendererErrors.join('\n')}`);
    console.log(JSON.stringify({
        uiSend: true,
        pauseInterrupt: true,
        partialInterruptSettlement: true,
        duplicateTerminalIdempotency: true,
        retryBeforeTurnFork: true,
        editAndResendFork: true,
        explicitFork: true,
        sessionListIsolation: true,
        rendererReload: true,
        coldReopen: true,
        sessions: [...sessionExpectations.keys()],
    }));
} finally {
    await second?.page?.evaluate(async () => (window.chatAPI || window.electronAPI).agentRuntimeStop()).catch(() => null);
    await second?.close().catch(() => null);
    await first?.close().catch(() => null);
    await fs.rm(appData, { recursive: true, force: true });
}
