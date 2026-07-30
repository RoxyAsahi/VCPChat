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

    async function refreshStatus() {
        const status = await requireApi('agentRuntimeGetStatus')();
        const projection = {
            runtime: {
                state: status?.state || 'unknown',
                worker: status?.worker || null,
                lastError: status?.lastError || null,
            },
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
        const backgroundBusy = Boolean(current.attachment?.sessionId
            && current.attachment.topicId !== selectedTopic.topicId
            && (current.activeTurnId || current.approvals.length));
        store.setState({
            ...projection,
            selectedTopic,
            activeTurnId: null,
            context: { usedTokens: 0, contextWindow: 0, percentage: 0, compacting: false, summary: '' },
            plan: null,
            backgroundAttachment: current.attachment?.sessionId && current.attachment.topicId !== selectedTopic.topicId
                ? { ...current.attachment, busy: backgroundBusy }
                : null,
        });
    }

    function beginSnapshotBarrier() {
        const barrier = { events: [] };
        snapshotBarrier = barrier;
        return barrier;
    }

    function eventBelongsToAttachment(event, attachment) {
        if (!event || typeof event !== 'object') return false;
        if (event.type?.startsWith('runtime.')) return true;
        return Boolean(attachment?.sessionId
            && event.sessionId === attachment.sessionId
            && event.topicId === attachment.topicId);
    }

    function releaseSnapshotBarrier(barrier, snapshot, attachment) {
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
            if (!eventBelongsToAttachment(event, attachment)) continue;
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
            const active = attachment || (current.attachment?.topicId === topicId ? current.attachment : null);
            const nextAttachment = active ? { ...active, topicId } : null;
            store.setAttachment(nextAttachment);
            const projection = historyToProjection(snapshot?.history);
            cacheSnapshot(topicId, snapshot);
            store.setState({
                ...projection,
                selectedTopic: { topicId, agentId, mode: 'attached' },
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
        cacheSnapshot(topicId, snapshot);
        applyPreviewProjection(historyToProjection(snapshot?.history), selectedTopic);
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
        const attachment = await requireApi('agentRuntimeCreateSession')(options);
        // `create-session` creates a live attachment before the first safe
        // checkpoint exists.  A fresh Rust Topic can therefore legitimately
        // reject/read as empty here.  Install the attachment first so that
        // this expected empty-snapshot path never leaves the composer in the
        // disconnected state; history remains deliberately empty until Rust
        // has a durable snapshot to return.
        store.setAttachment(attachment);
        // Session creation changes the daemon lifecycle from the control
        // plane's point of view.  Refresh it explicitly instead of waiting for
        // a diagnostic event: `session.attached` is informational and is not
        // a durable replacement for the runtime status contract.
        await refreshStatus();
        // A newly-created Topic has no checkpoint until its first safe write.
        // That is valid: render an empty projection, but never invent history.
        if (attachment.topicId) {
            try {
                await hydrateTopic(attachment.topicId, attachment, barrier);
            } catch {
                // Keep the real attachment and release only the events that
                // belong to it.  Do not synthesize a transcript from Main.
                releaseSnapshotBarrier(barrier, null, attachment);
            }
        } else {
            releaseSnapshotBarrier(barrier, null, attachment);
        }
        return attachment;
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
    const listInteractionQueue = () => requireApi('agentRuntimeListInteractionQueue')();
    const replaceInteractionQueue = (interactions) => {
        const sessionId = store.getState().attachment?.sessionId;
        if (!sessionId) throw new Error('请先选择 Agent Session');
        return requireApi('agentRuntimeReplaceInteractionQueue')({ sessionId, interactions });
    };
    const clearInteractionQueue = () => requireApi('agentRuntimeClearInteractionQueue')();
    const getWorkbenchSettings = () => requireApi('agentRuntimeGetWorkbenchSettings')();
    const updateWorkbenchSettings = (settings) => requireApi('agentRuntimeUpdateWorkbenchSettings')(settings);
    const selectAttachments = () => {
        const sessionId = store.getState().attachment?.sessionId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        return requireApi('agentRuntimeSelectAttachments')({ sessionId });
    };

    async function startTurn(prompt, attachments = []) {
        let current = store.getState();
        const selected = current.selectedTopic;
        if (selected?.mode === 'preview' && current.backgroundAttachment?.busy) {
            throw new Error('另一个 Agent Topic 仍在运行或等待审批；当前仅可只读查看。');
        }
        if (selected?.topicId && selected.topicId !== current.attachment?.topicId) {
            // `agentRuntimeCreateSession` now maps to Rust's in-process
            // switch-attachment command.  Do this only at send time, never
            // when the sidebar row was selected.
            await createSession({
                resume: selected.topicId,
                agent: selected.agentId || undefined,
                model: selected.model || undefined,
                workspaceRoot: selected.workspaceRoot || undefined,
                title: selected.title || undefined,
            });
            current = store.getState();
        }
        const sessionId = current.attachment?.sessionId;
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
        const sessionId = store.getState().attachment?.sessionId;
        if (!sessionId) return null;
        return requireApi('agentRuntimeCancelTurn')({ sessionId, turnId: turnId || undefined });
    }

    // Cancel a single tool call if the backend exposes a per-tool primitive;
    // otherwise fall back to cancelling the whole turn that owns the call.  The
    // Workbench UI only shows the cancel affordance while a tool is in flight.
    async function cancelTool(toolCallId, turnId) {
        const sessionId = store.getState().attachment?.sessionId;
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
        const sessionId = store.getState().attachment?.sessionId;
        if (!sessionId || !turnId) throw new Error('当前没有可插入指令的任务');
        return requireApi('agentRuntimeSteerTurn')({ sessionId, turnId, prompt });
    }

    async function followUpTurn(prompt) {
        const { activeTurnId: turnId } = store.getState();
        const sessionId = store.getState().attachment?.sessionId;
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
        // Ctrl+R leaves Electron Main and its daemon alive. Restore the
        // existing attachment from the Rust Topic while the Renderer barrier
        // buffers already-subscribed live daemon events.
        if (status?.attachment?.topicId) {
            await hydrateTopic(status.attachment.topicId, status.attachment, barrier);
        } else {
            releaseSnapshotBarrier(barrier, null, store.getState().attachment);
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
                const selectedTopicId = current.selectedTopic?.topicId;
                const isApproval = event?.type?.startsWith('approval.');
                const isDaemonGlobal = event?.type?.startsWith('runtime.');
                if (!isApproval && !isDaemonGlobal && event?.topicId && selectedTopicId && event.topicId !== selectedTopicId) {
                    // Do not retain another Topic's transcript in the
                    // Renderer.  A minimal badge is enough to say that the
                    // one Rust attachment is still busy in the background.
                    const busy = event.type === 'turn.started'
                        ? true
                        : ['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)
                            ? false
                            : current.backgroundAttachment?.busy === true;
                    store.setState({
                        backgroundAttachment: current.attachment?.sessionId
                            ? { ...current.attachment, busy }
                            : current.backgroundAttachment,
                    });
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
        createSession, compactSession, hydrateTopic, previewTopic,
        listTopics, searchTopics, searchTopicMessages, getTopicIndexStatus, rebuildTopicIndex,
        readTopic, takeoverTopic, renameTopic, deleteTopic,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue,
        getWorkbenchSettings, updateWorkbenchSettings, selectAttachments,
        startTurn, steerTurn, followUpTurn, cancelTurn, cancelTool, respondApproval,
        respondToolboxApproval,
    };
}

export { createWorkbenchController };
