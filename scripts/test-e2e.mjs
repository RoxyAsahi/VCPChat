// Hermetic E2E test suite — no live model calls, no ToolBox network access.
// Requires the daemon binary to be compiled first:  npm run build:daemon
//
// Usage:
//   npm run test:e2e
//   node scripts/test-e2e.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const daemon = path.join(root, 'rust', 'target', 'release', `vcp-agentd${ext}`);

if (!fs.existsSync(daemon)) {
    console.error(`vcp-agentd not found at ${daemon}`);
    console.error('Compile it first: npm run build:daemon');
    process.exit(1);
}

function run(script) {
    console.log(`\n--- ${path.basename(script)} ---`);
    const result = spawnSync(process.execPath, [script], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}

// 1. JS adapter contract: RustAgentRuntimeManager against FakeTransport (no binary needed)
run('scripts/test-rust-agent-runtime.mjs');
// 2. framed-stdio contract: ready, topicId, settings, interaction-queue, crash-recovery
run('scripts/test-rust-daemon-smoke.mjs');
// 3. cooperative multi-daemon Topic concurrency (real binary, no model call)
run('scripts/test-rust-topic-takeover.mjs');
// 4. Electron GUI smoke: Workbench integration without a live ToolBox connection
run('scripts/test-electron-gui-smoke.mjs');

console.log('\nAll hermetic E2E tests passed.');
