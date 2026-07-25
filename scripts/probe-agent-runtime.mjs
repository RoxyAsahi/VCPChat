import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { resolveElectronNodeExecPath } = require('../modules/agent-runtime/workerTransport.js');
const sidecar = path.join(root, 'agent-runtime', 'sidecar.cjs');
const driver = process.env.AGENT_RUNTIME_DRIVER || 'pi';

const child = fork(sidecar, [], {
    cwd: root,
    execPath: resolveElectronNodeExecPath(root),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_RUNTIME_DRIVER: driver },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});

const timeout = setTimeout(() => {
    console.error('Agent runtime probe timed out.');
    child.kill('SIGKILL');
    process.exitCode = 1;
}, 30000);

child.on('message', (message) => {
    if (message?.type !== 'ready') return;
    clearTimeout(timeout);
    console.log(JSON.stringify(message, null, 2));
    const requestId = `probe_shutdown_${Date.now()}`;
    child.send({ type: 'shutdown', requestId });
    if (!message.probe?.available) process.exitCode = 1;
});

child.on('error', (error) => {
    clearTimeout(timeout);
    console.error(error);
    process.exitCode = 1;
});
