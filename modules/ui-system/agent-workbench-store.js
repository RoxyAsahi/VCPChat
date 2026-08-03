import { createAgentSessionUiState } from './agent-session-state.js';

const TERMINAL_EVENT_TYPES = new Set([
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
]);

const SESSION_EVENT_TYPES = new Set([
    'session.created',
    'session.state_changed',
    'session.closed',
]);

function createInitialState() {
    return {
        runtime: { state: 'unknown', worker: null, lastError: null },
        selectedSessionId: null,
        sessionSnapshots: new Map(),
        activeRuntimes: new Map(),
        // A displayed Topic can be a read-only snapshot while several other
        // Topic runtimes keep working. This is never a global composer lock.
        selectedTopic: null,
        // Codex Thread lifecycle is identity-keyed renderer state. It never
        // derives activity from the selected sidebar row.
        sessionUi: createAgentSessionUiState(),
        messages: [],
        tools: new Map(),
        approvals: [],
        // Main-owned InteractionRegistry projection.  These are identities
        // and lifecycle state only; payloads and response channels remain in
        // Main so the Renderer cannot accidentally approve an unsupported
        // Codex capability.
        interactions: [],
        // Main already bounds and redacts these read-only ToolBox
        // observations. Keep a second, smaller UI window so log traffic can
        // never grow a renderer-side transcript or become an execution path.
        toolboxWs: [],
        // Core-filtered VCP_DYNAMIC_FOLD/VCPINFO display projections.  Unlike
        // toolboxWs these came from model text, not a WebSocket; both are
        // ephemeral Activity-only view state and never Topic persistence.
        markerObservations: [],
        // A bounded, Renderer-only unread cursor for activity observations.
        // It is deliberately not transcript state and is cleared on open.
        activityUnread: 0,
        activityUnreadByTab: { activity: 0, approvals: 0, plan: 0, changes: 0, usage: 0, connection: 0 },
        // Main emits these non-sensitive readiness facts. The Renderer
        // is a pure projection and must never probe ToolBox itself.
        readiness: {},
        context: { usedTokens: 0, contextWindow: 0, percentage: 0, compacting: false, summary: '' },
        plan: null,
        activeTurnId: null,
        lastSequence: 0,
        notice: null,
    };
}

function messageIdentity(message) {
    return message?.id || message?.messageId || null;
}

function approvalIdentity(approval) {
    const source = String(approval?.scope || approval?.source || 'codex-native');
    const id = String(approval?.approvalId || approval?.requestId || '');
    return id ? `${source}:${id}` : '';
}

function incrementActivityUnread(state, tab) {
    const current = state.activityUnreadByTab || {};
    const activityUnreadByTab = { ...current, [tab]: Math.min(100, (current[tab] || 0) + 1) };
    return {
        activityUnreadByTab,
        activityUnread: Math.min(100, Object.values(activityUnreadByTab)
            .reduce((sum, value) => sum + Number(value || 0), 0)),
    };
}

function upsertMessage(messages, candidate) {
    const id = messageIdentity(candidate);
    if (!id) return messages;
    const index = messages.findIndex((message) => messageIdentity(message) === id);
    if (index < 0) return [...messages, { ...candidate, id }];
    const next = [...messages];
    next[index] = { ...next[index], ...candidate, id };
    return next;
}

function pendingUserMessageId(turnId) {
    return `pending-user:${turnId}`;
}

function eventSequence(event) {
    const value = Number(event?.sequence);
    return Number.isFinite(value) ? value : null;
}

function confirmUserMessage(messages, event) {
    const index = messages.findIndex((message) => message.turnId === event.turnId && message.role === 'user');
    const candidate = {
        ...(index >= 0 ? messages[index] : {}),
        id: event.messageId,
        messageId: event.messageId,
        turnId: event.turnId,
        role: 'user',
        content: event.payload?.prompt || (index >= 0 ? messages[index].content : ''),
        attachments: Array.isArray(event.payload?.attachments)
            ? event.payload.attachments
            : (index >= 0 ? messages[index].attachments || [] : []),
        state: 'complete',
        deliveryState: 'confirmed',
        deliveryDetail: '',
        createdAt: event.timestamp || (index >= 0 ? messages[index].createdAt : 0),
        // Timeline order comes from Main's event projection, never from the Renderer clock
        // or an inferred active turn.  A turn.started/user.message event is
        // the authoritative moment a pending UI delivery becomes durable.
        firstSequence: eventSequence(event) ?? (index >= 0 ? messages[index].firstSequence : null),
        lastSequence: eventSequence(event) ?? (index >= 0 ? messages[index].lastSequence : null),
    };
    if (index < 0) return [...messages, candidate];
    const next = [...messages];
    next[index] = candidate;
    return next;
}

function markPendingTurn(messages, turnId, deliveryState, deliveryDetail) {
    return messages.map((message) => (
        message.role === 'user'
        && message.turnId === turnId
        && message.deliveryState === 'sending'
            ? { ...message, deliveryState, deliveryDetail }
            : message
    ));
}

function reduceEvent(current, event) {
    if (!event || typeof event !== 'object' || !event.type) return current;
    const next = { ...current };
    next.lastSequence = Math.max(next.lastSequence || 0, Number(event.sequence) || 0);

    if (event.type === 'runtime.state_changed') {
        next.runtime = { ...next.runtime, ...(event.payload || {}), state: event.payload?.state || 'unknown' };
        return next;
    }
    if (event.type === 'runtime.crashed') {
        // Recovery is deliberately user-driven: an App Server crash must not leave
        // the composer in a passive "reconnecting" limbo or replay an
        // interrupted turn.  Render the explicit reconnect action instead.
        next.runtime = { ...next.runtime, state: 'failed', lastError: event.payload || null };
        // App Server may have accepted a request just before its pipe broke.
        // Do not mark it as failed or replay it: its durable outcome is only
        // knowable from the next Codex Thread reconciliation after reconnect.
        next.messages = next.messages.map((message) => (
            message.role === 'user' && message.deliveryState === 'sending'
                ? {
                    ...message,
                    deliveryState: 'unconfirmed',
                    deliveryDetail: '连接中断，消息是否已写入将由重新连接后的 Codex Thread 对账确认。',
                }
                : message
        ));
        return next;
    }
    if (event.type === 'runtime.warning') {
        next.notice = { level: 'warning', text: event.payload?.warning || 'Runtime warning' };
        return next;
    }
    if (event.type === 'runtime.readiness') {
        next.readiness = { ...(next.readiness || {}), ...(event.payload || {}) };
        return next;
    }
    if (event.type === 'session.created') {
        const runtimes = new Map(next.activeRuntimes);
        const current = runtimes.get(event.sessionId) || { sessionId: event.sessionId, topicId: event.topicId || event.sessionId };
        runtimes.set(event.sessionId, { ...current, state: 'created', ...(event.payload || {}) });
        next.activeRuntimes = runtimes;
        return next;
    }
    if (event.type === 'session.state_changed' || event.type === 'session.closed') {
        const runtimes = new Map(next.activeRuntimes);
        const current = runtimes.get(event.sessionId);
        if (current) runtimes.set(event.sessionId, {
            ...current,
            ...(event.payload || {}),
            state: event.type === 'session.closed' ? 'closed' : event.payload?.state,
        });
        next.activeRuntimes = runtimes;
        return next;
    }
    if (event.type === 'turn.started') {
        if (!event.turnId || !event.messageId) return current;
        next.activeTurnId = event.turnId;
        next.messages = confirmUserMessage(next.messages, event);
        return next;
    }
    if (event.type === 'user.message') {
        if (!event.eventId) return current;
        next.messages = confirmUserMessage(next.messages, event);
        return next;
    }
    if (event.type === 'assistant.started') {
        if (!event.messageId || !event.turnId) return current;
        const existing = next.messages.find((message) => messageIdentity(message) === event.messageId);
        if (!existing) {
            next.messages = upsertMessage(next.messages, {
                id: event.messageId,
                messageId: event.messageId,
                turnId: event.turnId,
                role: 'assistant',
                content: '',
                reasoning: '',
                state: 'streaming',
                createdAt: event.timestamp || 0,
                firstSequence: eventSequence(event),
                lastSequence: eventSequence(event),
            });
        }
        return next;
    }
    if (event.type === 'assistant.delta' || event.type === 'reasoning.delta') {
        if (!event.messageId || !event.turnId) return current;
        const id = event.messageId;
        const messages = [...next.messages];
        let index = messages.findIndex((message) => messageIdentity(message) === id);
        if (index < 0) {
            messages.push({
                id,
                messageId: event.messageId,
                turnId: event.turnId,
                role: 'assistant',
                content: '',
                reasoning: '',
                state: 'streaming',
                createdAt: event.timestamp || 0,
                firstSequence: eventSequence(event),
                lastSequence: eventSequence(event),
            });
            index = messages.length - 1;
        }
        const message = { ...messages[index] };
        if (event.type === 'assistant.delta' && message.state !== 'complete') {
            message.content = `${message.content || ''}${event.payload?.text || ''}`;
        } else if (event.type === 'reasoning.delta') {
            message.reasoning = `${message.reasoning || ''}${event.payload?.text || ''}`;
        }
        message.lastSequence = eventSequence(event) ?? message.lastSequence ?? null;
        messages[index] = message;
        next.messages = messages;
        return next;
    }
    if (event.type === 'assistant.completed') {
        if (!event.messageId || !event.turnId) return current;
        const id = event.messageId;
        next.messages = next.messages.map((message) => messageIdentity(message) === id
            ? {
                ...message,
                state: 'complete',
                lastSequence: eventSequence(event) ?? message.lastSequence ?? null,
            }
            : message);
        return next;
    }
    if (event.type.startsWith('tool.')) {
        const toolCallId = event.toolCallId || event.payload?.toolCallId;
        if (toolCallId) {
            const tools = new Map(next.tools);
            const previous = tools.get(toolCallId) || { toolCallId, events: [] };
            tools.set(toolCallId, {
                ...previous,
                // A tool event without turnId remains explicitly unassociated.
                // Never borrow a previous Turn after a delayed Runtime frame.
                turnId: event.turnId || null,
                name: event.payload?.toolName || previous.name || 'tool',
                state: event.type.slice('tool.'.length),
                payload: { ...(previous.payload || {}), ...(event.payload || {}) },
                events: [...previous.events, event],
                firstSequence: previous.firstSequence ?? eventSequence(event),
                lastSequence: eventSequence(event) ?? previous.lastSequence ?? null,
                firstTimestamp: previous.firstTimestamp ?? event.timestamp ?? null,
                lastTimestamp: event.timestamp ?? previous.lastTimestamp ?? null,
            });
            next.tools = tools;
        }
        return next;
    }
    if (event.type === 'approval.requested') {
        const payload = event.payload?.approval || event.payload;
        const approval = payload ? {
            ...payload,
            topicId: event.topicId,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
        } : null;
        if (approval?.approvalId) {
            const key = approvalIdentity(approval);
            next.approvals = [...next.approvals.filter((item) => approvalIdentity(item) !== key), approval];
        }
        Object.assign(next, incrementActivityUnread(next, 'approvals'));
        return next;
    }
    if (event.type === 'approval.resolved' || event.type === 'approval.expired') {
        const approvalId = event.approvalId || event.payload?.approvalId || event.payload?.approval?.approvalId;
        const scope = event.payload?.scope || event.scope || null;
        next.approvals = next.approvals.filter((item) => (
            scope ? approvalIdentity(item) !== `${scope}:${approvalId}` : item.approvalId !== approvalId
        ));
        return next;
    }
    if (event.type === 'toolbox.ws') {
        const payload = event.payload || {};
        const observation = {
            id: `${payload.channel || 'toolbox'}:${payload.kind || 'event'}:${event.sequence || event.timestamp || Date.now()}`,
            channel: String(payload.channel || 'ToolBox'),
            kind: String(payload.kind || 'notification'),
            value: payload.value ?? null,
            timestamp: event.timestamp || null,
        };
        next.toolboxWs = [...next.toolboxWs, observation].slice(-100);
        Object.assign(next, incrementActivityUnread(next, payload.kind === 'backend-approval-request' ? 'approvals' : 'activity'));
        return next;
    }
    if (event.type === 'marker.observed') {
        const payload = event.payload || {};
        const observation = {
            id: `marker:${payload.kind || 'unknown'}:${event.sequence}`,
            kind: String(payload.kind || 'unknown'),
            summary: typeof payload.summary === 'string' ? payload.summary : '',
            detail: typeof payload.detail === 'string' ? payload.detail : '',
            messageId: event.messageId || null,
            turnId: event.turnId || null,
            timestamp: event.timestamp || null,
        };
        next.markerObservations = [...next.markerObservations, observation].slice(-100);
        Object.assign(next, incrementActivityUnread(next, 'activity'));
        return next;
    }
    if (event.type === 'interaction.requested') {
        const interaction = event.payload || {};
        const key = `${interaction.source || 'codex-native'}:${interaction.requestId || ''}`;
        next.interactions = [...next.interactions.filter((item) => `${item.source}:${item.requestId}` !== key), interaction];
        Object.assign(next, incrementActivityUnread(next, 'approvals'));
        return next;
    }
    if (event.type === 'interaction.resolved' || event.type === 'interaction.rejected') {
        const payload = event.payload || {};
        next.interactions = next.interactions.filter((item) => !(
            item.source === (payload.source || 'codex-native') && item.requestId === payload.requestId
        ));
        return next;
    }
    if (event.type === 'context.usage') {
        const payload = event.payload || {};
        const source = ['real', 'estimated', 'unknown'].includes(payload.source) ? payload.source : 'unknown';
        const hasReportedUsage = ['real', 'estimated'].includes(source)
            && ['totalTokens', 'usedTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
                .some((key) => Number.isFinite(Number(payload[key])));
        const usedTokens = Number(payload.usedTokens ?? payload.totalTokens) || 0;
        const contextWindow = Number(payload.contextWindow) || 0;
        next.context = {
            ...next.context,
            ...payload,
            source,
            usageAvailable: hasReportedUsage,
            usedTokens,
            contextWindow,
            percentage: contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0,
        };
        Object.assign(next, incrementActivityUnread(next, 'usage'));
        return next;
    }
    if (event.type === 'context.compaction.started' || event.type === 'compaction.started') {
        next.context = { ...next.context, compacting: true, compactionState: 'started', compactionError: '' };
        Object.assign(next, incrementActivityUnread(next, 'usage'));
        return next;
    }
    if (event.type === 'context.compaction.completed' || event.type === 'compaction.completed') {
        next.context = { ...next.context, compacting: false, compactionState: 'completed',
            summary: event.payload?.summary || '', compactionError: '' };
        Object.assign(next, incrementActivityUnread(next, 'usage'));
        return next;
    }
    if (event.type === 'context.compaction.failed' || event.type === 'compaction.failed') {
        next.context = { ...next.context, compacting: false, compactionState: 'failed', summary: '',
            compactionError: event.payload?.error || '上下文压缩失败' };
        Object.assign(next, incrementActivityUnread(next, 'usage'));
        return next;
    }
    if (event.type === 'plan.updated') {
        next.plan = event.payload?.plan || event.payload || null;
        Object.assign(next, incrementActivityUnread(next, 'plan'));
        return next;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
        if (event.turnId && event.turnId === next.activeTurnId) next.activeTurnId = null;
        if (event.turnId && event.type !== 'turn.completed') {
            const attachmentUnavailable = event.type === 'turn.failed'
                && event.payload?.code === 'attachment-unavailable';
            next.messages = markPendingTurn(
                next.messages,
                event.turnId,
                attachmentUnavailable ? 'failed' : 'interrupted',
                attachmentUnavailable
                    ? '附件文件不可用或已损坏；请重新选择附件后重试。'
                    : '任务已中断；为避免重复执行，Codex Runtime 不会自动重放此消息。',
            );
        }
        if (event.type !== 'turn.completed') {
            next.notice = { level: 'error', text: event.payload?.error || event.payload?.reason || event.type };
        }
    }
    return next;
}

function eventKey(event) { return event.eventId || null; }

function createWorkbenchStore(initial = createInitialState()) {
    let state = initial;
    const listeners = new Set();
    const seenEvents = new Set();

    function notify(event) {
        listeners.forEach((listener) => listener(state, event));
    }

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        setState(patch) {
            state = { ...state, ...patch };
            notify();
        },
        addPendingUserMessage({ turnId, prompt, attachments = [], createdAt = Date.now() } = {}) {
            if (!turnId || (!String(prompt || '').trim() && !attachments.length)) return state;
            const existing = state.messages.find((message) => message.turnId === turnId && message.role === 'user');
            if (existing) return state;
            state = {
                ...state,
                messages: upsertMessage(state.messages, {
                    id: pendingUserMessageId(turnId),
                    turnId,
                    role: 'user',
                    content: String(prompt).trim(),
                    attachments: Array.isArray(attachments) ? attachments.map((item) => ({ ...item })) : [],
                    state: 'pending',
                    deliveryState: 'sending',
                    deliveryDetail: '正在等待 Codex App Server 确认…',
                    createdAt,
                    firstSequence: null,
                    lastSequence: null,
                }),
            };
            notify({ type: 'ui.user_message.pending', turnId });
            return state;
        },
        dispatch(event) {
            if (!event || typeof event !== 'object') return state;
            const isRuntimeEvent = !event.sessionId || event.sessionId === 'runtime'
                || event.type?.startsWith('runtime.') || event.type === 'toolbox.ws';
            const isSessionEvent = SESSION_EVENT_TYPES.has(event.type);
            if (!event.eventId || !Number.isFinite(Number(event.sequence)) || !Number.isFinite(Number(event.timestamp))) return state;
            const isApproval = event.type?.startsWith('approval.');
            const isInteraction = event.type?.startsWith('interaction.');
            // The fallback preserves the narrow unit-test/legacy bootstrap
            // shape before the first snapshot installs selectedTopic. Normal
            // Workbench routing always uses selectedTopic.
            const selectedSessionId = state.selectedSessionId || null;
            const selectedTopicId = state.selectedTopic?.topicId || selectedSessionId;
            // Only the visible Topic may change this live transcript. Local
            // approvals are global Activity state and retain their complete
            // complete identities when the user switches Sessions.
            if (!isRuntimeEvent && !isSessionEvent && !isApproval && !isInteraction
                && (!selectedSessionId || (event.sessionId
                    ? event.sessionId !== selectedSessionId
                    : event.topicId !== selectedTopicId))) {
                return state;
            }
            const key = eventKey(event);
            if (seenEvents.has(key)) return state;
            seenEvents.add(key);
            state = reduceEvent(state, event);
            notify(event);
            return state;
        },
        selectSession(session) {
            seenEvents.clear();
            const sessionId = session?.sessionId || session?.topicId || null;
            state = {
                ...state,
                selectedSessionId: sessionId,
                selectedTopic: session ? { ...session, topicId: session.topicId || sessionId } : null,
                messages: [],
                tools: new Map(),
                approvals: [],
                toolboxWs: [],
                markerObservations: [],
                activityUnread: 0,
                activityUnreadByTab: createInitialState().activityUnreadByTab,
                context: createInitialState().context,
                plan: null,
                activeTurnId: null,
                lastSequence: 0,
                notice: null,
            };
            notify();
        },
        reset() {
            seenEvents.clear();
            state = createInitialState();
            notify();
        },
    };
}

/**
 * R3 fixed Agent Workbench lifecycle state machine.  Derives a single
 * authoritative view state from the renderer projection so the header, feed
 * and composer stay in lock-step instead of each inferring state from a mix of
 * booleans.  Precedence: error > reconnecting > disconnected > awaiting-approval
 * > running > starting > idle.
 */
function deriveWorkbenchViewState(state = {}) {
    const runtime = state.runtime || {};
    const selectedSessionId = state.selectedSessionId || state.selectedTopic?.topicId || null;
    const selectedRuntime = selectedSessionId && state.activeRuntimes instanceof Map
        ? state.activeRuntimes.get(selectedSessionId) : null;
    const hasSession = Boolean(selectedSessionId);
    // A projection preview is intentionally not a writable Runtime identity,
    // but it remains send-capable while App Server is stopped: the first send
    // performs the demand-driven start. Browsing SQLite history must never be
    // coupled to process startup.
    const hasIdlePreview = Boolean(
        state.selectedTopic?.mode === 'preview'
        && state.selectedTopic?.topicId
    );
    const hasTurn = Boolean(state.activeTurnId || selectedRuntime?.activeTurnId);
    const selectedTopicId = selectedSessionId;
    // Local approvals stay visible in the global Activity center, but only
    // their owning Topic is paused. A pending approval in Topic A must not
    // stop the user from starting an independent Topic B turn.
    const hasApproval = Boolean(selectedTopicId && Array.isArray(state.approvals)
        && state.approvals.some((approval) => approval?.topicId === selectedTopicId));

    if (runtime.state === 'failed') return 'error';
    if (state.recovering || runtime.state === 'degraded') return 'reconnecting';
    if ((runtime.state === 'unknown' || runtime.state === 'stopped') && !hasIdlePreview) return 'disconnected';
    if (!hasSession && !hasIdlePreview) return 'disconnected';
    if (hasApproval) return 'awaiting-approval';
    if (hasTurn) return 'running';
    // A Codex Session Runtime is explicitly `idle` once ensure-session-runtime
    // has completed. Treat it as the writable steady state; only actual
    // transitional/terminal states may keep the composer in "starting".
    if (selectedRuntime?.state && !['created', 'ready', 'idle'].includes(selectedRuntime.state)) {
        return 'starting';
    }
    return 'idle';
}

export {
    createInitialState,
    createWorkbenchStore,
    reduceEvent,
    deriveWorkbenchViewState,
};
