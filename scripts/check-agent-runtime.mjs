import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
    'agent-runtime/sidecar.cjs',
    'agent-runtime/protocol.cjs',
    'agent-runtime/piAdapter.mjs',
    'agent-runtime/vcp-pi-core/index.mjs',
    'agent-runtime/vcp-pi-core/UPSTREAM.md',
    'agent-runtime/vcp-pi-core/LICENSE',
    'modules/agent-runtime/contracts.js',
    'modules/agent-runtime/runtimeManager.js',
    'modules/agent-runtime/workerTransport.js',
    'modules/agent-runtime/approvalBroker.js',
    'modules/agent-runtime/toolbox/legacyVcpToolboxClient.js',
    'modules/ipc/agentRuntimeHandlers.js',
    'modules/ui-system/agent-workbench.js',
    'styles/ui-system/agent-workbench.css',
    'docs/agent-runtime/README.md',
    'docs/agent-runtime/security-threat-model.md',
    'docs/agent-runtime/test-matrix.md',
];
const removedDuplicateBackends = [
    'modules/agent-runtime/workspace/workspaceManager.js',
    'modules/agent-runtime/terminal/terminalService.js',
    'modules/agent-runtime/tools/localToolProvider.js',
    'modules/agent-runtime/security/executionPolicy.js',
];

const errors = [];
for (const relative of requiredFiles) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`missing required file: ${relative}`);
}
for (const relative of removedDuplicateBackends) {
    if (fs.existsSync(path.join(root, relative))) errors.push(`duplicate execution backend must stay removed: ${relative}`);
}

const preload = fs.readFileSync(path.join(root, 'preloads/chat.js'), 'utf8');
for (const method of [
    'agentRuntimeGetStatus', 'agentRuntimeStart', 'agentRuntimeStop',
    'agentRuntimeCreateSession', 'agentRuntimeListSessions',
    'agentRuntimeStartTurn', 'agentRuntimeCancelTurn',
    'agentRuntimeRespondApproval', 'agentRuntimeSetWorkbenchPresence', 'onAgentRuntimeEvent',
]) {
    if (!preload.includes(method)) errors.push(`chat preload missing API: ${method}`);
}
for (const forbidden of ['agentRuntimeExec', 'agentRuntimeReadFile', 'agentRuntimeWriteFile', 'agentRuntimeInvoke']) {
    if (preload.includes(forbidden)) errors.push(`chat preload exposes forbidden generic API: ${forbidden}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.dependencies?.['@earendil-works/pi-agent-core'] || packageJson.dependencies?.['@earendil-works/pi-ai']) {
    errors.push('upstream Pi runtime packages must not be production dependencies after vendoring');
}
if (packageJson.dependencies?.typebox !== '1.1.38') errors.push('typebox must be directly pinned for VCP Pi tool schemas');
if (!packageJson.build?.files?.includes('agent-runtime/**/*')) {
    errors.push('electron-builder files must include agent-runtime/**/*');
}
if (!packageJson.build?.files?.includes('styles/**/*')) {
    errors.push('electron-builder files must include styles/**/*');
}

const sidecar = fs.readFileSync(path.join(root, 'agent-runtime/sidecar.cjs'), 'utf8');
if (/vcpApiKey|Authorization:\s*`Bearer/.test(sidecar)) {
    errors.push('sidecar must not contain VCP key or Authorization header handling');
}
const piAdapter = fs.readFileSync(path.join(root, 'agent-runtime/piAdapter.mjs'), 'utf8');
if (/Authorization:\s*`Bearer|vcpConfig\.apiKey/.test(piAdapter)) {
    errors.push('Pi adapter must not receive or send VCP credentials');
}
for (const removedTool of ['workspace_read', 'workspace_list', 'workspace_search', 'terminal_execute']) {
    if (piAdapter.includes(`['${removedTool}'`)) errors.push(`Pi adapter must not expose removed local tool: ${removedTool}`);
}

if (errors.length > 0) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
}
console.log(`Agent Runtime guard passed (${requiredFiles.length} required files, narrow preload, controlled Pi core, credential boundary).`);
