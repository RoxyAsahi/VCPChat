import { createWorkbenchStore } from './agent-workbench-store.js';

// The Workbench deliberately has no Main-process transcript cache.  A live
// session is only an attachment to a durable Rust Topic; renderer reloads and
// compaction rebuild the projection from `read-topic`.
function createWorkbenchController(runtimeApi) {
    const store = createWorkbenchStore();
    let unsubscribeRuntime = null;
    let selectionVersion = 0;
    let snapshotBarrier = null;

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

    function historyToMessages(history) {
        if (!Array.isArray(history)) return [];
        return history.flatMap((entry) => {
            const role = entry?.role === 'assistant' ? 'assistant' : 'user';
            const content = typeof entry?.content === 'string'
                ? entry.content
                : Array.isArray(entry?.content)
                    ? entry.content.map((part) => part?.text || '').join('')
                    : '';
            const id = entry?.id || entry?.messageId;
            if (!id) return [];
            return [{
                ...entry,
                id,
                role,
                content,
                state: entry?.state || 'complete',
                createdAt: entry?.createdAt || entry?.timestamp || 0,
            }];
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
            store.setState({ messages: historyToMessages(snapshot?.history) });
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
    async function previewTopic(topicId, agentId = undefined) {
        if (!topicId) return null;
        const version = ++selectionVersion;
        const snapshot = await requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
        if (version !== selectionVersion) return null;
        store.setState({ messages: historyToMessages(snapshot?.history) });
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

    async function startTurn(prompt) {
        const sessionId = store.getState().attachment?.sessionId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        // ACK only accepts the command. The daemon's turn.started event is
        // the sole source that may create a live-turn projection.
        return requireApi('agentRuntimeStartTurn')({ sessionId, prompt });
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
        listTopics, readTopic, takeoverTopic, renameTopic, deleteTopic,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue,
        getWorkbenchSettings, updateWorkbenchSettings,
        startTurn, steerTurn, followUpTurn, cancelTurn, cancelTool, respondApproval,
    };
}

export { createWorkbenchController };
