import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { WebSocketServer } from 'ws';

const projectRoot = path.resolve(import.meta.dirname, '..');
const executable = process.env.VCP_TOOLBOX_BRIDGE
    || path.join(projectRoot, 'rust', 'target', 'release', process.platform === 'win32'
        ? 'vcp-toolbox-bridge.exe' : 'vcp-toolbox-bridge');
const testKey = 'test-key-not-logged';

assert.equal(fs.existsSync(executable), true, `ToolBox bridge binary is missing: ${executable}`);

function launch(extraEnv = {}) {
    const child = spawn(executable, [], {
        cwd: projectRoot,
        env: {
            ...process.env,
            VCP_TOOLBOX_URL: 'http://127.0.0.1:65534',
            VCP_TOOLBOX_API_KEY: testKey,
            ...extraEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

function messages(processHandle) {
    return processHandle.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
}

async function waitFor(predicate, failureMessage, timeoutMs = 10_000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(failureMessage());
}

async function waitForExit(child, timeoutMessage) {
    if (child.exitCode != null) return child.exitCode;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error(timeoutMessage));
        }, 5_000);
        child.once('exit', (code) => {
            clearTimeout(timeout);
            resolve(code);
        });
    });
}

// Process-level fixture for the vcp-code-inspired observer lifecycle.  Both
// read-only channels fail, report bounded reconnect attempts, redact the key,
// and stop permanently when their stdio owner asks for shutdown.
const observerServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve, reject) => {
    observerServer.once('listening', resolve);
    observerServer.once('error', reject);
});
observerServer.on('connection', (socket) => setTimeout(() => socket.close(), 10));
const observerPort = observerServer.address().port;
const observer = launch({
    VCP_TOOLBOX_URL: `http://127.0.0.1:${observerPort}`,
    VCP_TOOLBOX_RECONNECT_BASE_MS: '250',
});
await waitFor(
    () => messages(observer).some((message) => message.type === 'ready'),
    () => `Bridge ready timeout: ${observer.stderr}`,
);
assert.equal(messages(observer).find((message) => message.type === 'ready').protocolVersion, 1);
await waitFor(
    () => messages(observer).filter((message) => message.type === 'event'
        && ['log-status', 'info-status'].includes(message.channel)
        && message.event?.state === 'disconnected'
        && message.event?.attempt >= 2).length >= 2,
    () => `Bridge reconnect status timeout (exit=${observer.child.exitCode}): ${observer.stdout}\n${observer.stderr}`,
);
assert.equal(observer.stdout.includes(testKey), false, 'observer status must never expose the ToolBox key');
observer.child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
assert.equal(await waitForExit(observer.child, 'Bridge shutdown timeout'), 0, observer.stderr);
await new Promise((resolve) => observerServer.close(resolve));

// A malformed over-limit control frame is a protocol integrity failure, not a
// recoverable observer condition.  Keep this separate process so shutdown
// semantics and fail-closed line-limit semantics have independent receipts.
const oversized = launch();
await waitFor(
    () => messages(oversized).some((message) => message.type === 'ready'),
    () => `Bridge ready timeout: ${oversized.stderr}`,
);
oversized.child.stdin.write(`${JSON.stringify({
    type: 'approvalResponse', requestId: 'not-pending', approved: false, reason: 'process smoke',
})}\n`);
await waitFor(
    () => messages(oversized).some((message) => message.type === 'approvalResult'
        && message.requestId === 'not-pending'),
    () => `Bridge approval response timeout: ${oversized.stdout}`,
    5_000,
);
const approvalResult = messages(oversized).find((message) => message.type === 'approvalResult'
    && message.requestId === 'not-pending');
assert.equal(approvalResult.written, false);
assert.equal(approvalResult.error, 'approval-not-pending');
oversized.child.stdin.write(`${'x'.repeat(2 * 1024 * 1024 + 1)}\n`);
await waitFor(
    () => messages(oversized).some((message) => message.type === 'error' && message.code === 'command-too-large'),
    () => `Bridge oversized command timeout: ${oversized.stdout}`,
    5_000,
);
assert.equal(await waitForExit(oversized.child, 'Bridge oversized-command shutdown timeout'), 2, oversized.stderr);
console.log('Codex ToolBox bridge process test passed.');
