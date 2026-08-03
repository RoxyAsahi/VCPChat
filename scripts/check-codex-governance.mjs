import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const errors = [];
const productRoots = ['modules', 'preloads'];
for (const productRoot of productRoots) {
    const pending = [path.join(root, productRoot)];
    while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(absolute);
            else if (/\.(?:c?js|mjs)$/.test(entry.name)
                && fs.readFileSync(absolute, 'utf8').includes('archive/agent-runtime')) {
                errors.push(`${path.relative(root, absolute)} imports archived Agent Runtime code`);
            }
        }
    }
}
const required = [
    'docs/agent-runtime/current/reliability-roadmap.md',
    'docs/agent-runtime/current/risk-register.md',
    'docs/agent-runtime/current/ownership.md',
    'docs/agent-runtime/current/adr/ADR-007-codex-sqlite-saga.md',
    'docs/agent-runtime/current/adr/ADR-008-agent-renderer-independence.md',
    'docs/agent-runtime/current/receipts/r7-r10-working-tree.json',
    'docs/agent-runtime/current/data-governance.md',
    'docs/agent-runtime/current/adr/ADR-009-agent-config-desired-applied.md',
    'docs/agent-runtime/current/adr/ADR-010-agent-code-governance.md',
    'docs/agent-runtime/current/receipts/r12-working-tree.json',
    'docs/agent-runtime/current/receipts/agent-governance-working-tree.json',
    '.github/workflows/codex_agent_windows.yml',
];
for (const relative of required) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`missing governance artifact: ${relative}`);
}

const receiptPath = path.join(root, 'docs/agent-runtime/current/receipts/r7-r10-working-tree.json');
if (fs.existsSync(receiptPath)) {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!['planned', 'implemented', 'hermetic', 'live', 'product'].includes(receipt.status)) {
        errors.push(`invalid receipt status: ${receipt.status}`);
    }
    if (receipt.codexProtocol !== '0.146') errors.push('reliability receipt must pin Codex protocol 0.146');
    if (receipt.toolboxModified !== false) errors.push('R7-R10 must not modify VCPToolBox');
    if (!Array.isArray(receipt.commands) || receipt.commands.length < 4) errors.push('reliability receipt lacks command evidence declarations');
}

const rendererFiles = [
    'modules/ui-system/agent-workbench-store.js',
    'modules/ui-system/agent-workbench-controller-implementation.js',
    'modules/ui-system/agent-workbench-implementation.js',
];
const rendererBoundaryFiles = [
    'modules/ui-system/agent-presentation/renderer.js',
    'modules/ui-system/agent-presentation/markdown-stream.js',
    'modules/ui-system/agent-presentation/blocks/tool.js',
    'modules/ui-system/agent-presentation/blocks/approval.js',
    'modules/ui-system/agent-session-dock.js',
    'modules/ui-system/agent-workspace-model.js',
];
for (const relative of rendererBoundaryFiles) {
    if (!fs.existsSync(path.join(root, relative))) errors.push(`missing Agent renderer boundary module: ${relative}`);
}
const forbiddenGlobalRefs = [
    'currentChatHistoryRef', 'currentSelectedItemRef', 'currentTopicIdRef', 'saveChatHistory',
];
for (const relative of rendererFiles) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (/\b(?:state|current)\.attachment\b/.test(source)) errors.push(`${relative} still reads global attachment state`);
    for (const token of forbiddenGlobalRefs) {
        if (source.includes(token)) errors.push(`${relative} reads forbidden main-chat global ${token}`);
    }
}
const workbenchLineCount = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench.js'), 'utf8').split(/\r?\n/).length;
const workbenchImplementationLineCount = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-implementation.js'), 'utf8').split(/\r?\n/).length;
const controllerFacadeLineCount = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-controller.js'), 'utf8').split(/\r?\n/).length;
const controllerImplementationLineCount = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-controller-implementation.js'), 'utf8').split(/\r?\n/).length;
if (workbenchLineCount > 800) errors.push(`agent-workbench.js exceeds composition facade ceiling: ${workbenchLineCount} lines`);
if (workbenchImplementationLineCount > 3400) errors.push(`agent-workbench-implementation.js exceeds temporary extraction ceiling: ${workbenchImplementationLineCount} lines`);
if (controllerFacadeLineCount > 800) errors.push(`agent-workbench-controller.js exceeds controller facade ceiling: ${controllerFacadeLineCount} lines`);
if (controllerImplementationLineCount > 600) errors.push(`agent-workbench-controller-implementation.js exceeds controller ceiling: ${controllerImplementationLineCount} lines`);
const commandControllerPath = path.join(root, 'modules/ui-system/agent-workbench-command-controller.js');
if (!fs.existsSync(commandControllerPath)) errors.push('Workbench command controller is missing');
else if (fs.readFileSync(commandControllerPath, 'utf8').split(/\r?\n/).length > 900) errors.push('agent-workbench-command-controller.js exceeds module ceiling');
const rendererFacadePath = 'modules/ui-system/agent-presentation/fork/agentMessageRenderer.js';
const rendererImplementationPath = 'modules/ui-system/agent-presentation/fork/agentMessageRendererImplementation.js';
const rendererStreamPath = 'modules/ui-system/agent-presentation/fork/agent-renderer-stream.js';
const forkLineCount = fs.readFileSync(path.join(root, rendererFacadePath), 'utf8').split(/\r?\n/).length;
const forkImplementationLineCount = fs.readFileSync(path.join(root, rendererImplementationPath), 'utf8').split(/\r?\n/).length;
if (forkLineCount > 600) errors.push(`${rendererFacadePath} exceeds facade ceiling: ${forkLineCount} lines`);
if (forkImplementationLineCount > 3200) errors.push(`${rendererImplementationPath} exceeds temporary extraction ceiling: ${forkImplementationLineCount} lines`);
if (!fs.existsSync(path.join(root, rendererStreamPath))) errors.push(`missing Agent renderer stream module: ${rendererStreamPath}`);
const forkReceipt = fs.readFileSync(path.join(root, 'modules/ui-system/agent-presentation/fork/FORK_RECEIPT.md'), 'utf8');
if (!forkReceipt.includes('独立演进策略') || !forkReceipt.includes('不再要求跟随主聊天 renderer 逐行同步')) {
    errors.push('Agent renderer receipt must declare independent evolution rather than manual synchronization');
}
const rendererImplementation = fs.readFileSync(path.join(root,
    'modules/ui-system/agent-presentation/fork/agentMessageRendererImplementation.js'), 'utf8');
for (const forbidden of [
    'initializeImageHandler(', 'visibilityOptimizer.initialize', 'visibilityOptimizer.destroy',
    'contentProcessor.initializeContentProcessor(',
]) {
    if (rendererImplementation.includes(forbidden)) {
        errors.push(`Agent renderer uses shared mutable singleton lifecycle: ${forbidden}`);
    }
}
const workbenchClients = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-clients.js'), 'utf8');
if (/agentRuntime(?:CreateTopic|CreateSession|ListTopics|ReadTopic|ReadProjection|RenameTopic|DeleteTopic)/.test(workbenchClients)) {
    errors.push('formal Workbench client boundary exposes deprecated Topic APIs');
}
for (const file of ['agent-session-client.js', 'agent-projection-client.js', 'agent-interaction-client.js', 'agent-workspace-client.js']) {
    if (!fs.existsSync(path.join(root, 'modules/ui-system', file))) errors.push(`missing Workbench client module: ${file}`);
}
if (!fs.existsSync(path.join(root, 'modules/ui-system/agent-workbench-lifecycle.js'))) {
    errors.push('missing Workbench lifecycle module');
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const script of ['test:codex-reliability', 'test:electron-codex-recovery', 'check:codex-governance', 'test:codex-ci']) {
    if (!packageJson.scripts?.[script]) errors.push(`package.json missing ${script}`);
}
if (!String(packageJson.scripts?.['test:e2e'] || '').includes('test:codex-stack')) {
    errors.push('default test:e2e must run the Codex Agent stack');
}
if (packageJson.devDependencies?.['@openai/codex'] !== '0.146.0') errors.push('@openai/codex must remain pinned to 0.146.0');
for (const script of ['test:agent-settings-interaction', 'test:agent-config-apply', 'test:agent-data-contracts']) {
    if (!packageJson.scripts?.[script]) errors.push(`package.json missing R12 gate ${script}`);
}
for (const script of ['test:agent-renderer-isolation', 'test:agent-renderer-lifecycle',
    'test:agent-workbench-clients', 'test:agent-session-compatibility']) {
    if (!packageJson.scripts?.[script]) errors.push(`package.json missing governance gate ${script}`);
}

const dataContracts = fs.readFileSync(path.join(root, 'modules/codex-runtime/dataContracts.js'), 'utf8');
if (!dataContracts.includes('PROFILE_SCHEMA_VERSION = 2')
    || !dataContracts.includes('SESSION_CONFIG_SCHEMA_VERSION = 2')) {
    errors.push('R12 data contracts must pin Profile and Session schema versions');
}
const attachmentRegistry = fs.readFileSync(path.join(root, 'modules/codex-runtime/attachmentRegistry.js'), 'utf8');
if (!attachmentRegistry.includes('class AttachmentRegistry') || !attachmentRegistry.includes('resolveMany')) {
    errors.push('Main-only AttachmentRegistry is missing or lacks pre-send resolution');
}
if (/return\s*\{[^}]*path\s*:/.test(attachmentRegistry)) {
    errors.push('AttachmentRegistry public descriptor must not expose an absolute path');
}
const workbenchStore = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-store.js'), 'utf8');
if (!workbenchStore.includes('createAgentEventDeduper') || workbenchStore.includes('const seenEvents = new Set')) {
    errors.push('Workbench event dedupe must be Session-scoped and bounded');
}

const identityBoundaryFiles = [
    'modules/codex-runtime/runtimeManager.js',
    'modules/ui-system/agent-workbench-controller.js',
    'modules/ui-system/agent-workbench-store.js',
];
for (const relative of identityBoundaryFiles) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    if (/\b(?:sessionId|topicId)\s*\|\|\s*(?:sessionId|topicId)\b/.test(source)) {
        errors.push(`${relative} contains implicit Session/Topic identity fallback`);
    }
}
const runtimeFacadeLineCount = fs.readFileSync(path.join(root, 'modules/codex-runtime/runtimeManager.js'), 'utf8').split(/\r?\n/).length;
if (runtimeFacadeLineCount > 600) errors.push(`runtimeManager.js exceeds facade ceiling: ${runtimeFacadeLineCount} lines`);
const runtimeManagerSource = fs.readFileSync(path.join(root, 'modules/codex-runtime/runtimeManagerImplementation.js'), 'utf8');
const runtimeManagerLines = runtimeManagerSource.split(/\r?\n/).length;
if (runtimeManagerLines > 600) errors.push(`runtimeManagerImplementation.js exceeds facade ceiling: ${runtimeManagerLines} lines`);
const runtimeNormalizersPath = path.join(root, 'modules/codex-runtime/runtime-normalizers.js');
const runtimeInteractionServicePath = path.join(root, 'modules/codex-runtime/runtime-interaction-service.js');
const runtimeToolboxServicePath = path.join(root, 'modules/codex-runtime/runtime-toolbox-service.js');
const runtimeRecoveryServicePath = path.join(root, 'modules/codex-runtime/runtime-recovery-service.js');
const runtimeSessionServicePath = path.join(root, 'modules/codex-runtime/runtime-session-service.js');
const runtimeTurnServicePath = path.join(root, 'modules/codex-runtime/runtime-turn-service.js');
const runtimeConfigServicePath = path.join(root, 'modules/codex-runtime/runtime-config-service.js');
const runtimeProfileServicePath = path.join(root, 'modules/codex-runtime/runtime-profile-service.js');
const runtimeHostServicePath = path.join(root, 'modules/codex-runtime/runtime-host-service.js');
const runtimePolicyServicePath = path.join(root, 'modules/codex-runtime/runtime-policy-service.js');
const runtimeEventServicePath = path.join(root, 'modules/codex-runtime/runtime-event-service.js');
const runtimeServiceGraphPath = path.join(root, 'modules/codex-runtime/runtime-service-graph.js');
if (!fs.existsSync(runtimeToolboxServicePath)) {
    errors.push('Runtime ToolBox service is missing');
} else if (fs.readFileSync(runtimeToolboxServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-toolbox-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeInteractionServicePath)) {
    errors.push('Runtime interaction service is missing');
} else if (fs.readFileSync(runtimeInteractionServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-interaction-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeRecoveryServicePath)) {
    errors.push('Runtime recovery service is missing');
} else if (fs.readFileSync(runtimeRecoveryServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-recovery-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeSessionServicePath)) {
    errors.push('Runtime session service is missing');
} else if (fs.readFileSync(runtimeSessionServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-session-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeTurnServicePath)) {
    errors.push('Runtime turn service is missing');
} else if (fs.readFileSync(runtimeTurnServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-turn-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeConfigServicePath)) {
    errors.push('Runtime config service is missing');
} else if (fs.readFileSync(runtimeConfigServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-config-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeProfileServicePath)) {
    errors.push('Runtime profile service is missing');
} else if (fs.readFileSync(runtimeProfileServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-profile-service.js exceeds module ceiling');
}
if (!fs.existsSync(runtimeHostServicePath)) {
    errors.push('Runtime host service is missing');
} else if (fs.readFileSync(runtimeHostServicePath, 'utf8').split(/\r?\n/).length > 900) {
    errors.push('runtime-host-service.js exceeds module ceiling');
}
for (const [label, filePath] of [
    ['Runtime policy service', runtimePolicyServicePath],
    ['Runtime event service', runtimeEventServicePath],
    ['Runtime service graph', runtimeServiceGraphPath],
]) {
    if (!fs.existsSync(filePath)) errors.push(`${label} is missing`);
    else if (fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length > 900) errors.push(`${path.basename(filePath)} exceeds module ceiling`);
}
if (!fs.existsSync(runtimeNormalizersPath)) {
    errors.push('Runtime pure normalizers module is missing');
} else {
    const normalizerLines = fs.readFileSync(runtimeNormalizersPath, 'utf8').split(/\r?\n/).length;
    if (normalizerLines > 900) errors.push(`runtime-normalizers.js exceeds module ceiling: ${normalizerLines} lines`);
    for (const requiredExport of ['decodeVcpInvokeCall', 'normalizeInteractionResponse', 'normalizeApprovalPolicy', 'sanitizeToolboxValue']) {
        if (!runtimeNormalizersPath || !fs.readFileSync(runtimeNormalizersPath, 'utf8').includes(requiredExport)) {
            errors.push(`runtime-normalizers.js missing ${requiredExport}`);
        }
    }
}
const runtimeHostServiceSource = fs.existsSync(path.join(root, 'modules/codex-runtime/runtime-host-service.js'))
    ? fs.readFileSync(path.join(root, 'modules/codex-runtime/runtime-host-service.js'), 'utf8') : '';
if (!runtimeManagerSource.includes('async updateSessionConfig(')
    || !`${runtimeManagerSource}\n${runtimeHostServiceSource}`.includes('SESSION_IDENTITY_MISMATCH')) {
    errors.push('Runtime manager must expose an explicit Session config API and reject conflicting legacy identity');
}
const sharedCatalog = fs.readFileSync(path.join(root, 'preloads/shared/catalog.js'), 'utf8');
for (const method of ['agentRuntimeReadSessionConfig', 'agentRuntimeUpdateSessionConfig']) {
    if (!sharedCatalog.includes(method)) errors.push(`shared preload catalog missing ${method}`);
}

const archivedRustWorkflow = fs.readFileSync(path.join(root, '.github/workflows/rust_agent_runtime.yml'), 'utf8');
if (/^\s{2}(push|pull_request):/m.test(archivedRustWorkflow)) {
    errors.push('archived Rust workflow must be manual-only on the Codex branch');
}

const ipcContracts = require(path.join(root, 'modules/ipc/ipcContracts.js'));
for (const channel of [
    ipcContracts.CHANNELS.AGENT_RUNTIME_LIST_RECOVERY_CANDIDATES,
    ipcContracts.CHANNELS.AGENT_RUNTIME_RESOLVE_RECOVERY_OPERATION,
]) {
    if (!ipcContracts.getChannelMeta(channel)) errors.push(`IPC registry missing recovery channel: ${channel}`);
}

if (errors.length) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
}
console.log('Codex Agent governance check passed.');
