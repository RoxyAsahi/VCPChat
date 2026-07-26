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
        sessions: [],
        activeSessionId: null,
        messages: [],
        tools: new Map(),
        approvals: [],
        context: { usedTokens: 0, contextWindow: 0, percentage: 0, compacting: false, summary: '' },
        artifacts: [],
        plan: null,
        activeTurnId: null,
        lastSequence: 0,
        notice: null,
    };
}

function upsertSession(sessions, sessionId, patch = {}) {
    const index = sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) return [{ sessionId, ...patch }, ...sessions];
    const next = [...sessions];
    next[index] = { ...next[index], ...patch };
    return next;
}

function messageIdentity(message) {
    return message.id || message.messageId || `${message.role || 'message'}:${message.turnId || message.createdAt || ''}`;
}

function upsertMessage(messages, candidate) {
    const id = messageIdentity(candidate);
    const index = messages.findIndex((message) => messageIdentity(message) === id
        || (candidate.turnId && message.turnId === candidate.turnId && message.role === candidate.role));
    if (index < 0) return [...messages, { ...candidate, id }];
    const next = [...messages];
    next[index] = { ...next[index], ...candidate, id: messageIdentity(next[index]) || id };
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
        next.runtime = { ...next.runtime, state: 'degraded', lastError: event.payload || null };
        return next;
    }
    if (event.type === 'runtime.warning') {
        next.notice = { level: 'warning', text: event.payload?.warning || 'Runtime warning' };
        return next;
    }
    if (event.type === 'session.created') {
        next.sessions = upsertSession(next.sessions, event.sessionId, { state: 'created', ...(event.payload || {}) });
        if (!next.activeSessionId) next.activeSessionId = event.sessionId;
        return next;
    }
    if (event.type === 'session.state_changed' || event.type === 'session.closed') {
        next.sessions = upsertSession(next.sessions, event.sessionId, {
            ...(event.payload || {}),
            state: event.type === 'session.closed' ? 'closed' : event.payload?.state,
        });
        return next;
    }
    if (event.type === 'turn.started') {
        next.activeTurnId = event.turnId;
        const existing = next.messages.find((message) => message.turnId === event.turnId && message.role === 'user');
        if (!existing) {
            next.messages = upsertMessage(next.messages, {
                id: `user:${event.turnId}`,
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
        next.messages = upsertMessage(next.messages, {
            id: `user:${event.turnId}:${event.sequence || event.timestamp || ''}`,
            turnId: event.turnId,
            role: 'user',
            content: event.payload?.prompt || '',
            state: event.payload?.queued ? 'queued' : 'complete',
            createdAt: event.timestamp || 0,
        });
        return next;
    }
    if (event.type === 'assistant.started') {
        const existing = next.messages.find((message) => message.turnId === event.turnId && message.role === 'assistant');
        if (!existing) {
            next.messages = upsertMessage(next.messages, {
                id: event.messageId || `assistant:${event.turnId}`,
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
        const id = event.messageId || `assistant:${event.turnId}`;
        const messages = [...next.messages];
        let index = messages.findIndex((message) => messageIdentity(message) === id
            || (message.turnId === event.turnId && message.role === 'assistant'));
        if (index < 0) {
            messages.push({ id, turnId: event.turnId, role: 'assistant', content: '', reasoning: '', state: 'streaming' });
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
        const id = event.messageId || `assistant:${event.turnId}`;
        next.messages = next.messages.map((message) => messageIdentity(message) === id
            || (message.turnId === event.turnId && message.role === 'assistant')
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
                turnId: event.turnId || previous.turnId,
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
        const approval = event.payload?.approval || event.payload;
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
    if (event.type === 'context.usage') {
        const usedTokens = Number(event.payload?.usedTokens) || 0;
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
    if (event.type === 'context.compaction_started') {
        next.context = { ...next.context, compacting: true };
        return next;
    }
    if (event.type === 'context.compaction_completed') {
        next.context = { ...next.context, compacting: false, summary: event.payload?.summary || '' };
        return next;
    }
    if (event.type === 'plan.updated') {
        next.plan = event.payload?.plan || event.payload || null;
        return next;
    }
    if (event.type === 'artifact.created' || event.type === 'artifact.updated') {
        const artifact = event.payload?.artifact || event.payload;
        const artifactId = artifact?.artifactId || artifact?.id;
        if (artifactId) {
            next.artifacts = [...next.artifacts.filter((item) => (item.artifactId || item.id) !== artifactId), artifact];
        }
        return next;
    }
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
        if (!event.turnId || event.turnId === next.activeTurnId) next.activeTurnId = null;
        if (event.type !== 'turn.completed') {
            next.notice = { level: 'error', text: event.payload?.error || event.payload?.reason || event.type };
        }
    }
    return next;
}

function eventKey(event) {
    const session = event.sessionId || 'runtime';
    if (Number.isFinite(Number(event.sequence)) && Number(event.sequence) > 0) {
        return `${session}:sequence:${Number(event.sequence)}`;
    }
    return [session, event.type, event.turnId || '', event.messageId || '', event.toolCallId || '',
        event.approvalId || '', event.timestamp || '', JSON.stringify(event.payload || {})].join(':');
}

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
            if (!isRuntimeEvent && !isSessionEvent && state.activeSessionId && event.sessionId !== state.activeSessionId) {
                return state;
            }
            const key = eventKey(event);
            if (seenEvents.has(key)) return state;
            seenEvents.add(key);
            state = reduceEvent(state, event);
            notify(event);
            return state;
        },
        resetSession(sessionId) {
            seenEvents.clear();
            state = {
                ...state,
                activeSessionId: sessionId || null,
                messages: [],
                tools: new Map(),
                approvals: [],
                context: createInitialState().context,
                artifacts: [],
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

export {
    createInitialState,
    createWorkbenchStore,
    reduceEvent,
};
