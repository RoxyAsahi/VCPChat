import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const splashBinary = path.join(root, process.platform === 'win32' ? 'NativeSplash.exe' : 'NativeSplash');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`NativeSplash did not exit within ${timeoutMs}ms after receiving .vcp_ready`)), timeoutMs);
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function removeTemporaryDirectory(target) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await fs.rm(target, { recursive: true, force: true, maxRetries: 0 });
            return;
        } catch (error) {
            if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
            await sleep(200);
        }
    }
    console.warn(`NativeSplash smoke left a temporary directory after retries: ${target}`);
}

let workingDirectory;
let child;
try {
    await fs.access(splashBinary);
    workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcpchat-native-splash-'));
    child = spawn(splashBinary, [], { cwd: workingDirectory, stdio: 'ignore', windowsHide: true });
    await sleep(300);
    assert.equal(child.exitCode, null, 'NativeSplash must stay open before the ready marker exists');
    await fs.writeFile(path.join(workingDirectory, '.vcp_ready'), '');
    const code = await waitForExit(child, 5_000);
    assert.equal(code, 0, 'NativeSplash must exit cleanly after observing the ready marker');
    console.log('NativeSplash smoke passed: isolated marker caused the native splash to close.');
} finally {
    if (child?.exitCode === null) child.kill();
    if (workingDirectory) await removeTemporaryDirectory(workingDirectory);
}
