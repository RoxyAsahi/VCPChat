function historyToProjection(history) {
    const messages = [];
    const tools = new Map();
    if (!Array.isArray(history)) return { messages, tools };
    for (const entry of history) appendHistoryEntry(entry, messages, tools);
    return { messages, tools };
}

function appendToolHistoryEntry(entry, tools) {
    const toolCallId = String(entry.toolCallId || '').trim();
    if (!toolCallId) return;
    const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
    tools.set(toolCallId, {
        toolCallId, turnId: entry.turnId || null,
        name: entry.toolName || payload.toolName || 'vcp_invoke',
        state: entry.state === 'failed' ? 'failed' : 'completed', payload, events: [],
        firstSequence: null, lastSequence: null,
        firstTimestamp: entry.createdAt || entry.timestamp || 0,
        lastTimestamp: entry.createdAt || entry.timestamp || 0,
        snapshotOrdinal: Number.isFinite(Number(entry.snapshotOrdinal)) ? Number(entry.snapshotOrdinal) : null,
    });
}

function appendMessageHistoryEntry(entry, messages) {
    const id = entry?.id || entry?.messageId;
    if (!id) return;
    const content = typeof entry?.content === 'string' ? entry.content
        : Array.isArray(entry?.content) ? entry.content.map((part) => part?.text || '').join('') : '';
    messages.push({
        ...entry, id, role: entry?.role === 'assistant' ? 'assistant' : 'user', content,
        state: entry?.state || 'complete', createdAt: entry?.createdAt || entry?.timestamp || 0,
        firstSequence: Number.isFinite(Number(entry?.firstSequence)) ? Number(entry.firstSequence) : null,
        lastSequence: Number.isFinite(Number(entry?.lastSequence)) ? Number(entry.lastSequence) : null,
        snapshotOrdinal: Number.isFinite(Number(entry?.snapshotOrdinal)) ? Number(entry.snapshotOrdinal) : null,
    });
}

function appendHistoryEntry(entry, messages, tools) {
    if (entry?.role === 'tool') {
        appendToolHistoryEntry(entry, tools);
        return;
    }
    appendMessageHistoryEntry(entry, messages);
}

function textFromContent(content = {}) {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const summary = Array.isArray(content.summary) ? content.summary : [];
    const detail = Array.isArray(content.content) ? content.content : [];
    return content.text
        || parts.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
        || summary.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
        || detail.map((part) => typeof part === 'string' ? part : part?.text || '').join('')
        || '';
}

function messageState(status) {
    if (status === 'completed') return 'complete';
    if (['inProgress', 'running', 'started'].includes(status)) return 'streaming';
    return status || 'complete';
}

function snapshotOrder(entry) {
    const value = entry?.displayOrder ?? entry?.sourceOrder;
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

/*
function projectSnapshotEntryLegacy(entry, output) {
    const reasoning = [];
    for (const block of entry.blocks || []) {
        const blockId = block.blockId || `${entry.messageId}:${block.ordinal || 0}`;
        if (block.kind === 'observation' && block.content?.marker) {
            const marker = block.content.marker;
            output.markerObservations.push({ id: `marker:${entry.messageId}:${block.ordinal || 0}`, kind: String(marker.kind || 'unknown'), summary: typeof marker.summary === 'string' ? marker.summary : '', detail: typeof marker.detail === 'string' ? marker.detail : '', messageId: entry.messageId, turnId: entry.turnId || null, timestamp: entry.updatedAt || entry.createdAt || null });
            continue;
        }
        if (block.kind === 'tool') {
            const item = block.content?.item || {};
            output.tools.set(entry.itemId, { toolCallId: entry.itemId, turnId: entry.turnId || null, name: item.tool || item.command || item.type || 'codex_tool', state: entry.status === 'completed' ? 'completed' : entry.status === 'failed' ? 'failed' : 'running', payload: block.content || {}, events: [], firstSequence: null, lastSequence: null, firstTimestamp: entry.createdAt || 0, lastTimestamp: entry.updatedAt || entry.createdAt || 0, snapshotOrdinal: entry.sourceOrder || null });
            continue;
        }
        if (block.kind === 'attachment') {
            const item = block.content?.item || block.content || {};
            output.messages.push({ id: blockId, messageId: entry.messageId, itemId: entry.itemId, turnId: entry.turnId || null, role: 'assistant', content: item.message || '', attachments: [{ id: blockId, itemId: entry.itemId, kind: item.type === 'imageView' ? 'image' : (item.kind || 'file'), displayName: item.path || item.url || item.name || 'Codex 资源', path: item.path || null, url: item.url || null }], state: messageState(entry.status), createdAt: entry.createdAt || 0, snapshotOrdinal: entry.sourceOrder || null });
            continue;
        }
        if (block.kind === 'reasoning') {
            const text = textFromContent(block.content);
            if (text) reasoning.push({ ordinal: Number(block.ordinal) || 0, text });
            continue;
        }
        if (block.kind === 'observation' && typeof block.content?.text === 'string' && !block.content?.phase && entry.role === 'assistant') {
            output.plan = { text: block.content.text, turnId: entry.turnId || null, itemId: entry.itemId, updatedAt: entry.updatedAt || entry.createdAt || null };
            continue;
        }
        if (block.kind === 'observation' && block.content?.phase) {
            output.context.compactionState = block.content.phase;
            output.context.compacting = block.content.phase === 'inProgress';
            output.context.summary = block.content.text || output.context.summary;
            continue;
        }
        const content = textFromContent(block.content);
        const fallbackContent = content || (block.content?.item ? `Codex ${block.content.item.type || 'unknown'} Item\n\n${JSON.stringify(block.content.item, null, 2).slice(0, 16_384)}` : '');
        if (!fallbackContent) continue;
        output.messages.push({ id: blockId, messageId: entry.messageId, itemId: entry.itemId, turnId: entry.turnId || null, role: entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'assistant', content: fallbackContent, state: messageState(entry.status), createdAt: entry.createdAt || 0, firstSequence: null, lastSequence: null, snapshotOrdinal: entry.sourceOrder || null });
    }
    if (reasoning.length) output.messages.push({ id: entry.messageId, messageId: entry.messageId, itemId: entry.itemId, turnId: entry.turnId || null, role: 'assistant', content: '', reasoning: reasoning.sort((left, right) => left.ordinal - right.ordinal).map((part) => part.text).join('\n'), state: messageState(entry.status), createdAt: entry.createdAt || 0, firstSequence: null, lastSequence: null, snapshotOrdinal: entry.sourceOrder || null });
}
*/

function projectSnapshotEntry(entry, output) {
    const reasoning = [];
    for (const block of entry.blocks || []) {
        const blockId = block.blockId || `${entry.messageId}:${block.ordinal || 0}`;
        const handlers = {
            marker: () => { const marker = block.content.marker; output.markerObservations.push({ id: `marker:${entry.messageId}:${block.ordinal || 0}`, kind: String(marker.kind || 'unknown'), summary: typeof marker.summary === 'string' ? marker.summary : '', detail: typeof marker.detail === 'string' ? marker.detail : '', messageId: entry.messageId, turnId: entry.turnId || null, timestamp: entry.updatedAt || entry.createdAt || null }); },
            tool: () => { const item = block.content?.item || {}; output.tools.set(entry.itemId, { toolCallId: entry.itemId, turnId: entry.turnId || null, name: item.tool || item.command || item.type || 'codex_tool', state: entry.status === 'completed' ? 'completed' : entry.status === 'failed' ? 'failed' : 'running', payload: block.content || {}, events: [], firstSequence: null, lastSequence: null, firstTimestamp: entry.createdAt || 0, lastTimestamp: entry.updatedAt || entry.createdAt || 0, snapshotOrdinal: snapshotOrder(entry) }); },
            attachment: () => { const item = block.content?.item || block.content || {}; output.messages.push({ id: blockId, messageId: entry.messageId, itemId: entry.itemId, turnId: entry.turnId || null, role: 'assistant', content: item.message || '', attachments: [{ id: blockId, itemId: entry.itemId, kind: item.type === 'imageView' ? 'image' : (item.kind || 'file'), displayName: item.path || item.url || item.name || 'Codex 资源', path: item.path || null, url: item.url || null }], state: messageState(entry.status), createdAt: entry.createdAt || 0, snapshotOrdinal: snapshotOrder(entry) }); },
            reasoning: () => { const text = textFromContent(block.content); if (text) reasoning.push({ ordinal: Number(block.ordinal) || 0, text }); },
            plan: () => { output.plan = { text: block.content.text, turnId: entry.turnId || null, itemId: entry.itemId, updatedAt: entry.updatedAt || entry.createdAt || null }; },
            compaction: () => { output.context.compactionState = block.content.phase; output.context.compacting = block.content.phase === 'inProgress'; output.context.summary = block.content.text || output.context.summary; },
            message: () => {
                const content = textFromContent(block.content);
                const unknown = block.content?.unknown || block.content?.item;
                const fallbackContent = content || (unknown
                    ? `Codex ${unknown.type || 'unknown'} Item\n\n${JSON.stringify(unknown).slice(0, 16_384)}` : '');
                if (fallbackContent) output.messages.push({ id: blockId, messageId: entry.messageId, itemId: entry.itemId, turnId: entry.turnId || null, role: entry.role === 'user' ? 'user' : entry.role === 'system' ? 'system' : 'assistant', content: fallbackContent, state: messageState(entry.status), createdAt: entry.createdAt || 0, firstSequence: null, lastSequence: null, snapshotOrdinal: snapshotOrder(entry) });
            },
        };
        const key = block.kind === 'observation' && block.content?.marker ? 'marker'
            : block.kind === 'observation' && block.content?.phase ? 'compaction'
                : block.kind === 'observation' && typeof block.content?.text === 'string' && entry.role === 'assistant' ? 'plan' : block.kind;
        (handlers[key] || handlers.message)();
    }
    if (reasoning.length) output.messages.push({ id: entry.messageId, messageId: entry.messageId, itemId: entry.itemId, turnId: entry.turnId || null, role: 'assistant', content: '', reasoning: reasoning.sort((left, right) => left.ordinal - right.ordinal).map((part) => part.text).join('\n'), state: messageState(entry.status), createdAt: entry.createdAt || 0, firstSequence: null, lastSequence: null, snapshotOrdinal: snapshotOrder(entry) });
}

function restoredContext(snapshot) {
    const projectionActivity = snapshot?.projection?.activity || {};
    const usage = projectionActivity.usage || {};
    const compaction = projectionActivity.compaction || {};
    const source = ['real', 'estimated', 'unknown'].includes(usage.source) ? usage.source : 'unknown';
    const usedTokens = Number(usage.usedTokens ?? usage.totalTokens) || 0;
    const contextWindow = Number(usage.contextWindow) || 0;
    return {
        ...usage,
        source,
        usageAvailable: ['real', 'estimated'].includes(source)
            && ['totalTokens', 'usedTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']
                .some((key) => Number.isFinite(Number(usage[key]))),
        usedTokens,
        contextWindow,
        percentage: contextWindow ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0,
        compacting: compaction.state === 'started',
        compactionState: compaction.state || null,
        summary: compaction.summary || '',
        compactionError: compaction.error || '',
    };
}

function codexSnapshotToProjection(snapshot) {
    if (!Array.isArray(snapshot?.messages)) return historyToProjection(snapshot?.history);
    const messages = [];
    const tools = new Map();
    const markerObservations = [];
    const context = restoredContext(snapshot);
    const output = { messages, tools, markerObservations, context, plan: null };
    for (const entry of snapshot.messages) {
        projectSnapshotEntry(entry, output);
        /*
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
                plan = {
                    text: block.content.text,
                    turnId: entry.turnId || null,
                    itemId: entry.itemId,
                    updatedAt: entry.updatedAt || entry.createdAt || null,
                };
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
        */
    }
    return output;
}

export { codexSnapshotToProjection, historyToProjection, messageState, textFromContent };
