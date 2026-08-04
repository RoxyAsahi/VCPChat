import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const errors = [];
function filesUnder(directory, pattern = /\.(?:c?js|mjs)$/) {
    const result = [];
    const pending = [directory];
    while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) pending.push(absolute);
            else if (pattern.test(entry.name)) result.push(absolute);
        }
    }
    return result;
}
function localDependencies(file, allowedRoots) {
    const source = fs.readFileSync(file, 'utf8');
    const dependencies = [];
    const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
        if (!match[1].startsWith('.')) continue;
        const base = path.resolve(path.dirname(file), match[1]);
        const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')];
        const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
        if (resolved && allowedRoots.some((directory) => resolved.startsWith(directory))) dependencies.push(resolved);
    }
    return dependencies;
}
function assertAcyclic(files, label) {
    const fileSet = new Set(files);
    const graph = new Map(files.map((file) => [file, localDependencies(file, [root]).filter((item) => fileSet.has(item))]));
    const active = new Set();
    const complete = new Set();
    const stack = [];
    function visit(file) {
        if (complete.has(file)) return;
        if (active.has(file)) {
            const cycleStart = stack.indexOf(file);
            const cycle = [...stack.slice(cycleStart), file].map((item) => path.relative(root, item));
            errors.push(`${label} contains a circular dependency: ${cycle.join(' -> ')}`);
            return;
        }
        active.add(file);
        stack.push(file);
        for (const dependency of graph.get(file) || []) visit(dependency);
        stack.pop();
        active.delete(file);
        complete.add(file);
    }
    for (const file of files) visit(file);
}
const agentCssOwners = [
    'agent-shell.css', 'agent-sidebar.css', 'agent-composer.css', 'agent-timeline.css',
    'agent-session-dock.css', 'agent-workspace.css', 'agent-activity.css',
    'agent-responsive.css', 'agent-legacy-shell-adapter.css',
];
const agentCssEntryPath = path.join(root, 'styles/ui-system/agent-workbench.css');
const expectedAgentCssEntry = agentCssOwners.map((file) => `@import url('./${file}');`).join('\n');
if (!fs.existsSync(agentCssEntryPath)) errors.push('missing Agent Workbench CSS entry');
else if (fs.readFileSync(agentCssEntryPath, 'utf8').trim() !== expectedAgentCssEntry) {
    errors.push('Agent Workbench CSS import order or entry ownership is invalid');
}
for (const file of agentCssOwners) {
    const absolute = path.join(root, 'styles/ui-system', file);
    if (!fs.existsSync(absolute)) errors.push(`missing Agent CSS owner: ${file}`);
    else {
        const source = fs.readFileSync(absolute, 'utf8');
        const lineCount = source.split(/\r?\n/).length;
        if (lineCount > 900) errors.push(`${file} exceeds CSS owner ceiling: ${lineCount} lines`);
        if (file !== 'agent-legacy-shell-adapter.css'
            && /(?:^|[,{\s])(?:\.container|\.main-content|\.chat-header|\.chat-input-card)(?:[\s>.:#,]|$)/m.test(source)) {
            errors.push(`${file} contains legacy shared-shell selectors outside the adapter`);
        }
    }
}
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
if (workbenchImplementationLineCount > 800) errors.push(`agent-workbench-implementation.js exceeds composition ceiling: ${workbenchImplementationLineCount} lines`);
if (controllerFacadeLineCount > 800) errors.push(`agent-workbench-controller.js exceeds controller facade ceiling: ${controllerFacadeLineCount} lines`);
if (controllerImplementationLineCount > 600) errors.push(`agent-workbench-controller-implementation.js exceeds controller ceiling: ${controllerImplementationLineCount} lines`);
const commandControllerPath = path.join(root, 'modules/ui-system/agent-workbench-command-controller.js');
if (!fs.existsSync(commandControllerPath)) errors.push('Workbench command controller is missing');
else if (fs.readFileSync(commandControllerPath, 'utf8').split(/\r?\n/).length > 900) errors.push('agent-workbench-command-controller.js exceeds module ceiling');
const rendererFacadePath = 'modules/ui-system/agent-presentation/fork/agentMessageRenderer.js';
const rendererImplementationPath = 'modules/ui-system/agent-presentation/fork/agent-renderer-runtime.js';
const rendererStreamPath = 'modules/ui-system/agent-presentation/fork/agent-renderer-stream.js';
const forkLineCount = fs.readFileSync(path.join(root, rendererFacadePath), 'utf8').split(/\r?\n/).length;
const forkImplementationLineCount = fs.readFileSync(path.join(root, rendererImplementationPath), 'utf8').split(/\r?\n/).length;
if (forkLineCount > 600) errors.push(`${rendererFacadePath} exceeds facade ceiling: ${forkLineCount} lines`);
if (forkImplementationLineCount > 600) errors.push(`${rendererImplementationPath} exceeds facade ceiling: ${forkImplementationLineCount} lines`);
if (!fs.existsSync(path.join(root, rendererStreamPath))) errors.push(`missing Agent renderer stream module: ${rendererStreamPath}`);
const forkReceipt = fs.readFileSync(path.join(root, 'modules/ui-system/agent-presentation/fork/FORK_RECEIPT.md'), 'utf8');
if (!forkReceipt.includes('独立演进策略') || !forkReceipt.includes('不再要求跟随主聊天 renderer 逐行同步')) {
    errors.push('Agent renderer receipt must declare independent evolution rather than manual synchronization');
}
const rendererImplementation = fs.readFileSync(path.join(root,
    'modules/ui-system/agent-presentation/fork/agent-renderer-runtime.js'), 'utf8');
for (const forbidden of [
    'initializeImageHandler(', 'visibilityOptimizer.initialize', 'visibilityOptimizer.destroy',
    'contentProcessor.initializeContentProcessor(',
]) {
    if (rendererImplementation.includes(forbidden)) {
        errors.push(`Agent renderer uses shared mutable singleton lifecycle: ${forbidden}`);
    }
}
const rendererForkDirectory = path.join(root, 'modules/ui-system/agent-presentation/fork');
const rendererForkFiles = filesUnder(rendererForkDirectory);
const rendererForbiddenRefs = [
    ...forbiddenGlobalRefs, 'window.chatManager', 'initializeImageHandler(',
    'visibilityOptimizer.initialize', 'visibilityOptimizer.destroy',
    'contentProcessor.initializeContentProcessor(',
];
for (const absolute of rendererForkFiles) {
    const relative = path.relative(root, absolute);
    const source = fs.readFileSync(absolute, 'utf8');
    const lineCount = source.split(/\r?\n/).length;
    if (lineCount > 900) errors.push(`${relative} exceeds module ceiling: ${lineCount} lines`);
    for (const token of rendererForbiddenRefs) {
        if (source.includes(token)) errors.push(`${relative} reads forbidden shared renderer state: ${token}`);
    }
    if (!/agent-renderer-session\.js$/.test(absolute)
        && /\b(?:document|window)\.addEventListener\s*\(/.test(source)) {
        errors.push(`${relative} owns an unscoped document/window listener`);
    }
    if (!/(?:agent-renderer-session|agentVisibilityController)\.js$/.test(absolute)
        && /\b(?:setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|MutationObserver|IntersectionObserver)\b/.test(source)) {
        errors.push(`${relative} bypasses the Agent Renderer lifecycle owner`);
    }
}
assertAcyclic(rendererForkFiles, 'Agent renderer fork');
for (const [file, forbiddenPattern] of [
    ['agent-renderer-runtime.js', /\b(?:requestAnimationFrame|requestIdleCallback|setTimeout|setInterval|MutationObserver|IntersectionObserver)\b/],
    ['agent-renderer-message-lifecycle.js', /\b(?:requestAnimationFrame|requestIdleCallback|setTimeout|setInterval|MutationObserver|IntersectionObserver)\b/],
]) {
    const source = fs.readFileSync(path.join(root, 'modules/ui-system/agent-presentation/fork', file), 'utf8');
    if (forbiddenPattern.test(source)) errors.push(`${file} bypasses the Agent Renderer lifecycle scheduler`);
}
const workbenchClients = fs.readFileSync(path.join(root, 'modules/ui-system/agent-workbench-clients.js'), 'utf8');
if (/agentRuntime(?:CreateTopic|CreateSession|ListTopics|ReadTopic|ReadProjection|RenameTopic|DeleteTopic)/.test(workbenchClients)) {
    errors.push('formal Workbench client boundary exposes deprecated Topic APIs');
}
for (const file of [
    'agent-workbench-implementation.js', 'agent-workbench-command-controller.js',
    'agent-settings-view.js', 'agent-timeline-coordinator.js',
]) {
    const source = fs.readFileSync(path.join(root, 'modules/ui-system', file), 'utf8');
    const allowedComposition = file === 'agent-workbench-implementation.js'
        ? source.replace('createWorkbenchController(runtimeApi())', 'createWorkbenchController(hostApi)') : source;
    if (/\bruntimeApi\s*\(\)|\bruntimeApi\.[A-Za-z_$]/.test(allowedComposition)) {
        errors.push(`${file} bypasses the formal Workbench client boundary`);
    }
}
if (!fs.existsSync(path.join(root, 'modules/ui-system/agent-workbench-clients.js'))) {
    errors.push('Workbench client boundary is missing');
}
if (!fs.existsSync(path.join(root, 'modules/ui-system/agent-workbench-lifecycle.js'))) {
    errors.push('missing Workbench lifecycle module');
}
const governedUiModules = [
    'agent-workbench-sidebar-view.js',
    'agent-session-dock-view.js',
    'agent-notification-view.js',
    'agent-approval-view.js',
    'agent-workbench-topic-flow.js',
    'agent-session-catalog-coordinator.js',
    'agent-settings-coordinator.js',
    'agent-topic-context-menu-view.js',
    'agent-session-operations-coordinator.js',
    'agent-activity-coordinator.js',
    'agent-composer-coordinator.js',
    'agent-workbench-render-coordinator.js',
    'agent-workbench-sidebar-coordinator.js',
    'agent-timeline-coordinator.js',
    'agent-session-view-context.js',
    'agent-workbench-state.js',
];
for (const file of governedUiModules) {
    const absolute = path.join(root, 'modules/ui-system', file);
    if (!fs.existsSync(absolute)) {
        errors.push(`missing governed Workbench module: ${file}`);
        continue;
    }
    const source = fs.readFileSync(absolute, 'utf8');
    const lineCount = source.split(/\r?\n/).length;
    if (lineCount > 900) errors.push(`${file} exceeds module ceiling: ${lineCount} lines`);
    if (/window\.(?:chatAPI|electronAPI)|\bruntimeApi\s*\(/.test(source)) {
        errors.push(`${file} bypasses Workbench action/client boundary`);
    }
}
const governedAgentModuleDirectories = [
    path.join(root, 'modules/codex-runtime'),
    path.join(root, 'modules/ui-system'),
];
const governedAgentModules = governedAgentModuleDirectories.flatMap((directory) => filesUnder(directory))
    .filter((absolute) => absolute.includes(`${path.sep}codex-runtime${path.sep}`)
        || path.basename(absolute).startsWith('agent-')
        || absolute.includes(`${path.sep}agent-presentation${path.sep}`));
for (const absolute of governedAgentModules) {
    const lineCount = fs.readFileSync(absolute, 'utf8').split(/\r?\n/).length;
    if (lineCount > 900) errors.push(`${path.relative(root, absolute)} exceeds module ceiling: ${lineCount} lines`);
}
assertAcyclic(governedAgentModules, 'Agent host integration');
for (const file of filesUnder(path.join(root, 'modules/ui-system'), /agent-.*\.js$/)) {
    const relative = path.relative(root, file);
    const source = fs.readFileSync(file, 'utf8');
    if (!/(?:agent-workbench-lifecycle|agent-renderer-session|agent-session-catalog-coordinator)\.js$/.test(file)
        && /\b(?:setInterval|setTimeout|requestAnimationFrame|requestIdleCallback)\s*\(/.test(source)) {
        errors.push(`${relative} owns an unregistered timer or frame`);
    }
    if (/agent-session-catalog-coordinator\.js$/.test(file)
        && /(?:window\.requestAnimationFrame|setTimeout\s*\()/.test(source)) {
        errors.push(`${relative} bypasses the injected Workbench lifecycle frame scheduler`);
    }
    if (!/(?:agent-session-dock-view|agent-topic-context-menu-view|agent-renderer-session)\.js$/.test(file)
        && /\b(?:document|window)\.addEventListener\s*\(/.test(source)) {
        errors.push(`${relative} owns an unregistered document/window listener`);
    }
}
const formalWorkbenchViews = [
    'agent-workbench-shell-view.js', 'agent-workbench-header-view.js',
    'agent-workbench-run-status-view.js', 'agent-workbench-sidebar-view.js',
    'agent-workbench-composer-view.js', 'agent-workbench-timeline-view.js',
    'agent-session-dock-view.js', 'agent-workspace-view.js',
    'agent-notification-view.js', 'agent-approval-view.js', 'agent-workbench-account-view.js',
];
for (const file of formalWorkbenchViews) {
    const absolute = path.join(root, 'modules/ui-system', file);
    const source = fs.readFileSync(absolute, 'utf8');
    if (!/\belement\b/.test(source) || !/\bupdate\s*(?:\(|:)/.test(source) || !/\bdispose\s*\(/.test(source)) {
        errors.push(`${file} does not expose the standard View lifecycle contract`);
    }
}
for (const file of ['agent-workbench-state.js', 'agent-session-dock.js']) {
    if (!fs.existsSync(path.join(root, 'modules/ui-system', file))) {
        errors.push(`missing Renderer state owner: ${file}`);
    }
}
const selectedSessionSource = fs.readFileSync(path.join(root, 'modules/ui-system/agent-selected-session.js'), 'utf8');
if (!selectedSessionSource.includes('topicSessionId !== sessionId')) {
    errors.push('SelectedSessionIdentity must fail closed when projection and selection disagree');
}
for (const file of filesUnder(path.join(root, 'modules/ui-system'))) {
    if (file.endsWith('agent-selected-session.js')) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/selectedSessionId\s*\|\|\s*[^\n]*selectedTopic|selectedTopic\?\.sessionId\s*\|\|/.test(source)) {
        errors.push(`${path.relative(root, file)} contains an implicit Session identity fallback`);
    }
}
for (const [relative, pattern] of [
    ['modules/ui-system/agent-workbench-controller-implementation.js', /projection\?\.session\?\.sessionId\s*\|\|\s*selectedTopic\.sessionId/],
    ['modules/ui-system/agent-workbench-timeline-view.js', /!current\.selectedSessionId\s*&&\s*!current\.selectedTopic\?\.sessionId/],
]) {
    if (pattern.test(fs.readFileSync(path.join(root, relative), 'utf8'))) {
        errors.push(`${relative} uses a display snapshot as a Session selection fallback`);
    }
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
    'test:agent-workbench-clients']) {
    if (!packageJson.scripts?.[script]) errors.push(`package.json missing governance gate ${script}`);
}
if (!packageJson.scripts?.['lint:agent']) {
    errors.push('package.json missing canonical Agent ESLint gate');
} else if (!String(packageJson.scripts['test:codex-ci'] || '').includes('lint:agent')) {
    errors.push('test:codex-ci must execute the canonical Agent ESLint gate');
}
const agentEslintConfigPath = path.join(root, 'eslint.agent.config.mjs');
if (!fs.existsSync(agentEslintConfigPath)) {
    errors.push('canonical Agent ESLint config is missing');
} else {
    const agentEslintSource = fs.readFileSync(agentEslintConfigPath, 'utf8');
    if (!/complexity:\s*\['error',\s*29\]/.test(agentEslintSource)) {
        errors.push('Agent ESLint must enforce the final complexity ceiling of 29');
    }
    if (!/agent-store\/\*\*\/\*\.js[\s\S]*complexity:\s*\['error',\s*29\]/.test(agentEslintSource)) {
        errors.push('Agent Store reducers must enforce complexity below 30');
    }
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
const canonicalRuntimeDir = path.join(root, 'modules/codex-runtime');
const operationContextPath = path.join(canonicalRuntimeDir, 'runtime-operation-context.js');
if (!fs.existsSync(operationContextPath)) errors.push('RuntimeOperationContext contract is missing');
else {
    const operationContextSource = fs.readFileSync(operationContextPath, 'utf8');
    if (!operationContextSource.includes('createRuntimeOperationContext')
        || !operationContextSource.includes('sessionId')
        || !operationContextSource.includes('threadId')
        || !operationContextSource.includes('turnId')) {
        errors.push('RuntimeOperationContext must bind generation and Session/Thread/Turn identity');
    }
}
for (const file of [
    'runtime-session-service.js', 'runtime-recovery-service.js', 'runtime-turn-service.js',
    'runtime-config-service.js', 'runtime-host-service.js', 'runtime-interaction-service.js',
    'runtime-toolbox-service.js',
]) {
    const source = fs.readFileSync(path.join(canonicalRuntimeDir, file), 'utf8');
    if (!source.includes('createOperationContext') || !source.includes('assertOperationContext')) {
        errors.push(`${file} does not enforce RuntimeOperationContext across remote operations`);
    }
}
for (const file of [
    'runtime-turn-service.js', 'runtime-config-service.js', 'runtime-host-service.js',
    'runtime-interaction-service.js', 'runtime-toolbox-service.js',
]) {
    const source = fs.readFileSync(path.join(canonicalRuntimeDir, file), 'utf8');
    if (/this\.context\.captureGeneration\(\)/.test(source)) {
        errors.push(`${file} bypasses RuntimeOperationContext with a bare generation capture`);
    }
}
const runtimeServiceGraph = fs.readFileSync(path.join(canonicalRuntimeDir, 'runtime-service-graph.js'), 'utf8');
const runtimeServiceContexts = fs.readFileSync(path.join(canonicalRuntimeDir, 'runtime-service-contexts.js'), 'utf8');
if (!runtimeServiceContexts.includes('createRuntimeServiceContext')
    || !runtimeServiceContexts.includes('cannot expose Runtime Manager')) {
    errors.push('Runtime services must use explicit capability contexts without Manager authority');
}
if (/runtime\.(?:createTopic|readTopic)\(/.test(runtimeServiceGraph)) {
    errors.push('canonical Runtime service graph delegates through deprecated Topic methods');
}
const runtimeTopicCompatibility = path.join(canonicalRuntimeDir, 'runtime-topic-compatibility.js');
if (fs.existsSync(runtimeTopicCompatibility)) errors.push('deprecated Runtime Topic compatibility adapter must be removed');
const topicMethodPattern = /\b(?:createTopic|listTopics|readTopic|renameTopic|deleteTopic)\b/;
for (const entry of fs.readdirSync(canonicalRuntimeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.js$/.test(entry.name)) continue;
    const source = fs.readFileSync(path.join(canonicalRuntimeDir, entry.name), 'utf8');
    if (/\btopicId\b/.test(source)) {
        errors.push(`modules/codex-runtime/${entry.name} contains legacy Topic identity`);
    }
    if (/\b(?:compatibilitySession|compatibilityRuntime|resolveSessionIdInput)\b/.test(source)) {
        errors.push(`modules/codex-runtime/${entry.name} imports legacy Session compatibility helpers`);
    }
    if (topicMethodPattern.test(source)) {
        errors.push(`modules/codex-runtime/${entry.name} exposes deprecated Topic methods outside compatibility adapter`);
    }
}
const canonicalWorkbenchFiles = fs.readdirSync(path.join(root, 'modules/ui-system'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^agent-.*\.js$/.test(entry.name));
for (const entry of canonicalWorkbenchFiles) {
    const source = fs.readFileSync(path.join(root, 'modules/ui-system', entry.name), 'utf8');
    if (/\btopicId\b|data-topic-id/.test(source)) {
        errors.push(`modules/ui-system/${entry.name} contains legacy Topic identity`);
    }
    if (/\b(?:createTopic|listTopics|readTopic|renameTopic|deleteTopic)\b/.test(source)) {
        errors.push(`modules/ui-system/${entry.name} exposes deprecated Topic operations`);
    }
    if (entry.name !== 'agent-workbench-host-adapter.js'
        && /window\.(?:prompt|confirm|globalSettings|vcpRenderBridge)/.test(source)) {
        errors.push(`modules/ui-system/${entry.name} bypasses Workbench Host Adapter`);
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
for (const filePath of [
    runtimeInteractionServicePath, runtimeToolboxServicePath, runtimeRecoveryServicePath,
    runtimeSessionServicePath, runtimeTurnServicePath, runtimeConfigServicePath,
    runtimeProfileServicePath, runtimeHostServicePath, runtimePolicyServicePath,
    runtimeEventServicePath,
]) {
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    if (/constructor\(context\)[\s\S]{0,180}this\.context\s*=\s*context/.test(source)) {
        errors.push(`${path.basename(filePath)} retains a mutable RuntimeServiceContext dependency table`);
    }
}
if (/fs\.statSync\(|setWorkbenchPresence\([^)]*\)\s*\{[\s\S]{0,400}failClosed/.test(runtimeManagerSource)) {
    errors.push('Runtime Manager contains Session or Interaction business behavior instead of service delegation');
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
if (!runtimeManagerSource.includes('async updateSessionConfig(')) {
    errors.push('Runtime manager must expose an explicit Session config API');
}
if (fs.existsSync(path.join(root, 'modules/ipc/agentSessionCompatibility.js'))) {
    errors.push('Topic IPC compatibility adapter must be removed');
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
