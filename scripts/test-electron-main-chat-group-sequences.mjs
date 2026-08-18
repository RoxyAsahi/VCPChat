import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'test-electron-main-chat-sequences.mjs');
const env = {
    ...process.env,
    VCPCHAT_SEQUENCE_SEED: process.env.VCPCHAT_SEQUENCE_SEED || 'group-smoke',
    VCPCHAT_SEQUENCE_RUNS: process.env.VCPCHAT_SEQUENCE_RUNS || '3',
    VCPCHAT_SEQUENCE_STEPS: process.env.VCPCHAT_SEQUENCE_STEPS || '30',
};
const child = spawn(process.execPath, [script], { env, stdio: 'inherit' });
child.once('error', error => {
    console.error(error);
    process.exitCode = 1;
});
child.once('exit', (code, signal) => {
    process.exitCode = typeof code === 'number' ? code : 1;
    if (signal) console.error(`group sequence runner terminated by ${signal}`);
});
