import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLiveRustEnvironment } from './rust-live-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await requireLiveRustEnvironment();

function run(script, extraEnv = {}) {
    const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, ...extraEnv },
        stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status || 1);
}

run('scripts/build-rust-daemon.mjs');
// R3-M's only current live gate is deliberately narrow: real ToolBox model
// concurrency plus cancellation across two v1.7 Topic Hosts. The older live
// scripts still speak the removed v1.6 direct commands and are kept as
// historical test material until their individual migrations land; running
// them here would turn this gate into a misleading guaranteed failure.
run('scripts/test-live-rust-concurrent-topics.mjs');

console.log('R3-M live Rust Agent concurrent Topic gate passed.');
