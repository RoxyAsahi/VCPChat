import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readCssWithImports } from '../css-import-reader.mjs';

async function waitFor(predicate, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function workbenchProjectionPatch({
    sessionId, threadId, revision, messageId, itemId, turnId, kind, content,
    sourceOrder = revision, status = 'completed',
}) {
    return {
        schemaVersion: 1, sessionId, threadId, runtimeGeneration: 1,
        baseProjectionRevision: revision - 1, projectionRevision: revision,
        upsertBlocks: [{
            schemaVersion: 2, blockId: `block:${sessionId}:${itemId}:0`, sessionId, threadId,
            turnId, itemId, messageId, kind, itemType: kind === 'tool' ? 'dynamicToolCall' : null,
            authority: kind === 'tool' ? 'toolbox' : 'codex', status, sourceOrder, ordinal: 0,
            content, createdAt: revision, updatedAt: revision,
        }], deleteBlockIds: [],
    };
}
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.Event = dom.window.Event;
globalThis.Node = dom.window.Node;
globalThis.HTMLButtonElement = dom.window.HTMLButtonElement;
const resizeObservers = [];
class TestResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
}
globalThis.ResizeObserver = TestResizeObserver;
window.ResizeObserver = TestResizeObserver;
// main.html installs this classic shared helper before uiManager. The Workbench
// test imports ESM modules directly, so install the same browser global here.
Function('window', fs.readFileSync(path.join(root, 'modules', 'ui-system', 'sidebar-resizer.js'), 'utf8'))(window);
let revokedAvatarUrl = null;
window.URL.createObjectURL = () => 'blob:cropped-agent-avatar';
window.URL.revokeObjectURL = (url) => { revokedAvatarUrl = url; };
window.uiHelperFunctions = {
    openAvatarCropper: (file, callback) => callback(file),
};

let registered = null;
let unsubscribeCalls = 0;
let eventCallback = null;
let runtimeStatus = 'stopped';
let activeRuntimeSession = null;
const presenceCalls = [];
const startedTurns = [];
const importedAttachment = {
    id: 'attachment_test_image', displayName: '设计图.png', kind: 'image', mimeType: 'image/png',
    byteLen: 314, width: 16, height: 16, sha256: 'a'.repeat(64), assetFile: 'a'.repeat(64) + '.png',
};
const importedVideoAttachment = {
    id: 'attachment_test_video', displayName: '演示.mp4', kind: 'video', mimeType: 'video/mp4',
    byteLen: 4_096, sha256: 'b'.repeat(64), assetFile: 'b'.repeat(64) + '.mp4',
};
let selectedAttachments = [importedAttachment];
const followUpTurns = [];
const steeringTurns = [];
const cancelledTurns = [];
let interactionQueue = [];
const replacedInteractionQueues = [];
const resolvedPendingInputs = [];
const createdSessions = [];
const createdTopics = [];
const renamedTopics = [];
const compactedSessions = [];
const approvalResponses = [];
const interactionResponses = [];
const openedExternalLinks = [];
const workspaceActions = [];
const savedWorkbenchSettings = [];
const sessionConfigRevisions = new Map([['topic-archived', 1]]);
const sessionConfigSnapshots = new Map([['topic-archived', {
    baseInstructions: '冻结的 Nova 指令', permissionMode: 'ask', approvalPolicy: 'on-request',
}]]);
const savedAvatars = [];
const savedAgentProfiles = [];
const runtimeTransitions = [];
const runtimeEnsures = [];
const exportedSessions = [];
let mainCreateProxyCalls = 0;
let sharedCreateActionCalls = 0;
let releaseAgentCatalog;
const buildAgentProfiles = [
    {
        id: 'Nova', name: 'Nova', avatarUrl: 'assets/nova-avatar.png', model: 'gpt-5.6-terra',
        systemPrompt: '{{Nova}}', workspaceRoot: `${root}\\nova-profile`, permissionMode: 'always-approve',
    },
    {
        id: '123', name: '123', model: 'deepseek-v4-flash', systemPrompt: '{{123}}',
        workspaceRoot: `${root}\\agent-123-profile`, permissionMode: 'ask',
    },
    {
        id: 'Legacy-Empty', name: 'Legacy Empty', model: 'deepseek-v4-flash', systemPrompt: '',
        workspaceRoot: `${root}\\legacy-empty-profile`, permissionMode: 'ask',
    },
];
const agentCatalogGate = new Promise((resolve) => { releaseAgentCatalog = resolve; });
let topicCatalog = [{
    id: 'topic-restored', title: '可恢复的 Codex Session', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, inUse: false,
}, {
    id: 'topic-archived', title: '另一条持久 Topic', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, inUse: false,
}, {
    id: 'topic-in-use', title: '并行研究 Session', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, inUse: true,
}];
const secondaryTopicCatalog = [{
        id: 'topic-agent-123', title: '123 的既有 Topic', agentId: '123',
        model: 'gpt-5.6-terra', workspaceRef: root, inUse: false,
    }];
const archivedTopicCatalog = [{
    id: 'topic-permanent-archive', title: '已归档研究会话', agentId: 'Nova',
    model: 'gpt-5.6-terra', workspaceRef: root, archivedAt: 1_700_000_000_000,
}];
const topicListRequests = [];
const topicSearchRequests = [];
let toolCatalogRequests = 0;
const toolCatalog = {
    schemaVersion: 1,
    presets: [
        { id: 'full', label: '全部开启' },
        { id: 'readonly', label: '只读' },
        { id: 'custom', label: '自定义' },
    ],
    native: [
        { id: 'codex:shell-command', title: '终端命令', description: '运行项目命令', icon: 'terminal' },
        { id: 'codex:view-image', title: '查看图片', description: '读取本地图片', icon: 'image' },
    ],
    plugins: [{
        id: 'vcp:FileOperator', pluginId: 'FileOperator', title: '文件操作', icon: 'extension',
        commands: [
            { id: 'vcp:FileOperator:ReadFile', command: 'ReadFile', description: '读取文件' },
            { id: 'vcp:FileOperator:WriteFile', command: 'WriteFile', description: '写入文件' },
        ],
    }],
};
let modelUpdateCallback = null;
let modelUnsubscribeCalls = 0;
let refreshModelCalls = 0;
window.nextUiApps = {
    register(definition) { registered = definition; return definition; },
    get() { return null; },
    list() { return []; },
};
window.chatAPI = {
    sendOpenExternalLink: (url) => { openedExternalLinks.push(url); },
    agentRuntimeListAgentProfiles: async () => {
        await agentCatalogGate;
        return buildAgentProfiles;
    },
    agentRuntimeSaveAgentProfile: async (profile) => {
        const saved = { id: profile.agentId || profile.name.replace(/\s+/g, '-'), ...profile };
        savedAgentProfiles.push(saved);
        const existingIndex = buildAgentProfiles.findIndex((item) => item.id === saved.id);
        if (existingIndex >= 0) buildAgentProfiles[existingIndex] = saved;
        else buildAgentProfiles.push(saved);
        return { success: true, profile: saved };
    },
    agentRuntimeSaveAgentAvatar: async ({ agentId, avatarData }) => {
        savedAvatars.push({ agentId, avatarData });
        return { success: true, avatarUrl: `file:///${agentId}-updated.png` };
    },
    agentRuntimeListToolCatalog: async () => { toolCatalogRequests += 1; return toolCatalog; },
    // Match the main-chat contract: this is a Main-process cache, not an
    // Agent Workbench request to the ToolBox model endpoint.
    getCachedModels: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return [{ id: 'gpt-5.6-terra', reasoning_efforts: ['low', 'medium', 'high'] }, { id: 'gpt-5.6-luna' }];
    },
    refreshModels: async () => {
        refreshModelCalls += 1;
        const models = [{ id: 'gpt-5.6-refresh', reasoning_efforts: ['medium', 'high'] }];
        modelUpdateCallback?.(models);
        return { success: true, models, count: models.length };
    },
    onModelsUpdated(callback) {
        modelUpdateCallback = callback;
        return () => { modelUnsubscribeCalls += 1; };
    },
    agentRuntimeGetStatus: async () => ({
        state: runtimeStatus,
        worker: null,
        pendingApprovals: [],
        runtimes: activeRuntimeSession ? [activeRuntimeSession] : [],
    }),
    agentWorkspaceListDirectory: async ({ sessionId, relativePath = '' }) => ({
        sessionId, workspaceRevision: 'workspace-revision-test', relativePath,
        entries: relativePath === '' ? [
            { name: 'src', kind: 'directory', relativePath: 'src' },
            { name: 'README.md', kind: 'file', relativePath: 'README.md' },
        ] : [{ name: 'index.js', kind: 'file', relativePath: 'src/index.js' }],
        nextCursor: null, truncated: false,
    }),
    agentWorkspaceReadPreview: async ({ sessionId, workspaceRevision, relativePath }) => ({
        sessionId, workspaceRevision, relativePath, displayName: path.basename(relativePath),
        kind: 'text', content: '# preview', byteLen: 9, lineCount: 1, truncated: false,
    }),
    agentWorkspaceSearchFiles: async ({ sessionId, workspaceRevision, query }) => ({
        sessionId, workspaceRevision: workspaceRevision || 'workspace-revision-test', query,
        entries: [{ name: 'README.md', kind: 'file', relativePath: 'README.md' }], truncated: false,
    }),
    agentWorkspaceStatPath: async ({ sessionId, workspaceRevision, relativePath }) => ({ sessionId, workspaceRevision, relativePath, kind: 'file' }),
    agentWorkspacePerformPathAction: async (payload) => { workspaceActions.push(payload); return { ok: true, ...payload }; },
    agentRuntimeStart: async () => { runtimeStatus = 'ready'; runtimeTransitions.push('start'); return { state: 'ready' }; },
    agentRuntimeStop: async () => { runtimeStatus = 'stopped'; runtimeTransitions.push('stop'); return { state: 'stopped' }; },
    agentSessionCreate: async (payload) => {
        createdTopics.push(payload);
        const topic = {
            sessionId: `topic-created-${createdTopics.length}`,
            agentId: payload.agent || 'Nova',
            title: payload.title || '新会话',
            model: payload.model || 'gpt-5.6-terra',
            workspaceRoot: payload.workspaceRoot || root,
            readOnly: true,
        };
        topicCatalog = [{
            id: topic.sessionId, title: topic.title, agentId: topic.agentId,
            model: topic.model, workspaceRef: topic.workspaceRoot, inUse: false,
        }, ...topicCatalog];
        return topic;
    },
    agentRuntimeEnsureSessionRuntime: async ({ sessionId }) => {
        runtimeEnsures.push(sessionId);
        runtimeStatus = 'ready';
        activeRuntimeSession = {
            sessionId,
            sessionId: sessionId,
            title: '并行研究 Session',
            state: 'ready',
            activity: 'idle',
            threadId: 'thread-active',
            agentId: 'Nova',
            workspaceRoot: root,
        };
        return activeRuntimeSession;
    },
    agentRuntimeCompactSession: async ({ sessionId }) => { compactedSessions.push(sessionId); return { ok: true }; },
    _readSessionFixture: async ({ sessionId }) => {
        if (sessionId === 'topic-missing-session') throw new Error('Agent Session was not found');
        if (sessionId === 'topic-restored') return {
            sessionId,
            readOnly: true,
            messages: [{
                messageId: 'msg_reason_saved', itemId: 'reason_saved', turnId: 'turn_saved', role: 'assistant',
                status: 'completed', sourceOrder: 1, createdAt: 1,
                blocks: [{ blockId: 'block_reason_saved', kind: 'reasoning', ordinal: 0,
                    content: { summary: ['restored reasoning detail'], content: [] } }],
            }, {
                messageId: 'msg_saved', itemId: 'answer_saved', turnId: 'turn_saved', role: 'assistant',
                status: 'completed', sourceOrder: 2, createdAt: 2,
                blocks: [{ blockId: 'block_answer_saved', kind: 'message', ordinal: 0,
                    content: { text: 'restored answer' } }],
            }, {
                messageId: 'msg_tool_saved', itemId: 'tool_saved', turnId: 'turn_saved', role: 'assistant',
                status: 'completed', sourceOrder: 3, createdAt: 3,
                blocks: [{ blockId: 'block_tool_saved', kind: 'tool', ordinal: 0, content: {
                    item: { type: 'dynamicToolCall', tool: 'FileOperator', arguments: { operation: 'read' }, result: 'package.json' },
                } }],
            }, {
                messageId: 'msg_plan_saved', itemId: 'plan_saved', turnId: 'turn_saved', role: 'assistant',
                status: 'completed', sourceOrder: 4, createdAt: 4,
                blocks: [{ blockId: 'block_plan_saved', kind: 'observation', ordinal: 0,
                    content: { text: '1. 恢复计划\n2. 验证 Activity' } }],
            }],
            projection: { activity: {
                usage: { source: 'real', totalTokens: 42, inputTokens: 20, outputTokens: 22, model: 'fixture-model', provider: 'vcp_toolbox' },
                compaction: { state: 'completed', summary: '已恢复压缩摘要', error: '' },
            } },
        };
        if (sessionId === 'topic-in-use') return {
            sessionId,
            session: {
                sessionId: sessionId,
                threadId: 'thread-active',
                agentId: 'Nova',
                workspaceRoot: root,
                configRevision: 1,
                configSnapshot: {
                    profileId: 'Nova',
                    baseInstructions: '{{Nova}}',
                    permissionMode: 'ask',
                    approvalPolicy: 'on-request',
                },
            },
            readOnly: false,
            history: [],
        };
        return {
            sessionId,
            ...(sessionId === 'topic-archived' ? {
                session: {
                    agentId: 'Nova',
                    configRevision: sessionConfigRevisions.get('topic-archived'),
                    configSnapshot: {
                        ...sessionConfigSnapshots.get('topic-archived'),
                    },
                },
            } : {}),
            readOnly: true,
            messages: [{
                messageId: 'msg_saved', itemId: 'answer_saved', turnId: 'turn_saved', role: 'assistant',
                status: 'completed', sourceOrder: 1, createdAt: 1,
                blocks: [{ kind: 'message', ordinal: 0, content: { text: 'restored answer' } }],
            }],
        };
    },
    agentRuntimeSelectAttachments: async () => ({ attachments: selectedAttachments }),
    agentRuntimeStartTurn: async (payload) => {
        startedTurns.push(payload);
        return { turnId: startedTurns.length === 1 ? 'attachment_turn' : 'turn_test', state: 'running' };
    },
    agentRuntimeFollowUpTurn: async (payload) => {
        followUpTurns.push(payload);
        interactionQueue = [...interactionQueue, { interactionId: 'follow-test', kind: 'follow-up', prompt: payload.prompt }];
        return { ok: true };
    },
    agentRuntimeSteerTurn: async (payload) => {
        steeringTurns.push(payload);
        interactionQueue = [...interactionQueue, { interactionId: 'steer-test', kind: 'steer', prompt: payload.prompt }];
        return { ok: true };
    },
    agentRuntimeCancelTurn: async (payload) => { cancelledTurns.push(payload); return { ok: true }; },
    agentRuntimeRespondApproval: async (payload) => {
        approvalResponses.push(payload);
        return { approvalId: payload.approvalId, decision: payload.decision };
    },
    agentRuntimeRespondInteraction: async (payload) => {
        interactionResponses.push(payload);
        return { requestId: payload.requestId, resolved: true, kind: payload.kind };
    },
    agentSessionList: async ({ agentId, archived = false } = {}) => {
        topicListRequests.push(agentId || 'Nova');
        if (archived) return archivedTopicCatalog;
        return agentId === '123' ? secondaryTopicCatalog : topicCatalog;
    },
    agentRuntimeSearchTopics: async ({ query, agentId } = {}) => {
        topicSearchRequests.push({ query, agentId: agentId || 'Nova' });
        const catalog = agentId === '123' ? secondaryTopicCatalog : topicCatalog;
        return catalog
            .filter((topic) => `${topic.title} ${topic.id}`.toLocaleLowerCase().includes(String(query || '').toLocaleLowerCase()))
            .map((topic) => ({
                agentId: topic.agentId || agentId || 'Nova', sessionId: topic.id, title: topic.title,
                inUse: topic.inUse === true, readOnly: topic.readOnly === true,
                model: topic.model, workspaceRef: topic.workspaceRef, updatedAt: topic.updatedAt,
                messageId: 'search-hit', snippet: topic.title, score: 1,
            }));
    },
    agentRuntimeSearchTopicMessages: async () => [],
    agentRuntimeGetTopicIndexStatus: async () => ({ available: true, rebuilding: false }),
    agentRuntimeRebuildTopicIndex: async () => ({ topicCount: topicCatalog.length }),
    agentRuntimeListInteractionQueue: async () => interactionQueue,
    agentRuntimeReplaceInteractionQueue: async ({ interactions }) => {
        interactionQueue = interactions;
        replacedInteractionQueues.push(interactions);
        return { ok: true };
    },
    agentRuntimeClearInteractionQueue: async () => { interactionQueue = []; return { ok: true }; },
    agentRuntimeResolvePendingInput: async (payload) => {
        resolvedPendingInputs.push(payload);
        interactionQueue = interactionQueue.filter((item) => (item.inputId || item.interactionId) !== payload.inputId);
        return { resolved: true, action: payload.action, items: interactionQueue };
    },
    agentRuntimeGetWorkbenchSettings: async () => ({
        budget: { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 },
        permissionMode: 'ask',
    }),
    agentRuntimeUpdateWorkbenchSettings: async (payload) => {
        savedWorkbenchSettings.push(payload);
        let configRevision = null;
        let configSnapshot = null;
        if (payload.sessionId) {
            const currentRevision = sessionConfigRevisions.get(payload.sessionId) || 1;
            assert.equal(payload.expectedConfigRevision, currentRevision,
                'settings autosave must serialize CAS writes with the latest Session config revision');
            configRevision = currentRevision + 1;
            sessionConfigRevisions.set(payload.sessionId, configRevision);
            const currentSnapshot = sessionConfigSnapshots.get(payload.sessionId) || {};
            configSnapshot = {
                ...currentSnapshot,
                ...(payload.systemPrompt !== undefined ? { baseInstructions: payload.systemPrompt } : {}),
                ...(payload.baseInstructions !== undefined ? { baseInstructions: payload.baseInstructions } : {}),
                ...(payload.instructionMode !== undefined ? { instructionMode: payload.instructionMode } : {}),
                ...(payload.developerInstructions !== undefined ? { developerInstructions: payload.developerInstructions } : {}),
                ...(payload.personality !== undefined ? { personality: payload.personality } : {}),
                ...(payload.reasoningEffort !== undefined ? { reasoningEffort: payload.reasoningEffort } : {}),
                ...(payload.permissionMode ? {
                    permissionMode: payload.permissionMode,
                    approvalPolicy: payload.permissionMode === 'always-approve' ? 'never' : 'on-request',
                } : {}),
                ...(payload.model ? { model: payload.model } : {}),
                ...(payload.toolPolicy ? { toolPolicy: payload.toolPolicy } : {}),
            };
            sessionConfigSnapshots.set(payload.sessionId, configSnapshot);
        }
        return {
            restartRequired: true,
            session: payload.sessionId ? {
                sessionId: payload.sessionId,
                workspaceRoot: payload.workspaceRoot || root,
                configRevision,
                configSnapshot,
            } : null,
            settings: {
                budget: payload.budget || { maxRequestsPerTurn: 8, maxTokensPerTurn: 120000 },
                permissionMode: payload.permissionMode || 'ask',
                ...(payload.model ? { model: payload.model } : {}),
            },
        };
    },
    agentSessionRename: async ({ sessionId, title }) => {
        renamedTopics.push({ sessionId, title });
        topicCatalog = topicCatalog.map((topic) => topic.id === sessionId ? { ...topic, title } : topic);
        return { ok: true, sessionId, title };
    },
    agentSessionArchive: async ({ sessionId }) => ({ ok: true, sessionId }),
    agentSessionRestore: async ({ sessionId }) => ({ restored: true, sessionId }),
    agentSessionDelete: async ({ sessionId }) => ({ deleted: true, sessionId }),
    agentRuntimeExportSession: async (payload) => { exportedSessions.push(payload); return { exported: true }; },
    agentRuntimeListRecoveryOperations: async () => [],
    agentRuntimeListRecoveryCandidates: async () => ({ operations: [], threads: [] }),
    agentRuntimeResolveRecoveryOperation: async () => ({ resolved: true }),
    agentRuntimeSetWorkbenchPresence: (mounted) => { presenceCalls.push(mounted); },
    onAgentRuntimeEvent(callback) {
        eventCallback = callback;
        return () => { unsubscribeCalls += 1; };
    },
};
window.chatAPI.agentRuntimeUpdateSessionConfig = async ({ sessionId, expectedConfigRevision, patch }) => (
    window.chatAPI.agentRuntimeUpdateWorkbenchSettings({ sessionId, expectedConfigRevision, ...(patch || {}) })
);
function canonicalSessionProjection(snapshot) {
    const addNormalized = (value) => {
        const sessionId = String(value?.session?.sessionId || '').trim();
        const threadId = String(value?.session?.threadId || value?.threadId || `thread:${sessionId}`).trim();
        if (!sessionId || value.normalized) return value;
        const blocks = [];
        for (const message of value.messages || []) {
            for (const [index, source] of (message.blocks || []).entries()) {
                const ordinal = Number.isInteger(source.ordinal) ? source.ordinal : index;
                const itemId = String(message.itemId || source.itemId || message.messageId);
                blocks.push({
                    schemaVersion: 2, blockId: `block:${sessionId}:${itemId}:${ordinal}`,
                    sessionId, threadId, turnId: message.turnId || null, itemId,
                    messageId: String(message.messageId), kind: source.kind || 'message',
                    itemType: source.itemType || source.content?.item?.type || null,
                    authority: source.authority || 'codex', status: source.status || message.status || 'completed',
                    sourceOrder: Number(message.sourceOrder || 0), ordinal, content: source.content || {},
                    createdAt: message.createdAt || 1, updatedAt: message.updatedAt || message.createdAt || 1,
                });
            }
        }
        return {
            ...value,
            session: { ...value.session, threadId },
            normalized: {
                schemaVersion: 2, sessionId, threadId,
                projectionRevision: Number(value.projectionRevision || value.projection?.mutationGeneration || 0),
                blocks,
            },
        };
    };
    if (snapshot?.session?.sessionId) return addNormalized(snapshot);
    const sessionId = String(snapshot?.sessionId || '').trim();
    if (!sessionId) return snapshot;
    return addNormalized({
        ...snapshot,
        session: {
            sessionId,
            title: snapshot?.state?.title || '',
            workspaceRoot: snapshot?.state?.workspaceRoot || snapshot?.state?.workspaceRef || '',
            configSnapshot: snapshot?.state?.configSnapshot || (snapshot?.state?.model
                ? { model: snapshot.state.model } : null),
        },
    });
}
const readSessionFixture = window.chatAPI._readSessionFixture;
delete window.chatAPI._readSessionFixture;
window.chatAPI.agentSessionReadProjection = async ({ sessionId, ...payload }) => canonicalSessionProjection(
    await readSessionFixture({ ...payload, sessionId }),
);
window.chatAPI.agentSessionRead = async ({ sessionId, ...payload }) => canonicalSessionProjection(
    await readSessionFixture({ ...payload, sessionId }),
);
window.chatAPI.agentSessionFork = async ({ sessionId }) => ({ sessionId: `${sessionId}-fork`, sessionId: `${sessionId}-fork`, agentId: 'Nova' });

let runtimeEventNumber = 0;
function emitDaemonEvent(event) {
    runtimeEventNumber = Math.max(runtimeEventNumber + 1, Number(event?.sequence) || 0);
    eventCallback({
        eventId: `runtime-event-${runtimeEventNumber}`,
        sessionId: 'topic-in-use',
        timestamp: 1_700_000_000_000 + runtimeEventNumber,
        runtime: 'codex',
        ...event,
        sequence: runtimeEventNumber,
    });
}

const fixtureProjectionRevisionBySession = new Map();
function emitProjectionBlock({
    sessionId = 'topic-in-use', threadId = 'thread-active', method = 'item/updated',
    activity = 'running', messageId, itemId, turnId, kind, content, sourceOrder, status,
}) {
    const revision = Number(fixtureProjectionRevisionBySession.get(sessionId) || 0) + 1;
    fixtureProjectionRevisionBySession.set(sessionId, revision);
    emitDaemonEvent({
        runtime: 'codex', type: 'projection.updated', method, sessionId, threadId, turnId,
        itemId, activity,
        projectionPatch: workbenchProjectionPatch({
            sessionId, threadId, revision, messageId, itemId, turnId, kind, content,
            sourceOrder, status,
        }),
    });
    return revision;
}

await import(`${pathToFileURL(path.join(root, 'modules/ui-system/next-ui-apps.js')).href}?test=${Date.now()}`);
await import(`${pathToFileURL(path.join(root, 'modules/ui-system/vcp-ui.js')).href}?test=${Date.now()}`);

function setSelectedAttachments(value) { selectedAttachments = value; }
function setInteractionQueue(value) { interactionQueue = value; }
function setRuntimeStatus(value) { runtimeStatus = value; }

export { assert, fs, path, pathToFileURL, readCssWithImports, waitFor, root, workbenchProjectionPatch, dom, resizeObservers, TestResizeObserver, revokedAvatarUrl, unsubscribeCalls, eventCallback, runtimeStatus, activeRuntimeSession, presenceCalls, startedTurns, importedAttachment, importedVideoAttachment, selectedAttachments, followUpTurns, steeringTurns, cancelledTurns, interactionQueue, replacedInteractionQueues, resolvedPendingInputs, createdSessions, createdTopics, renamedTopics, compactedSessions, approvalResponses, interactionResponses, openedExternalLinks, workspaceActions, savedWorkbenchSettings, sessionConfigRevisions, sessionConfigSnapshots, savedAvatars, savedAgentProfiles, runtimeTransitions, runtimeEnsures, exportedSessions, mainCreateProxyCalls, sharedCreateActionCalls, releaseAgentCatalog, buildAgentProfiles, agentCatalogGate, topicCatalog, secondaryTopicCatalog, archivedTopicCatalog, topicListRequests, topicSearchRequests, toolCatalogRequests, canonicalSessionProjection, runtimeEventNumber, emitDaemonEvent, fixtureProjectionRevisionBySession, emitProjectionBlock, setSelectedAttachments, setInteractionQueue, setRuntimeStatus, modelUpdateCallback, modelUnsubscribeCalls, refreshModelCalls };
