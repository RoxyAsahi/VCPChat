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
run('scripts/test-live-rust-attachments.mjs');
run('scripts/test-live-rust-tools.mjs');
run('scripts/test-live-rust-backend-yolo.mjs');
run('scripts/test-live-rust-backend-approval-deny.mjs');
if (process.env.VCP_AGENT_LIVE_MUTATE_TOOLBOX_APPROVAL === '1') {
    run('scripts/test-live-rust-backend-approval-replay.mjs');
    if (process.env.VCP_AGENT_LIVE_BACKEND_APPROVAL_EXPIRY === '1') {
        run('scripts/test-live-rust-backend-approval-expiry.mjs');
    }
}
run('scripts/test-live-rust-long-task.mjs');
run('scripts/test-live-rust-lifecycle.mjs');
// Electron live scenarios run in independent processes. `tool_choice=required`
// is useful for the FileOperator/PowerShell fixtures, but it would corrupt a
// later pure-text long-stream test by forcing it to invoke vcp_invoke. Splitting
// the runs makes each receipt attributable and keeps the product default
// untouched. Hermetic Electron smoke separately owns crash/reconnect because
// Windows job containment can terminate the parent during a forced child kill.
const runGui = (extraEnv) => run('scripts/test-electron-gui-smoke.mjs', {
    VCPCHAT_E2E_LIVE_TOOLBOX: '1',
    VCPCHAT_E2E_SKIP_CRASH_RECOVERY: '1',
    ...extraEnv,
});

runGui({
    VCP_AGENT_TEST_TOOL_CHOICE: 'required',
    VCPCHAT_E2E_LIVE_TOOLBOX_WS: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_RELOAD: '1',
});
runGui({
    VCP_AGENT_TEST_TOOL_CHOICE: 'required',
    VCPCHAT_E2E_LIVE_TOOLBOX_SKIP_FILEOPERATOR: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_HIGH_RISK: '1',
});
runGui({
    VCP_AGENT_TEST_TOOL_CHOICE: 'required',
    VCPCHAT_E2E_LIVE_TOOLBOX_SKIP_FILEOPERATOR: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_BACKEND_YOLO: '1',
});
runGui({
    VCPCHAT_E2E_LIVE_TOOLBOX_SKIP_FILEOPERATOR: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_CANCEL: '1',
});
runGui({
    VCPCHAT_E2E_LIVE_TOOLBOX_SKIP_FILEOPERATOR: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_COMPACTION: '1',
});
runGui({
    VCPCHAT_E2E_LIVE_TOOLBOX_SKIP_FILEOPERATOR: '1',
    VCPCHAT_E2E_LIVE_TOOLBOX_LONG_STREAM: '1',
});

console.log('Full live Rust Agent stack passed.');
