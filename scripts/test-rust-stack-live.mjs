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
run('scripts/test-live-rust-agent.mjs');
run('scripts/test-live-rust-tools.mjs');
run('scripts/test-live-rust-backend-yolo.mjs');
run('scripts/test-live-rust-long-task.mjs');
run('scripts/test-live-rust-lifecycle.mjs');
run('scripts/test-electron-gui-smoke.mjs', {
    VCPCHAT_E2E_LIVE_TOOLBOX: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_HIGH_RISK: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_BACKEND_YOLO: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_CANCEL: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_RELOAD: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_COMPACTION: '1',
});

console.log('Full live Rust Agent stack passed.');
