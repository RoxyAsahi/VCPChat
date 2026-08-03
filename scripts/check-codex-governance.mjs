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
    'docs/agent-runtime/current/receipts/r12-working-tree.json',
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
    'modules/ui-system/agent-workbench-controller.js',
    'modules/ui-system/agent-workbench.js',
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
// R12 adds only the desired/applied settings projection to this existing
// composition root. Keep the hard ceiling finite while the planned module
// extraction proceeds; no new message/Markdown/tool logic belongs here.
if (workbenchLineCount > 4450) errors.push(`agent-workbench.js exceeds composition-root ceiling: ${workbenchLineCount} lines`);
const forkLineCount = fs.readFileSync(path.join(root, 'modules/ui-system/agent-presentation/fork/agentMessageRenderer.js'), 'utf8').split(/\r?\n/).length;
if (forkLineCount > 3500) errors.push(`agentMessageRenderer.js exceeds independent renderer ceiling: ${forkLineCount} lines`);
const forkReceipt = fs.readFileSync(path.join(root, 'modules/ui-system/agent-presentation/fork/FORK_RECEIPT.md'), 'utf8');
if (!forkReceipt.includes('独立演进策略') || !forkReceipt.includes('不再要求跟随主聊天 renderer 逐行同步')) {
    errors.push('Agent renderer receipt must declare independent evolution rather than manual synchronization');
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
const runtimeManagerSource = fs.readFileSync(path.join(root, 'modules/codex-runtime/runtimeManager.js'), 'utf8');
if (!runtimeManagerSource.includes('async updateSessionConfig(')
    || !runtimeManagerSource.includes('SESSION_IDENTITY_MISMATCH')) {
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
