import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const requiredFiles = [
    'modules/codex-runtime/appServerTransport.js',
    'modules/codex-runtime/runtimeManager.js',
    'modules/codex-runtime/runtime-lifecycle-service.js',
    'modules/codex-runtime/runtime-interaction-service.js',
    'modules/codex-runtime/runtime-toolbox-service.js',
    'modules/codex-runtime/runtime-recovery-service.js',
    'modules/codex-runtime/runtime-session-service.js',
    'modules/codex-runtime/runtime-turn-service.js',
    'modules/codex-runtime/runtime-config-service.js',
    'modules/codex-runtime/runtime-profile-service.js',
    'modules/codex-runtime/runtime-host-service.js',
    'modules/codex-runtime/runtime-policy-service.js',
    'modules/codex-runtime/runtime-event-service.js',
    'modules/codex-runtime/runtime-service-graph.js',
    'modules/codex-runtime/runtime-normalizers.js',
    'modules/codex-runtime/workspaceService.js',
    'modules/codex-runtime/workspacePolicy.js',
    'modules/codex-runtime/toolboxBridgeTransport.js',
    'modules/codex-runtime/toolboxResponsesAdapter.js',
    'modules/codex-runtime/projection/repository.js',
    'modules/codex-runtime/projection/projector.js',
    'fixtures/codex-app-server-v0.146.json',
    'fixtures/codex-app-server/0.146.0/manifest.json',
    'modules/ipc/agentRuntimeHandlers.js',
    'modules/ui-system/agent-workbench-controller.js',
    'modules/ui-system/agent-workbench-command-controller.js',
    'modules/ui-system/agent-workbench-dom.js',
    'modules/ui-system/agent-workbench-shell-view.js',
    'modules/ui-system/agent-workbench-run-status-view.js',
    'modules/ui-system/agent-workbench-composer-view.js',
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
if (handlers.includes("../agent-runtime/") || handlers.includes("../../archive/agent-runtime/")) {
    errors.push('Codex IPC handlers must not import archived Agent Runtime modules');
}
if (handlers.includes('locallyAttached') || handlers.includes('attachedTopicId')) {
    errors.push('Codex Session listing must not infer a global attachment');
}

const preload = fs.readFileSync(path.join(root, 'preloads/chat.js'), 'utf8');
for (const method of [
    'agentRuntimeGetStatus', 'agentRuntimeStart', 'agentRuntimeStop',
    'agentRuntimeEnsureSessionRuntime', 'agentRuntimeStartTurn',
    'agentRuntimeCancelTurn', 'agentRuntimeRespondApproval', 'agentRuntimeSetWorkbenchPresence',
    'agentSessionCreate', 'agentSessionList', 'agentSessionRead', 'agentSessionReadProjection',
    'agentSessionRename', 'agentSessionArchive', 'agentSessionRestore', 'agentSessionDelete', 'agentSessionFork',
    'agentWorkspaceListDirectory', 'agentWorkspaceReadPreview', 'agentWorkspaceSearchFiles',
    'agentWorkspaceStatPath', 'agentWorkspacePerformPathAction',
    'onAgentRuntimeEvent',
]) {
    if (!preload.includes(method)) errors.push(`chat preload missing API: ${method}`);
}
const workbenchController = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-controller-implementation.js'), 'utf8');
for (const legacyMethod of [
    'agentRuntimeCreateTopic', 'agentRuntimeCreateSession', 'agentRuntimeListTopics',
    'agentRuntimeReadTopic', 'agentRuntimeReadProjection', 'agentRuntimeRenameTopic',
    'agentRuntimeDeleteTopic', 'agentRuntimeForkSession', 'agentRuntimeCloseSession',
    'agentRuntimeRestoreSession', 'agentRuntimePermanentlyDeleteSession',
]) {
    if (workbenchController.includes(legacyMethod)) {
        errors.push(`formal Workbench still calls deprecated Topic API: ${legacyMethod}`);
    }
}
for (const forbidden of ['agentRuntimeExec', 'agentRuntimeReadFile', 'agentRuntimeWriteFile', 'agentRuntimeInvoke']) {
    if (preload.includes(forbidden)) errors.push(`chat preload exposes forbidden generic API: ${forbidden}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.build?.extraResources?.some((item) => String(item.from).includes('vcp-agentd'))) {
    errors.push('Codex product packaging must not ship the old vcp-agentd daemon');
}
if (packageJson.build?.files?.includes('agent-runtime/**/*')
    || packageJson.build?.files?.includes('modules/agent-runtime/**/*')
    || !packageJson.build?.files?.includes('!archive/agent-runtime/**/*')) {
    errors.push('Codex product packaging must exclude archived Pi/Rust runtime sources');
}
if (!packageJson.build?.extraResources?.some((item) => String(item.from).includes('vcp-toolbox-bridge'))) {
    errors.push('Codex product packaging must include vcp-toolbox-bridge');
}
if (!packageJson.scripts?.['test:codex-stack']) errors.push('package scripts must define test:codex-stack');
if (!packageJson.scripts?.['test:codex-toolbox-responses-adapter']) errors.push('package scripts must define the VChat-owned Responses adapter test');
if (packageJson.devDependencies?.['@openai/codex'] !== '0.146.0') {
    errors.push('Codex App Server must be pinned exactly to @openai/codex 0.146.0');
}
for (const scriptName of [
    'build:daemon', 'start:rust-dev', 'test:rust-stack', 'check:rust-agent-runtime',
    'probe:agent-runtime', 'test:agent-runtime:live', 'test:agent-runtime:live-long',
]) {
    if (packageJson.scripts?.[scriptName]) errors.push(`archived runtime script remains active: ${scriptName}`);
}

const ipcContracts = require(path.join(root, 'modules/ipc/ipcContracts.js'));
for (const [, key] of handlers.matchAll(/IPC_CHANNELS\.([A-Z_]+)/g)) {
    if (typeof ipcContracts.AGENT_CHANNELS[key] !== 'string') {
        errors.push(`Agent IPC handler references undefined central channel: ${key}`);
    }
}
for (const channel of [
    ipcContracts.CHANNELS.AGENT_WORKSPACE_LIST_DIRECTORY,
    ipcContracts.CHANNELS.AGENT_WORKSPACE_READ_PREVIEW,
    ipcContracts.CHANNELS.AGENT_WORKSPACE_SEARCH_FILES,
    ipcContracts.CHANNELS.AGENT_WORKSPACE_STAT_PATH,
    ipcContracts.CHANNELS.AGENT_WORKSPACE_PERFORM_PATH_ACTION,
    ipcContracts.CHANNELS.AGENT_WORKSPACE_CANCEL,
]) {
    if (!ipcContracts.getChannelMeta(channel)) errors.push(`IPC registry missing Agent Workspace channel: ${channel}`);
}
if (Object.prototype.hasOwnProperty.call(
    ipcContracts.getChannelMeta(ipcContracts.CHANNELS.AGENT_RUNTIME_GET_STATUS)?.responseSchema || {},
    'attachment',
)) {
    errors.push('Codex Runtime status contract must not expose a global attachment');
}

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
