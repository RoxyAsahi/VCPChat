import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { developmentBridgePath } = require('../modules/codex-runtime/toolboxBridgePaths');

// Explicit opt-in only.  This test opens the two observer channels and then
// closes them; it never invokes a tool, changes ToolBox configuration, or
// answers an approval request.
assert.equal(process.env.VCP_CODEX_LIVE, '1', 'Set VCP_CODEX_LIVE=1 to run the live ToolBox observer probe');
const toolboxUrl = String(process.env.VCP_TOOLBOX_URL || '').trim();
const toolboxApiKey = String(process.env.VCP_TOOLBOX_API_KEY || '');
assert.ok(toolboxUrl, 'VCP_TOOLBOX_URL is required');
assert.ok(toolboxApiKey, 'VCP_TOOLBOX_API_KEY is required');

const projectRoot = path.resolve(import.meta.dirname, '..');
const executable = process.env.VCP_TOOLBOX_BRIDGE
    || developmentBridgePath(projectRoot);
assert.equal(fs.existsSync(executable), true, `ToolBox bridge binary is missing: ${executable}`);

const child = spawn(executable, [], {
    cwd: projectRoot,
    env: {
        ...process.env,
        VCP_TOOLBOX_URL: toolboxUrl,
        VCP_TOOLBOX_API_KEY: toolboxApiKey,
        VCP_TOOLBOX_RECONNECT_BASE_MS: '250',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
});
let buffer = '';
let finished = false;
const connected = new Set();
const timeout = setTimeout(() => finish(new Error('Timed out waiting for VCPLog and VCPInfo observer connections')), 15_000);

child.stdout.setEncoding('utf8');
child.stderr.resume(); // Diagnostics intentionally stay out of the test log.
child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf('\n');
    while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
            const message = JSON.parse(line);
            if (message.type === 'event'
                && message.event?.state === 'connected'
                && (message.channel === 'log-status' || message.channel === 'info-status')) {
                connected.add(message.channel);
                if (connected.size === 2) finish();
            }
        } catch {
            // A malformed observer line is ignored here; it cannot satisfy a
            // connection assertion and is not echoed because it may contain
            // external ToolBox log payloads.
        }
        index = buffer.indexOf('\n');
    }
});
child.once('exit', (code) => {
    if (!finished) finish(new Error(`ToolBox bridge exited before both observer channels connected (code=${code})`));
});

function finish(error = null) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (error) {
        if (!child.killed) child.kill();
        throwAsync(error);
        return;
    }
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
}

function throwAsync(error) {
    process.nextTick(() => { throw error; });
}

await new Promise((resolve, reject) => {
    child.once('exit', (code) => {
        if (connected.size === 2 && code === 0) resolve();
        else reject(new Error(`ToolBox bridge did not shut down cleanly (code=${code})`));
    });
});
console.log('ToolBox VCPLog/VCPInfo observer live-connect test passed.');
