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
        // A workbench has one ephemeral attachment. Durable history belongs
        // exclusively to the Rust Topic identified by `attachment.topicId`.
        attachment: null,
        messages: [],
        tools: new Map(),
        approvals: [],
        // Rust Host already bounds and redacts these read-only ToolBox
        // observations. Keep a second, smaller UI window so log traffic can
        // never grow a renderer-side transcript or become an execution path.
        toolboxWs: [],
        // Rust emits these four non-sensitive readiness facts. The Renderer
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

function upsertMessage(messages, candidate) {
    const id = messageIdentity(candidate);
    if (!id) return messages;
    const index = messages.findIndex((message) => messageIdentity(message) === id);
    if (index < 0) return [...messages, { ...candidate, id }];
    const next = [...messages];
    next[index] = { ...next[index], ...candidate, id };
    return next;
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
        // Recovery is deliberately user-driven: a daemon crash must not leave
        // the composer in a passive "reconnecting" limbo or replay an
        // interrupted turn.  Render the explicit reconnect action instead.
        next.runtime = { ...next.runtime, state: 'failed', lastError: event.payload || null };
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
        if (next.attachment?.sessionId === event.sessionId) {
            next.attachment = { ...next.attachment, state: 'created', ...(event.payload || {}) };
        }
        return next;
    }
    if (event.type === 'session.state_changed' || event.type === 'session.closed') {
        if (next.attachment?.sessionId === event.sessionId) {
            next.attachment = {
                ...next.attachment,
                ...(event.payload || {}),
                state: event.type === 'session.closed' ? 'closed' : event.payload?.state,
            };
        }
        return next;
    }
    if (event.type === 'turn.started') {
        if (!event.turnId) return current;
        next.activeTurnId = event.turnId;
        const existing = next.messages.find((message) => message.turnId === event.turnId && message.role === 'user');
        if (!existing) {
            next.messages = upsertMessage(next.messages, {
                id: event.eventId,
                turnId: event.turnId,
                role: 'user',
                content: event.payload?.prompt || '',
                state: 'complete',
                createdAt: event.timestamp || 0,
            });
        }
        return next;
    }
    if (event.type === 'user.message') {
        if (!event.eventId) return current;
        next.messages = upsertMessage(next.messages, {
            id: event.eventId,
            turnId: event.turnId,
            role: 'user',
            content: event.payload?.prompt || '',
            state: event.payload?.queued ? 'queued' : 'complete',
            createdAt: event.timestamp || 0,
        });
        return next;
    }
    if (event.type === 'assistant.started') {
        if (!event.messageId || !event.turnId) return current;
        const existing = next.messages.find((message) => message.turnId === event.turnId && message.role === 'assistant');
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
            messages.push({ id, messageId: event.messageId, turnId: event.turnId, role: 'assistant', content: '', reasoning: '', state: 'streaming' });
            index = messages.length - 1;
        }
        const message = { ...messages[index] };
        if (event.type === 'assistant.delta' && message.state !== 'complete') {
            message.content = `${message.content || ''}${event.payload?.text || ''}`;
        } else if (event.type === 'reasoning.delta') {
            message.reasoning = `${message.reasoning || ''}${event.payload?.text || ''}`;
        }
        messages[index] = message;
        next.messages = messages;
        return next;
    }
    if (event.type === 'assistant.completed') {
        if (!event.messageId || !event.turnId) return current;
        const id = event.messageId;
        next.messages = next.messages.map((message) => messageIdentity(message) === id
            ? { ...message, state: 'complete' }
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
                // Never borrow a previous turn after a delayed daemon frame.
                turnId: event.turnId || null,
                name: event.payload?.toolName || previous.name || 'tool',
                state: event.type.slice('tool.'.length),
                payload: { ...(previous.payload || {}), ...(event.payload || {}) },
                events: [...previous.events, event],
            });
            next.tools = tools;
        }
        return next;
    }
    if (event.type === 'approval.requested') {
        const payload = event.payload?.approval || event.payload;
        const approval = payload ? {
            ...payload,
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: event.toolCallId,
        } : null;
        if (approval?.approvalId) {
            next.approvals = [...next.approvals.filter((item) => item.approvalId !== approval.approvalId), approval];
        }
        return next;
    }
    if (event.type === 'approval.resolved' || event.type === 'approval.expired') {
        const approvalId = event.approvalId || event.payload?.approvalId || event.payload?.approval?.approvalId;
        next.approvals = next.approvals.filter((item) => item.approvalId !== approvalId);
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
        return next;
    }
    if (event.type === 'context.usage') {
        const usedTokens = Number(event.payload?.usedTokens ?? event.payload?.totalTokens) || 0;
        const contextWindow = Number(event.payload?.contextWindow) || 0;
        next.context = {
            ...next.context,
            ...event.payload,
            usedTokens,
            contextWindow,
            percentage: contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0,
        };
        return next;
    }
    if (event.type === 'context.compaction.started') {
        next.context = { ...next.context, compacting: true };
        return next;
    }
    if (event.type === 'context.compaction.completed') {
        next.context = { ...next.context, compacting: false, summary: event.payload?.summary || '' };
        return next;
    }
    if (event.type === 'context.compaction.failed') {
        next.context = { ...next.context, compacting: false, summary: '', error: event.payload?.error || '上下文压缩失败' };
        return next;
    }
    if (event.type === 'plan.updated') {
        next.plan = event.payload?.plan || event.payload || null;
        return next;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
        if (event.turnId && event.turnId === next.activeTurnId) next.activeTurnId = null;
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
        dispatch(event) {
            if (!event || typeof event !== 'object') return state;
            const isRuntimeEvent = !event.sessionId || event.sessionId === 'runtime' || event.type?.startsWith('runtime.');
            const isSessionEvent = SESSION_EVENT_TYPES.has(event.type);
            if (!event.eventId || !Number.isFinite(Number(event.sequence)) || !Number.isFinite(Number(event.timestamp))) return state;
            if (!isRuntimeEvent && !isSessionEvent && state.attachment?.sessionId && event.sessionId !== state.attachment.sessionId) {
                return state;
            }
            const key = eventKey(event);
            if (seenEvents.has(key)) return state;
            seenEvents.add(key);
            state = reduceEvent(state, event);
            notify(event);
            return state;
        },
        setAttachment(attachment) {
            seenEvents.clear();
            state = {
                ...state,
                attachment: attachment ? { ...attachment } : null,
                messages: [],
                tools: new Map(),
                approvals: [],
                toolboxWs: [],
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
    const attachment = state.attachment;
    const hasAttachment = Boolean(attachment && attachment.sessionId);
    const hasTurn = Boolean(state.activeTurnId);
    const hasApproval = Array.isArray(state.approvals) && state.approvals.length > 0;

    if (runtime.state === 'failed') return 'error';
    if (state.recovering || runtime.state === 'degraded') return 'reconnecting';
    if (runtime.state === 'unknown' || runtime.state === 'stopped' || !hasAttachment) return 'disconnected';
    if (hasApproval) return 'awaiting-approval';
    if (hasTurn) return 'running';
    // Rust daemon attachments are explicitly `idle` once their create-session
    // ACK has completed.  Treat it as the writable steady state; only actual
    // transitional/terminal states may keep the composer in "starting".
    if (attachment && attachment.state
        && !['created', 'ready', 'idle'].includes(attachment.state)) {
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
