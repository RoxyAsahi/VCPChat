import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
    'modules/codex-runtime/appServerTransport.js',
    'modules/codex-runtime/runtimeManager.js',
    'modules/codex-runtime/toolboxBridgeTransport.js',
    'modules/codex-runtime/toolboxResponsesAdapter.js',
    'modules/codex-runtime/projection/repository.js',
    'modules/codex-runtime/projection/projector.js',
    'modules/ipc/agentRuntimeHandlers.js',
    'modules/ui-system/agent-workbench-controller.js',
    'modules/ui-system/agent-workbench-store.js',
    'modules/ui-system/agent-presentation/contract.js',
    'modules/ui-system/agent-presentation/renderer.js',
    'modules/ui-system/agent-presentation/stream-batcher.js',
    'scripts/run-electron-node.mjs',
    'scripts/test-codex-nova-live.mjs',
    'scripts/test-codex-app-server-adapter-real.mjs',
    'docs/agent-runtime/current/architecture.md',
    'docs/agent-runtime/current/app-server-protocol.md',
    'docs/agent-runtime/current/projection-store.md',
    'docs/agent-runtime/current/toolbox-bridge.md',
    'docs/agent-runtime/current/agent-workbench.md',
    'docs/agent-runtime/current/delivery-plan.md',
    'docs/agent-runtime/current/test-matrix.md',
];

const errors = [];
for (const relative of requiredFiles) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`missing Codex runtime file: ${relative}`);
}

const handlers = fs.readFileSync(path.join(root, 'modules/ipc/agentRuntimeHandlers.js'), 'utf8');
if (!handlers.includes('CodexRuntimeManager')) errors.push('IPC handlers must use CodexRuntimeManager');
if (handlers.includes('RustAgentRuntimeManager')) errors.push('IPC handlers must not use RustAgentRuntimeManager');

const preload = fs.readFileSync(path.join(root, 'preloads/chat.js'), 'utf8');
for (const method of [
    'agentRuntimeGetStatus', 'agentRuntimeStart', 'agentRuntimeStop',
    'agentRuntimeCreateSession', 'agentRuntimeEnsureSessionRuntime', 'agentRuntimeForkSession', 'agentRuntimeListTopics',
    'agentRuntimeReadTopic', 'agentRuntimeReadProjection', 'agentRuntimeStartTurn',
    'agentRuntimeCancelTurn', 'agentRuntimeRespondApproval', 'agentRuntimeSetWorkbenchPresence',
    'onAgentRuntimeEvent',
]) {
    if (!preload.includes(method)) errors.push(`chat preload missing API: ${method}`);
}
for (const forbidden of ['agentRuntimeExec', 'agentRuntimeReadFile', 'agentRuntimeWriteFile', 'agentRuntimeInvoke']) {
    if (preload.includes(forbidden)) errors.push(`chat preload exposes forbidden generic API: ${forbidden}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.build?.extraResources?.some((item) => String(item.from).includes('vcp-agentd'))) {
    errors.push('Codex product packaging must not ship the old vcp-agentd daemon');
}
if (!packageJson.build?.extraResources?.some((item) => String(item.from).includes('vcp-toolbox-bridge'))) {
    errors.push('Codex product packaging must include vcp-toolbox-bridge');
}
if (!packageJson.scripts?.['test:codex-stack']) errors.push('package scripts must define test:codex-stack');
if (!packageJson.scripts?.['test:codex-toolbox-responses-adapter']) errors.push('package scripts must define the VChat-owned Responses adapter test');

const currentDocs = fs.readdirSync(path.join(root, 'docs/agent-runtime/current'));
for (const file of currentDocs) {
    if (!file.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(root, 'docs/agent-runtime/current', file), 'utf8');
    if (/vcp_delegate.*(?:current|正式)|(?:current|正式).*vcp_delegate|SQLite Runtime Repository.*(?:current|正式)|(?:current|正式).*SQLite Runtime Repository/i.test(text)) {
        errors.push(`current Codex document contains an archived Rust/Pi product path: ${file}`);
    }
}

if (errors.length > 0) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
}
console.log(`Codex Agent Runtime guard passed (${requiredFiles.length} required files, Codex black-box boundary, narrow IPC).`);
