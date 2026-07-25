import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
    'agent-runtime/sidecar.cjs',
    'agent-runtime/protocol.cjs',
    'agent-runtime/piAdapter.mjs',
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

const errors = [];
for (const relative of requiredFiles) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`missing required file: ${relative}`);
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
if (packageJson.dependencies?.['@earendil-works/pi-agent-core'] !== '0.82.0') {
    errors.push('pi-agent-core must be exactly pinned to 0.82.0');
}
if (packageJson.dependencies?.['@earendil-works/pi-ai'] !== '0.82.0') {
    errors.push('pi-ai must be exactly pinned to 0.82.0');
}
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

if (errors.length > 0) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
}
console.log(`Agent Runtime guard passed (${requiredFiles.length} required files, narrow preload, pinned Pi, credential boundary).`);
