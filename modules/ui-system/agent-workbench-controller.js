import { createWorkbenchStore } from './agent-workbench-store.js';

// The Workbench deliberately has no Main-process transcript cache.  A live
// session is only an attachment to a durable Rust Topic; renderer reloads and
// compaction rebuild the projection from `read-topic`.
function createWorkbenchController(runtimeApi) {
    const store = createWorkbenchStore();
    let unsubscribeRuntime = null;
    let selectionVersion = 0;
    let snapshotBarrier = null;
    // Renderer-only, bounded cache. Rust remains the durable Topic source;
    // this only prevents a visible flash while `read-topic` revalidates.
    const snapshotCache = new Map();
    const MAX_SNAPSHOT_CACHE_ENTRIES = 16;
    const MAX_SNAPSHOT_CACHE_BYTES = 16 * 1024 * 1024;
    let snapshotCacheBytes = 0;

    function requireApi(name) {
        if (typeof runtimeApi[name] !== 'function') throw new Error(`Runtime API unavailable: ${name}`);
        return runtimeApi[name].bind(runtimeApi);
    }

    function topicPayload(payload, agentId) {
        return agentId === undefined || agentId === null || String(agentId).trim() === ''
            ? payload
            : { ...payload, agentId: String(agentId).trim() };
    }

    function runtimeForTopic(topicId, state = store.getState()) {
        if (!topicId) return null;
        return (Array.isArray(state.activeRuntimes) ? state.activeRuntimes : [])
            .find((runtime) => runtime?.topicId === topicId) || null;
    }

    function selectedRuntime(state = store.getState()) {
        return runtimeForTopic(state.selectedTopic?.topicId, state)
            // Transitional bootstrap compatibility only: the pointer is set
            // by a selected-topic hydration, never used to find another Host.
            || state.attachment || null;
    }

    function projectRuntimeActivity(event) {
        if (!event?.topicId || !event?.sessionId) return;
        const current = store.getState();
        const index = (current.activeRuntimes || []).findIndex((runtime) => (
            runtime.topicId === event.topicId && runtime.sessionId === event.sessionId
        ));
        if (index < 0) return;
        let activity = null;
        if (event.type === 'turn.started') activity = 'running';
        else if (event.type === 'approval.requested') activity = 'awaiting-approval';
        else if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) activity = 'idle';
        if (!activity) return;
        const activeRuntimes = [...current.activeRuntimes];
        activeRuntimes[index] = { ...activeRuntimes[index], activity, activeTurnId: activity === 'running' ? event.turnId : null };
        store.setState({ activeRuntimes });
    }

    async function refreshStatus() {
        const status = await requireApi('agentRuntimeGetStatus')();
        const projection = {
            runtime: {
                state: status?.state || 'unknown',
                worker: status?.worker || null,
                lastError: status?.lastError || null,
            },
            activeRuntimes: Array.isArray(status?.runtimes) ? status.runtimes : [],
        };
        // Approvals are a Renderer-only live projection. Rust events add and
        // remove them; Main must never manufacture an empty list that erases
        // a visible approval during an unrelated status refresh.
        if (Array.isArray(status?.pendingApprovals)) projection.approvals = status.pendingApprovals;
        store.setState(projection);
        return status;
    }

    function historyToProjection(history) {
        const messages = [];
        const tools = new Map();
        if (!Array.isArray(history)) return { messages, tools };
        for (const entry of history) {
            if (entry?.role === 'tool') {
                const toolCallId = String(entry.toolCallId || '').trim();
                if (!toolCallId) continue;
                const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
                tools.set(toolCallId, {
                    toolCallId,
                    turnId: entry.turnId || null,
                    name: entry.toolName || payload.toolName || 'vcp_invoke',
                    state: entry.state === 'failed' ? 'failed' : 'completed',
                    payload,
                    events: [],
                    firstSequence: null,
                    lastSequence: null,
                    firstTimestamp: entry.createdAt || entry.timestamp || 0,
                    lastTimestamp: entry.createdAt || entry.timestamp || 0,
                    snapshotOrdinal: Number.isFinite(Number(entry.snapshotOrdinal)) ? Number(entry.snapshotOrdinal) : null,
                });
                continue;
            }
            const role = entry?.role === 'assistant' ? 'assistant' : 'user';
            const content = typeof entry?.content === 'string'
                ? entry.content
                : Array.isArray(entry?.content)
                    ? entry.content.map((part) => part?.text || '').join('')
                    : '';
            const id = entry?.id || entry?.messageId;
            if (!id) continue;
            messages.push({
                ...entry,
                id,
                role,
                content,
                state: entry?.state || 'complete',
                createdAt: entry?.createdAt || entry?.timestamp || 0,
                // Checkpoints may predate v1.2 sequence fields.  Keep such
                // entries in their durable snapshot order; only live events
                // receive daemon sequence ordering.
                firstSequence: Number.isFinite(Number(entry?.firstSequence)) ? Number(entry.firstSequence) : null,
                lastSequence: Number.isFinite(Number(entry?.lastSequence)) ? Number(entry.lastSequence) : null,
                snapshotOrdinal: Number.isFinite(Number(entry?.snapshotOrdinal)) ? Number(entry.snapshotOrdinal) : null,
            });
        }
        return { messages, tools };
    }

    function cacheSnapshot(topicId, snapshot) {
        if (!topicId || !snapshot) return;
        const projection = historyToProjection(snapshot.history);
        const bytes = Math.min(MAX_SNAPSHOT_CACHE_BYTES, JSON.stringify(snapshot.history || []).length * 2);
        const existing = snapshotCache.get(topicId);
        if (existing) snapshotCacheBytes -= existing.bytes;
        snapshotCache.set(topicId, { projection, snapshotSequence: Number(snapshot.snapshotSequence) || 0, bytes });
        snapshotCacheBytes += bytes;
        while (snapshotCache.size > MAX_SNAPSHOT_CACHE_ENTRIES || snapshotCacheBytes > MAX_SNAPSHOT_CACHE_BYTES) {
            const [oldestTopicId, oldest] = snapshotCache.entries().next().value;
            snapshotCache.delete(oldestTopicId);
            snapshotCacheBytes -= oldest.bytes;
        }
    }

    function cachedProjection(topicId) {
        const cached = snapshotCache.get(topicId);
        if (!cached) return null;
        snapshotCache.delete(topicId);
        snapshotCache.set(topicId, cached);
        return cached.projection;
    }

    function applyPreviewProjection(projection, selectedTopic) {
        const current = store.getState();
        const runtime = runtimeForTopic(selectedTopic.topicId, current);
        store.setState({
            ...projection,
            selectedTopic,
            // This compatibility pointer is scoped to the currently viewed
            // Topic only. It must never stand for a daemon-global attachment.
            attachment: runtime ? { ...runtime } : null,
            activeTurnId: null,
            context: { usedTokens: 0, contextWindow: 0, percentage: 0, compacting: false, summary: '' },
            plan: null,
            backgroundAttachment: null,
        });
    }

    function beginSnapshotBarrier() {
        const barrier = { events: [] };
        snapshotBarrier = barrier;
        return barrier;
    }

    function eventBelongsToTopicRuntime(event, runtime) {
        if (!event || typeof event !== 'object') return false;
        if (event.type?.startsWith('runtime.')) return true;
        return Boolean(runtime?.sessionId
            && event.sessionId === runtime.sessionId
            && event.topicId === runtime.topicId);
    }

    function releaseSnapshotBarrier(barrier, snapshot, runtime) {
        if (snapshotBarrier !== barrier) return;
        snapshotBarrier = null;
        // `snapshotSequence` is supplied with read-topic by the daemon. It is
        // the durable-snapshot waterline: stale buffered events are never
        // replayed by JS after a reload, switch or reconnect.
        const minimumSequence = Number(snapshot?.snapshotSequence);
        for (const event of barrier.events) {
            // Runtime diagnostics are daemon-global rather than a Topic
            // transcript mutation.  The first attachment can legitimately be
            // absent while the control transport is being created, so routing
            // these through the attachment-only snapshot filter would drop
            // the asynchronous ToolBox readiness result and leave the UI at
            // a permanent “checking” state. They remain daemon-authored and
            // reducer-owned; this is not a Main/Renderer probe or inference.
            if (event?.type?.startsWith('runtime.')) {
                store.dispatch(event);
                continue;
            }
            if (event?.type?.startsWith('approval.')) {
                store.dispatch(event);
                continue;
            }
            if (!eventBelongsToTopicRuntime(event, runtime)) continue;
            if (Number.isFinite(minimumSequence) && Number(event.sequence) <= minimumSequence) continue;
            store.dispatch(event);
        }
    }

    async function hydrateTopic(topicId, attachment = null, existingBarrier = null, agentId = undefined) {
        if (!topicId) return null;
        const version = ++selectionVersion;
        const barrier = existingBarrier || beginSnapshotBarrier();
        try {
            const snapshot = await requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
            if (version !== selectionVersion) return null;
            const current = store.getState();
            const active = attachment || runtimeForTopic(topicId, current);
            // `read-topic` is the durable metadata source after a reload or
            // takeover. Main's attachment is deliberately small and can have
            // only a fallback title; promote only non-sensitive Topic fields
            // from the Rust snapshot instead of keeping a stale shell label.
            const durableState = snapshot?.state && typeof snapshot.state === 'object' ? snapshot.state : {};
            const durableAgentId = typeof snapshot?.agentId === 'string' && snapshot.agentId.trim()
                ? snapshot.agentId
                : agentId || active?.agentId || null;
            const nextAttachment = active ? {
                ...active,
                topicId,
                title: typeof durableState.title === 'string' && durableState.title.trim()
                    ? durableState.title : active.title,
                model: typeof durableState.model === 'string' && durableState.model.trim()
                    ? durableState.model : active.model,
                workspaceRoot: typeof durableState.workspaceRef === 'string' && durableState.workspaceRef.trim()
                    ? durableState.workspaceRef : active.workspaceRoot,
                agentId: durableAgentId || active.agentId,
            } : null;
            store.setAttachment(nextAttachment);
            const projection = historyToProjection(snapshot?.history);
            cacheSnapshot(topicId, snapshot);
            store.setState({
                ...projection,
                selectedTopic: {
                    topicId,
                    agentId: durableAgentId,
                    title: nextAttachment?.title || '',
                    model: nextAttachment?.model || '',
                    workspaceRoot: nextAttachment?.workspaceRoot || '',
                    mode: nextAttachment ? 'attached' : 'preview',
                },
                backgroundAttachment: null,
            });
            releaseSnapshotBarrier(barrier, snapshot, nextAttachment);
            return snapshot;
        } catch (error) {
            releaseSnapshotBarrier(barrier, null, store.getState().attachment);
            throw error;
        }
    }

    // Read-only preview of a Topic owned by another client.  Reads the durable
    // checkpoint WITHOUT claiming its session lease, so the other live client
    // is never disturbed.  The renderer shows a read-only banner and requires
    // an explicit takeover before any write is allowed.
    async function previewTopic(topicId, agentId = undefined, metadata = {}) {
        if (!topicId) return null;
        const version = ++selectionVersion;
        const selectedTopic = {
            topicId,
            agentId: agentId || metadata.agentId || null,
            model: metadata.model || '',
            workspaceRoot: metadata.workspaceRef || metadata.workspaceRoot || '',
            title: metadata.title || '',
            mode: 'preview',
        };
        const cached = cachedProjection(topicId);
        if (cached) applyPreviewProjection(cached, selectedTopic);
        const snapshot = await requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
        if (version !== selectionVersion) return null;
        const durableAgentId = typeof snapshot?.agentId === 'string' && snapshot.agentId.trim()
            ? snapshot.agentId
            : selectedTopic.agentId;
        const durableState = snapshot?.state && typeof snapshot.state === 'object' ? snapshot.state : {};
        const resolvedTopic = {
            ...selectedTopic,
            agentId: durableAgentId,
            title: typeof durableState.title === 'string' && durableState.title.trim()
                ? durableState.title : selectedTopic.title,
            model: typeof durableState.model === 'string' && durableState.model.trim()
                ? durableState.model : selectedTopic.model,
            workspaceRoot: typeof durableState.workspaceRef === 'string' && durableState.workspaceRef.trim()
                ? durableState.workspaceRef : selectedTopic.workspaceRoot,
        };
        cacheSnapshot(topicId, snapshot);
        applyPreviewProjection(historyToProjection(snapshot?.history), resolvedTopic);
        return snapshot;
    }

    async function startRuntime() {
        const result = await requireApi('agentRuntimeStart')();
        await refreshStatus();
        return result;
    }

    async function stopRuntime() {
        const result = await requireApi('agentRuntimeStop')();
        store.setState({ activeTurnId: null });
        await refreshStatus();
        return result;
    }

    async function createSession(options = {}) {
        const barrier = beginSnapshotBarrier();
        // Main maps this compatibility API to v1.7 ensure-topic-runtime. It
        // starts only the selected Topic Host and never replaces other Hosts.
        const attachment = await requireApi('agentRuntimeCreateSession')(options);
        store.setAttachment(attachment);
        await refreshStatus();
        if (attachment.topicId) {
            try {
                await hydrateTopic(attachment.topicId, attachment, barrier, attachment.agentId);
            } catch {
                releaseSnapshotBarrier(barrier, null, attachment);
            }
        } else {
            releaseSnapshotBarrier(barrier, null, attachment);
        }
        return attachment;
    }

    async function createTopic(options = {}) {
        const topic = await requireApi('agentRuntimeCreateTopic')(options);
        const topicId = String(topic?.topicId || '').trim();
        const agentId = String(topic?.agentId || options.agent || options.agentId || '').trim();
        if (!topicId || !agentId) throw new Error('Rust Runtime 未返回新 Topic 的完整身份');
        await previewTopic(topicId, agentId, {
            title: topic.title || '',
            model: topic.model || '',
            workspaceRoot: topic.workspaceRoot || '',
        });
        return { ...topic, topicId, agentId };
    }

    async function compactSession(sessionId, instructions) {
        store.setState({ context: { ...store.getState().context, compacting: true, summary: '' } });
        try {
            const result = await requireApi('agentRuntimeCompactSession')({ sessionId, instructions: instructions || undefined });
            if (result?.topicId) await hydrateTopic(result.topicId);
            return result;
        } finally {
            store.setState({ context: { ...store.getState().context, compacting: false } });
        }
    }

    const listTopics = (agentId = undefined) => requireApi('agentRuntimeListTopics')(topicPayload({}, agentId));
    const searchTopics = (query, agentId = undefined, limit = 20) => requireApi('agentRuntimeSearchTopics')(topicPayload({ query, limit }, agentId));
    const searchTopicMessages = (query, topicId, agentId = undefined, limit = 50) => requireApi('agentRuntimeSearchTopicMessages')(topicPayload({ query, topicId, limit }, agentId));
    const getTopicIndexStatus = () => requireApi('agentRuntimeGetTopicIndexStatus')();
    const rebuildTopicIndex = () => requireApi('agentRuntimeRebuildTopicIndex')();
    const readTopic = (topicId, agentId = undefined) => requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
    const takeoverTopic = (topicId, agentId = undefined) => requireApi('agentRuntimeTakeoverTopic')(topicPayload({ topicId }, agentId));
    const renameTopic = (topicId, title, agentId = undefined) => requireApi('agentRuntimeRenameTopic')(topicPayload({ topicId, title }, agentId));
    const deleteTopic = (topicId, agentId = undefined) => requireApi('agentRuntimeDeleteTopic')(topicPayload({ topicId }, agentId));
    const listInteractionQueue = () => {
        const runtime = selectedRuntime();
        if (!runtime) throw new Error('当前 Topic 没有运行中的 Rust Runtime');
        return requireApi('agentRuntimeListInteractionQueue')({ sessionId: runtime.sessionId });
    };
    const replaceInteractionQueue = (interactions) => {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId) throw new Error('请先选择 Agent Session');
        return requireApi('agentRuntimeReplaceInteractionQueue')({ sessionId, interactions });
    };
    const clearInteractionQueue = () => {
        const runtime = selectedRuntime();
        if (!runtime) throw new Error('当前 Topic 没有运行中的 Rust Runtime');
        return requireApi('agentRuntimeClearInteractionQueue')({ sessionId: runtime.sessionId });
    };
    const getWorkbenchSettings = () => requireApi('agentRuntimeGetWorkbenchSettings')();
    const updateWorkbenchSettings = (settings) => requireApi('agentRuntimeUpdateWorkbenchSettings')(settings);
    const selectAttachments = () => {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        return requireApi('agentRuntimeSelectAttachments')({ sessionId });
    };

    async function startTurn(prompt, attachments = []) {
        let current = store.getState();
        const selected = current.selectedTopic;
        if (selected?.topicId && !selectedRuntime(current)) {
            if (!selected.agentId) {
                throw new Error('当前 Topic 缺少 Rust 确认的 Agent 身份，不能猜测并发送。请重新从会话列表打开它。');
            }
            // Runtime activation happens only at send time. The v1.7 daemon
            // creates/reuses this Topic Host without touching other Topics.
            await createSession({
                resume: selected.topicId,
                agent: selected.agentId || undefined,
                model: selected.model || undefined,
                workspaceRoot: selected.workspaceRoot || undefined,
                title: selected.title || undefined,
            });
            current = store.getState();
        }
        const sessionId = selectedRuntime(current)?.sessionId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        // ACK means the daemon accepted this command, not that a durable
        // Topic checkpoint already exists.  Project a renderer-only pending
        // item immediately so the user never sends into an apparently empty
        // conversation; `turn.started`/`user.message` later replaces it with
        // the daemon event identity.  If the pipe breaks first, the item is
        // explicitly unconfirmed and is never automatically replayed.
        const accepted = await requireApi('agentRuntimeStartTurn')({ sessionId, prompt, attachments });
        store.addPendingUserMessage({ turnId: accepted?.turnId, prompt, attachments });
        return accepted;
    }

    async function cancelTurn() {
        const { activeTurnId: turnId } = store.getState();
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId) return null;
        return requireApi('agentRuntimeCancelTurn')({ sessionId, turnId: turnId || undefined });
    }

    // Cancel a single tool call if the backend exposes a per-tool primitive;
    // otherwise fall back to cancelling the whole turn that owns the call.  The
    // Workbench UI only shows the cancel affordance while a tool is in flight.
    async function cancelTool(toolCallId, turnId) {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId || !toolCallId) return null;
        const cancelToolApi = runtimeApi['agentRuntimeCancelTool'];
        if (typeof cancelToolApi === 'function') {
            return cancelToolApi.call(runtimeApi, { sessionId, toolCallId });
        }
        if (!turnId) throw new Error('该工具事件缺少 daemon turnId，不能猜测并取消其他任务');
        return requireApi('agentRuntimeCancelTurn')({ sessionId, turnId });
    }

    async function steerTurn(prompt) {
        const { activeTurnId: turnId } = store.getState();
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId || !turnId) throw new Error('当前没有可插入指令的任务');
        return requireApi('agentRuntimeSteerTurn')({ sessionId, turnId, prompt });
    }

    async function followUpTurn(prompt) {
        const { activeTurnId: turnId } = store.getState();
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId || !turnId) throw new Error('当前没有可追加后续指令的任务');
        return requireApi('agentRuntimeFollowUpTurn')({ sessionId, turnId, prompt });
    }

    async function respondApproval(approval, decision) {
        const result = await requireApi('agentRuntimeRespondApproval')({
            approvalId: approval.approvalId,
            decision,
            sessionId: approval.sessionId,
            turnId: approval.turnId,
            toolCallId: approval.toolCallId,
            argumentsHash: approval.argumentsHash,
        });
        store.setState({ approvals: store.getState().approvals.filter((item) => item.approvalId !== approval.approvalId) });
        return result;
    }

    async function respondToolboxApproval(approvalId, decision) {
        if (!approvalId) throw new Error('ToolBox 后端审批缺少 requestId');
        return requireApi('agentRuntimeRespondApproval')({
            approvalId,
            decision,
            scope: 'toolbox',
        });
    }

    async function initialize() {
        // Subscribe before reading the Rust checkpoint.  The barrier belongs
        // to the Renderer and buffers any live daemon frame that arrives
        // while `read-topic` establishes the durable snapshot waterline.
        const barrier = beginSnapshotBarrier();
        subscribeRuntime();
        runtimeApi.agentRuntimeSetWorkbenchPresence?.(true);
        const status = await refreshStatus().catch(() => null);
        // Ctrl+R restores only an actual selected runtime. A list of active
        // Topic Hosts is not a request to pick one or replay its transcript.
        const selected = store.getState().selectedTopic;
        const runtime = selectedRuntime() || status?.attachment || null;
        const topicId = selected?.topicId || runtime?.topicId || null;
        if (topicId && runtime) {
            await hydrateTopic(topicId, runtime, barrier, selected?.agentId || runtime.agentId);
        } else {
            releaseSnapshotBarrier(barrier, null, runtime);
        }
        return store.getState();
    }

    function subscribeRuntime() {
        if (unsubscribeRuntime || typeof runtimeApi.onAgentRuntimeEvent !== 'function') return;
        if (typeof runtimeApi.onAgentRuntimeEvent === 'function') {
            unsubscribeRuntime = runtimeApi.onAgentRuntimeEvent((event) => {
                if (snapshotBarrier) {
                    snapshotBarrier.events.push(event);
                    return;
                }
                const current = store.getState();
                projectRuntimeActivity(event);
                const selectedTopicId = current.selectedTopic?.topicId;
                const isApproval = event?.type?.startsWith('approval.');
                const isDaemonGlobal = event?.type?.startsWith('runtime.') || event?.type === 'toolbox.ws';
                if (!isApproval && !isDaemonGlobal && event?.topicId && selectedTopicId && event.topicId !== selectedTopicId) {
                    // Do not retain another Topic's transcript. Its sidebar
                    // badge derives from the daemon's active runtime Map.
                    // A debounced status pull is sufficient and cannot lock
                    // the current Topic's composer.
                    void refreshStatus().catch(() => {});
                    return;
                }
                store.dispatch(event);
            });
        }
    }

    function dispose() {
        selectionVersion += 1;
        runtimeApi.agentRuntimeSetWorkbenchPresence?.(false);
        if (typeof unsubscribeRuntime === 'function') unsubscribeRuntime();
        unsubscribeRuntime = null;
    }

    return {
        store, initialize, subscribeRuntime, dispose, refreshStatus, startRuntime, stopRuntime,
        createSession, createTopic, compactSession, hydrateTopic, previewTopic,
        listTopics, searchTopics, searchTopicMessages, getTopicIndexStatus, rebuildTopicIndex,
        readTopic, takeoverTopic, renameTopic, deleteTopic,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue,
        getWorkbenchSettings, updateWorkbenchSettings, selectAttachments,
        startTurn, steerTurn, followUpTurn, cancelTurn, cancelTool, respondApproval,
        respondToolboxApproval,
    };
}

export { createWorkbenchController };
