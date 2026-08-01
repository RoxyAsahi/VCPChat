import { createWorkbenchStore } from './agent-workbench-store.js';
import { createAgentSessionUiState, reconcileAgentSessionUiState, reduceAgentSessionUiState } from './agent-session-state.js';

// The Workbench deliberately has no Main-process transcript cache. SQLite is
// the durable presentation projection while Codex Thread Store remains the
// execution/context authority.
function createWorkbenchController(runtimeApi) {
    const store = createWorkbenchStore();
    let unsubscribeRuntime = null;
    let selectionVersion = 0;
    let snapshotBarrier = null;
    // Renderer-only, bounded cache. SQLite is the durable presentation source;
    // this only prevents a visible flash while a background `thread/read`
    // revalidates the projection.
    const snapshotCache = new Map();
    const MAX_SNAPSHOT_CACHE_ENTRIES = 16;
    const MAX_SNAPSHOT_CACHE_BYTES = 16 * 1024 * 1024;
    let snapshotCacheBytes = 0;
    // A `thread/read` reply is allowed to replace a local SQLite projection
    // only when no newer live item patch for that Session has reached the
    // renderer.  SelectionVersion handles A -> B navigation; this counter
    // handles live A deltas arriving while A's reconcile is in flight.
    const liveProjectionRevision = new Map();
    const sessionWarmPromises = new Map();

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
                runtime: status?.runtime || 'unknown',
                worker: status?.worker || null,
                lastError: status?.lastError || null,
            },
            activeRuntimes: Array.isArray(status?.runtimes) ? status.runtimes : [],
            sessionUi: reconcileAgentSessionUiState(
                store.getState().sessionUi,
                Array.isArray(status?.sessions) ? status.sessions : [],
            ),
        };
        // Approvals are a Renderer-only live projection. Rust events add and
        // remove them; Main must never manufacture an empty list that erases
        // a visible approval during an unrelated status refresh.
        // These lists are independently optional during restart/compatibility
        // refreshes.  Never let a status response that merely adds interaction
        // identities erase an approval already delivered as a live event.
        if (Array.isArray(status?.pendingApprovals)) projection.approvals = status.pendingApprovals;
        if (Array.isArray(status?.pendingInteractions)) projection.interactions = status.pendingInteractions;
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

    function hasApi(name) {
        return typeof runtimeApi[name] === 'function';
    }

    function readLocalProjection(payload) {
        // Codex uses the dedicated SQLite-only IPC.  The fallback keeps the
        // archived Rust controller tests and compatibility runtime working,
        // but it is deliberately not used by the Codex product path.
        return hasApi('agentRuntimeReadProjection')
            ? runtimeApi.agentRuntimeReadProjection(payload)
            : requireApi('agentRuntimeReadTopic')(payload);
    }

    function ensureSessionRuntime(sessionId, reason = 'selection') {
        const id = String(sessionId || '').trim();
        if (!id) return Promise.reject(new Error('Session runtime warm requires sessionId'));
        if (sessionWarmPromises.has(id)) return sessionWarmPromises.get(id);
        if (!hasApi('agentRuntimeEnsureSessionRuntime') && reason !== 'send') {
            return Promise.resolve(null);
        }
        const call = hasApi('agentRuntimeEnsureSessionRuntime')
            ? runtimeApi.agentRuntimeEnsureSessionRuntime({ sessionId: id, reason })
            : requireApi('agentRuntimeCreateSession')({ resume: id });
        const promise = Promise.resolve(call)
            .then(async (runtime) => {
                await refreshStatus().catch(() => null);
                return runtime;
            })
            .finally(() => sessionWarmPromises.delete(id));
        sessionWarmPromises.set(id, promise);
        return promise;
    }

    function warmSelectedSession(sessionId) {
        void ensureSessionRuntime(sessionId, 'selection').catch((error) => {
            const current = store.getState();
            if (current.selectedTopic?.topicId !== sessionId) return;
            store.setState({ notice: {
                level: 'warning',
                text: `会话后台预热失败；发送时将重试：${error.message}`,
            } });
        });
    }

    function codexSnapshotToProjection(snapshot) {
        if (!Array.isArray(snapshot?.messages)) return historyToProjection(snapshot?.history);
        const messages = [];
        const tools = new Map();
        const markerObservations = [];
        let plan = null;
        const projectionActivity = snapshot?.projection?.activity || {};
        const restoredUsage = projectionActivity.usage || {};
        const restoredCompaction = projectionActivity.compaction || {};
        const usageSource = ['real', 'estimated', 'unknown'].includes(restoredUsage.source) ? restoredUsage.source : 'unknown';
        const restoredUsedTokens = Number(restoredUsage.usedTokens ?? restoredUsage.totalTokens) || 0;
        const restoredContextWindow = Number(restoredUsage.contextWindow) || 0;
        const context = {
            ...restoredUsage,
            source: usageSource,
            usageAvailable: ['real', 'estimated'].includes(usageSource)
                && ['totalTokens', 'usedTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
                    .some((key) => Number.isFinite(Number(restoredUsage[key]))),
            usedTokens: restoredUsedTokens,
            contextWindow: restoredContextWindow,
            percentage: restoredContextWindow ? Math.min(100, Math.round((restoredUsedTokens / restoredContextWindow) * 100)) : 0,
            compacting: restoredCompaction.state === 'started',
            compactionState: restoredCompaction.state || null,
            summary: restoredCompaction.summary || '',
            compactionError: restoredCompaction.error || '',
        };
        const textFromContent = (content = {}) => {
            const parts = Array.isArray(content.parts) ? content.parts : [];
            const summary = Array.isArray(content.summary) ? content.summary : [];
            const detail = Array.isArray(content.content) ? content.content : [];
            return content.text
                || parts.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
                || summary.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
                || detail.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
                || '';
        };
        const messageState = (status) => {
            if (status === 'completed') return 'complete';
            if (['inProgress', 'running', 'started'].includes(status)) return 'streaming';
            return status || 'complete';
        };
        for (const entry of snapshot.messages) {
            const reasoning = [];
            for (const block of entry.blocks || []) {
                const blockId = block.blockId || `${entry.messageId}:${block.ordinal || 0}`;
                if (block.kind === 'observation' && block.content?.marker) {
                    const marker = block.content.marker;
                    markerObservations.push({
                        id: `marker:${entry.messageId}:${block.ordinal || 0}`,
                        kind: String(marker.kind || 'unknown'),
                        summary: typeof marker.summary === 'string' ? marker.summary : '',
                        detail: typeof marker.detail === 'string' ? marker.detail : '',
                        messageId: entry.messageId,
                        turnId: entry.turnId || null,
                        timestamp: entry.updatedAt || entry.createdAt || null,
                    });
                    continue;
                }
                if (block.kind === 'tool') {
                    const item = block.content?.item || {};
                    tools.set(entry.itemId, {
                        toolCallId: entry.itemId,
                        turnId: entry.turnId || null,
                        name: item.tool || item.command || item.type || 'codex_tool',
                        state: entry.status === 'completed' ? 'completed'
                            : entry.status === 'failed' ? 'failed' : 'running',
                        payload: block.content || {},
                        events: [],
                        firstSequence: null,
                        lastSequence: null,
                        firstTimestamp: entry.createdAt || 0,
                        lastTimestamp: entry.updatedAt || entry.createdAt || 0,
                        snapshotOrdinal: entry.sourceOrder || null,
                    });
                    continue;
                }
                if (block.kind === 'attachment') {
                    const item = block.content?.item || block.content || {};
                    messages.push({
                        id: blockId,
                        messageId: entry.messageId,
                        itemId: entry.itemId,
                        turnId: entry.turnId || null,
                        role: 'assistant',
                        content: item.message || '',
                        attachments: [{
                            id: blockId,
                            itemId: entry.itemId,
                            kind: item.type === 'imageView' ? 'image' : (item.kind || 'file'),
                            displayName: item.path || item.url || item.name || 'Codex 资源',
                            path: item.path || null,
                            url: item.url || null,
                        }],
                        state: messageState(entry.status),
                        createdAt: entry.createdAt || 0,
                        snapshotOrdinal: entry.sourceOrder || null,
                    });
                    continue;
                }
                if (block.kind === 'reasoning') {
                    const text = textFromContent(block.content);
                    if (text) reasoning.push({ ordinal: Number(block.ordinal) || 0, text });
                    continue;
                }
                if (block.kind === 'observation' && typeof block.content?.text === 'string'
                    && !block.content?.phase && entry.role === 'assistant') {
                    plan = { text: block.content.text, turnId: entry.turnId || null,
                        itemId: entry.itemId, updatedAt: entry.updatedAt || entry.createdAt || null };
                    continue;
                }
                if (block.kind === 'observation' && block.content?.phase) {
                    context.compactionState = block.content.phase;
                    context.compacting = block.content.phase === 'inProgress';
                    context.summary = block.content.text || context.summary;
                    continue;
                }
                const content = textFromContent(block.content);
                const fallbackContent = content || (block.content?.item
                    ? `Codex ${block.content.item.type || 'unknown'} Item\n\n${JSON.stringify(block.content.item, null, 2).slice(0, 16_384)}`
                    : '');
                if (!fallbackContent) continue;
                messages.push({
                    id: blockId,
                    messageId: entry.messageId,
                    itemId: entry.itemId,
                    turnId: entry.turnId || null,
                    role: entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'assistant',
                    content: fallbackContent,
                    state: messageState(entry.status),
                    createdAt: entry.createdAt || 0,
                    firstSequence: null,
                    lastSequence: null,
                    snapshotOrdinal: entry.sourceOrder || null,
                });
            }
            if (reasoning.length) {
                messages.push({
                    id: entry.messageId,
                    messageId: entry.messageId,
                    itemId: entry.itemId,
                    turnId: entry.turnId || null,
                    role: 'assistant',
                    content: '',
                    reasoning: reasoning.sort((left, right) => left.ordinal - right.ordinal)
                        .map((part) => part.text).join('\n'),
                    state: messageState(entry.status),
                    createdAt: entry.createdAt || 0,
                    firstSequence: null,
                    lastSequence: null,
                    snapshotOrdinal: entry.sourceOrder || null,
                });
            }
        }
        return { messages, tools, markerObservations, plan, context };
    }

    function applyCodexProjectionMessage(entry) {
        if (!entry) return;
        const patch = codexSnapshotToProjection({ messages: [entry] });
        const current = store.getState();
        const messages = [...current.messages];
        for (const candidate of patch.messages) {
            const durableIndex = messages.findIndex((message) => message.id === candidate.id);
            // `turn/start` is allowed to render a clearly-labelled temporary
            // user row before App Server has emitted its authoritative item.
            // Once that item arrives it must *replace* the temporary row.  A
            // Codex item id is intentionally not guessed by the Renderer, so
            // the only safe bridge identity is the turn id supplied by both
            // the command ACK and the item notification.
            const pendingIndex = durableIndex < 0 && candidate.role === 'user' && candidate.turnId
                ? messages.findIndex((message) => (
                    message.role === 'user'
                    && message.turnId === candidate.turnId
                    && String(message.id || '').startsWith('pending-user:')
                ))
                : -1;
            if (durableIndex >= 0) {
                messages[durableIndex] = { ...messages[durableIndex], ...candidate };
            } else if (pendingIndex >= 0) {
                messages[pendingIndex] = {
                    ...messages[pendingIndex],
                    ...candidate,
                    state: candidate.state === 'inProgress' ? 'pending' : candidate.state,
                    deliveryState: 'confirmed',
                    deliveryDetail: '',
                };
            } else {
                messages.push(candidate);
            }
        }
        const tools = new Map(current.tools);
        for (const [toolCallId, tool] of patch.tools) {
            tools.set(toolCallId, { ...(tools.get(toolCallId) || {}), ...tool });
        }
        const markerObservations = [...(current.markerObservations || [])];
        for (const marker of patch.markerObservations || []) {
            const index = markerObservations.findIndex((item) => item.id === marker.id);
            if (index >= 0) markerObservations[index] = marker;
            else markerObservations.push(marker);
        }
        store.setState({ messages, tools, markerObservations: markerObservations.slice(-100),
            ...(patch.plan ? { plan: patch.plan } : {}),
            ...(patch.context && Object.keys(patch.context).length ? { context: { ...current.context, ...patch.context } } : {}) });
    }

    function applyCodexRuntimeEvent(event) {
        const current = store.getState();
        const runtimes = [...(current.activeRuntimes || [])];
        const index = runtimes.findIndex((runtime) => runtime.sessionId === event.sessionId);
        if (index >= 0) {
            runtimes[index] = {
                ...runtimes[index],
                activity: event.activity || runtimes[index].activity,
                activeTurnId: event.activity === 'running'
                    ? (event.turnId || runtimes[index].activeTurnId)
                    : null,
            };
        }
        const selected = event.topicId === current.selectedTopic?.topicId;
        store.setState({
            activeRuntimes: runtimes,
            ...(selected ? { activeTurnId: event.activity === 'running' ? event.turnId : null } : {}),
        });
        if (event.projectionMessage && event.topicId) {
            liveProjectionRevision.set(event.topicId, (liveProjectionRevision.get(event.topicId) || 0) + 1);
        }
        if (selected && event.projectionMessage) applyCodexProjectionMessage(event.projectionMessage);
        applySessionUiEvent(event);
    }

    function applySessionUiEvent(event) {
        const current = store.getState();
        const method = event?.method;
        const mappedType = method === 'turn/started' ? 'turn.started'
            : method === 'turn/completed' ? 'turn.completed'
                : event?.type;
        const sessionEvent = {
            ...event,
            type: mappedType,
            requestId: event?.payload?.approval?.approvalId || event?.approvalId || null,
        };
        const reduced = reduceAgentSessionUiState(current.sessionUi || createAgentSessionUiState(), sessionEvent);
        if (reduced !== current.sessionUi) store.setState({ sessionUi: reduced });
    }

    function cacheSnapshot(topicId, snapshot) {
        if (!topicId || !snapshot) return;
        const projection = codexSnapshotToProjection(snapshot);
        const bytes = Math.min(MAX_SNAPSHOT_CACHE_BYTES, JSON.stringify(snapshot.messages || snapshot.history || []).length * 2);
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
            context: projection.context || current.context,
            plan: projection.plan || null,
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

    function applyHydratedSnapshot(topicId, snapshot, attachment, agentId) {
        const current = store.getState();
        const active = attachment || runtimeForTopic(topicId, current);
        // `read-topic` / `read-projection` is the durable metadata source
        // after a reload. Main's runtime status intentionally has only a
        // small identity shell, never a transcript cache.
        const durableState = snapshot?.session && typeof snapshot.session === 'object'
            ? snapshot.session
            : snapshot?.state && typeof snapshot.state === 'object' ? snapshot.state : {};
        const durableAgentId = typeof snapshot?.session?.agentId === 'string' && snapshot.session.agentId.trim()
            ? snapshot.session.agentId
            : typeof snapshot?.agentId === 'string' && snapshot.agentId.trim() ? snapshot.agentId
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
            configSnapshot: durableState.configSnapshot || active.configSnapshot || null,
        } : null;
        store.setAttachment(nextAttachment);
        const projection = codexSnapshotToProjection(snapshot);
        cacheSnapshot(topicId, snapshot);
        store.setState({
            ...projection,
            selectedTopic: {
                topicId,
                agentId: durableAgentId,
                title: nextAttachment?.title || '',
                model: nextAttachment?.model || '',
                workspaceRoot: nextAttachment?.workspaceRoot || '',
                configSnapshot: durableState.configSnapshot || null,
                mode: nextAttachment ? 'attached' : 'preview',
            },
            backgroundAttachment: null,
        });
        return nextAttachment;
    }

    async function reconcileHydratedTopic(topicId, attachment, agentId, version, revisionAtStart) {
        try {
            const snapshot = await requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
            const current = store.getState();
            if (version !== selectionVersion || current.selectedTopic?.topicId !== topicId) return null;
            if ((liveProjectionRevision.get(topicId) || 0) !== revisionAtStart) return null;
            applyHydratedSnapshot(topicId, snapshot, attachment || runtimeForTopic(topicId), agentId);
            return snapshot;
        } catch (_error) {
            // The SQLite projection remains visible; Main records a sync
            // error and only a confirmed Thread-not-found becomes orphaned.
            return null;
        }
    }

    async function hydrateTopic(topicId, attachment = null, existingBarrier = null, agentId = undefined) {
        if (!topicId) return null;
        const version = ++selectionVersion;
        const barrier = existingBarrier || beginSnapshotBarrier();
        if (hasApi('agentRuntimeReadProjection')) {
            try {
                const localSnapshot = await readLocalProjection(topicPayload({ topicId }, agentId));
                if (version !== selectionVersion) {
                    releaseSnapshotBarrier(barrier, null, attachment || runtimeForTopic(topicId));
                    return null;
                }
                const nextAttachment = applyHydratedSnapshot(topicId, localSnapshot, attachment, agentId);
                releaseSnapshotBarrier(barrier, localSnapshot, nextAttachment);
                warmSelectedSession(topicId);
                const revisionAtStart = liveProjectionRevision.get(topicId) || 0;
                void reconcileHydratedTopic(topicId, attachment, agentId, version, revisionAtStart);
                return localSnapshot;
            } catch (error) {
                releaseSnapshotBarrier(barrier, null, attachment || runtimeForTopic(topicId));
                throw error;
            }
        }
        try {
            const snapshot = await requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
            if (version !== selectionVersion) {
                releaseSnapshotBarrier(barrier, null, attachment || runtimeForTopic(topicId));
                return null;
            }
            const nextAttachment = applyHydratedSnapshot(topicId, snapshot, attachment, agentId);
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
        const barrier = beginSnapshotBarrier();
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
        let localSnapshot;
        try {
            // This is the only awaited cold-open read in the Codex path. It
            // is a local SQLite query and must not request a Codex Thread.
            localSnapshot = await readLocalProjection(topicPayload({ topicId }, agentId));
            if (version !== selectionVersion) {
                releaseSnapshotBarrier(barrier, null, runtimeForTopic(topicId));
                return null;
            }
            const resolvedTopic = resolvePreviewTopic(localSnapshot, selectedTopic);
            cacheSnapshot(topicId, localSnapshot);
            applyPreviewProjection(codexSnapshotToProjection(localSnapshot), resolvedTopic);
            releaseSnapshotBarrier(barrier, localSnapshot, runtimeForTopic(topicId));
            warmSelectedSession(topicId);
            // Deliberately detached: navigation is complete before App Server
            // reconciliation begins. The guards in reconcilePreviewTopic make
            // an A response harmless after the user selects B.
            const revisionAtStart = liveProjectionRevision.get(topicId) || 0;
            void reconcilePreviewTopic(topicId, agentId, resolvedTopic, version, revisionAtStart);
            return localSnapshot;
        } catch (error) {
            releaseSnapshotBarrier(barrier, null, runtimeForTopic(topicId));
            throw error;
        }
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
        if (!topicId || !agentId) throw new Error('Codex Runtime 未返回新会话的完整身份');
        await previewTopic(topicId, agentId, {
            title: topic.title || '',
            model: topic.model || '',
            workspaceRoot: topic.workspaceRoot || '',
        });
        return { ...topic, topicId, agentId };
    }

    function resolvePreviewTopic(snapshot, selectedTopic) {
        const durableAgentId = typeof snapshot?.session?.agentId === 'string' && snapshot.session.agentId.trim()
            ? snapshot.session.agentId
            : typeof snapshot?.agentId === 'string' && snapshot.agentId.trim() ? snapshot.agentId
                : selectedTopic.agentId;
        const durableState = snapshot?.session && typeof snapshot.session === 'object'
            ? snapshot.session
            : snapshot?.state && typeof snapshot.state === 'object' ? snapshot.state : {};
        return {
            ...selectedTopic,
            agentId: durableAgentId,
            title: typeof durableState.title === 'string' && durableState.title.trim()
                ? durableState.title : selectedTopic.title,
            model: typeof durableState.model === 'string' && durableState.model.trim()
                ? durableState.model : selectedTopic.model,
            workspaceRoot: typeof durableState.workspaceRef === 'string' && durableState.workspaceRef.trim()
                ? durableState.workspaceRef : selectedTopic.workspaceRoot,
            configSnapshot: durableState.configSnapshot || null,
        };
    }

    async function reconcilePreviewTopic(topicId, agentId, selectedTopic, version, revisionAtStart) {
        try {
            const snapshot = await requireApi('agentRuntimeReadTopic')(topicPayload({ topicId }, agentId));
            const current = store.getState();
            if (version !== selectionVersion || current.selectedTopic?.topicId !== topicId) return null;
            // Do not let an older `thread/read` snapshot erase a delta/tool
            // patch that arrived after reconciliation began.  The next view
            // entry will perform a fresh SQLite read and reconcile again.
            if ((liveProjectionRevision.get(topicId) || 0) !== revisionAtStart) return null;
            cacheSnapshot(topicId, snapshot);
            applyPreviewProjection(codexSnapshotToProjection(snapshot), resolvePreviewTopic(snapshot, selectedTopic));
            return snapshot;
        } catch (_error) {
            // A background sync failure preserves the SQLite projection. Main
            // records the sync error; only an explicit Thread-not-found may
            // make the Session orphaned.
            return null;
        }
    }

    async function forkSession({ sessionId, turnId, title } = {}) {
        const sourceSessionId = sessionId || selectedRuntime()?.sessionId || store.getState().selectedTopic?.topicId;
        if (!sourceSessionId) throw new Error('请先选择要创建分支的会话');
        const fork = await requireApi('agentRuntimeForkSession')({ sessionId: sourceSessionId, turnId, title });
        const topicId = fork?.topicId || fork?.sessionId;
        if (!topicId) throw new Error('Codex thread/fork 未返回新会话身份');
        await previewTopic(topicId, fork.agentId, fork);
        return fork;
    }

    async function compactSession(sessionId, instructions) {
        store.setState({ context: { ...store.getState().context, compacting: true, summary: '' } });
        try {
            const result = await requireApi('agentRuntimeCompactSession')({ sessionId, instructions: instructions || undefined });
            // Codex returns its reconciled projection snapshot with sessionId;
            // the Rust compatibility runtime may also return sessionId but its
            // preview flow remains topicId-based and must not be disturbed.
            const refreshedTopicId = result?.topicId || (result?.snapshot ? (result?.sessionId || sessionId) : null);
            if (refreshedTopicId) await hydrateTopic(refreshedTopicId);
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
    const archiveSession = (sessionId) => requireApi('agentRuntimeCloseSession')({ sessionId });
    const restoreSession = (sessionId) => requireApi('agentRuntimeRestoreSession')({ sessionId });
    const setSessionPinned = (sessionId, pinned) => requireApi('agentRuntimeSetSessionPinned')({ sessionId, pinned });
    const listInteractionQueue = () => {
        const runtime = selectedRuntime();
        if (!runtime) throw new Error('当前会话没有运行中的 Codex Thread');
        return requireApi('agentRuntimeListInteractionQueue')({ sessionId: runtime.sessionId });
    };
    const replaceInteractionQueue = (interactions) => {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId) throw new Error('请先选择 Agent Session');
        return requireApi('agentRuntimeReplaceInteractionQueue')({ sessionId, interactions });
    };
    const clearInteractionQueue = () => {
        const runtime = selectedRuntime();
        if (!runtime) throw new Error('当前会话没有运行中的 Codex Thread');
        return requireApi('agentRuntimeClearInteractionQueue')({ sessionId: runtime.sessionId });
    };
    const getWorkbenchSettings = () => requireApi('agentRuntimeGetWorkbenchSettings')();
    async function updateWorkbenchSettings(settings) {
        const result = await requireApi('agentRuntimeUpdateWorkbenchSettings')(settings);
        const savedSession = result?.session;
        const current = store.getState();
        if (savedSession?.sessionId && current.selectedTopic?.topicId === savedSession.sessionId) {
            const configSnapshot = savedSession.configSnapshot || null;
            const model = configSnapshot?.model || savedSession.model || current.selectedTopic.model || '';
            store.setState({
                selectedTopic: { ...current.selectedTopic, model, configSnapshot },
                attachment: current.attachment?.sessionId === savedSession.sessionId
                    ? { ...current.attachment, model, configSnapshot }
                    : current.attachment,
            });
        }
        return result;
    }
    const selectAttachments = () => {
        const sessionId = selectedRuntime()?.sessionId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        return requireApi('agentRuntimeSelectAttachments')({ sessionId });
    };

    async function startTurn(prompt, attachments = []) {
        let current = store.getState();
        const selected = current.selectedTopic;
        let runtime = selectedRuntime(current);
        if (selected?.topicId && !runtime) {
            if (!selected.agentId) {
                throw new Error('当前会话缺少持久化的助手身份，不能猜测并发送。请重新从会话列表打开它。');
            }
            runtime = await ensureSessionRuntime(selected.topicId, 'send');
            current = store.getState();
        }
        const sessionId = runtime?.sessionId || selectedRuntime(current)?.sessionId || selected?.topicId;
        if (!sessionId) throw new Error('请先选择或新建 Session');
        // ACK means the daemon accepted this command, not that a durable
        // Topic checkpoint already exists.  Project a renderer-only pending
        // item immediately so the user never sends into an apparently empty
        // conversation; `turn.started`/`user.message` later replaces it with
        // the daemon event identity.  If the pipe breaks first, the item is
        // explicitly unconfirmed and is never automatically replayed.
        const accepted = await requireApi('agentRuntimeStartTurn')({ sessionId, prompt, attachments });
        // Keep activeTurnId authoritative: it is established by the daemon's
        // turn.started/projection event, while the Workbench owns a separate
        // ephemeral startup indicator for the ACK-to-first-event gap.
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
            ...(approval.scope ? { scope: approval.scope } : {}),
            sessionId: approval.sessionId,
            turnId: approval.turnId,
            toolCallId: approval.toolCallId,
            argumentsHash: approval.argumentsHash,
        });
        const key = `${approval.scope || approval.source || 'codex-native'}:${approval.approvalId}`;
        store.setState({ approvals: store.getState().approvals.filter((item) => (
            `${item.scope || item.source || 'codex-native'}:${item.approvalId}` !== key
        )) });
        return result;
    }

    async function respondInteraction(interaction, response) {
        return requireApi('agentRuntimeRespondInteraction')({
            source: interaction.source,
            requestId: interaction.requestId,
            kind: interaction.kind,
            response,
        });
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
                if (event?.runtime === 'codex' && event?.type === 'projection.updated') {
                    applyCodexRuntimeEvent(event);
                    return;
                }
                applySessionUiEvent(event);
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
        createSession, createTopic, forkSession, compactSession, hydrateTopic, previewTopic, ensureSessionRuntime,
        listTopics, searchTopics, searchTopicMessages, getTopicIndexStatus, rebuildTopicIndex,
        readTopic, takeoverTopic, renameTopic, deleteTopic, archiveSession, restoreSession, setSessionPinned,
        listInteractionQueue, replaceInteractionQueue, clearInteractionQueue,
        getWorkbenchSettings, updateWorkbenchSettings, selectAttachments,
        startTurn, steerTurn, followUpTurn, cancelTurn, cancelTool, respondApproval, respondInteraction,
        respondToolboxApproval,
    };
}

export { createWorkbenchController };
