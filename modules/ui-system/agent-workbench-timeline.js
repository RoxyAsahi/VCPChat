// Renderer-only timeline adapter for the Agent Workbench.
//
// Codex remains the execution/context authority and SQLite owns the durable UI
// projection. This module only turns projected state into stable display parts
// and reconciles their DOM nodes in place.

function sequenceOf(value) {
    const sequence = Number(value);
    return Number.isFinite(sequence) ? sequence : null;
}

function timestampOf(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function timelinePartKey(part) {
    if (part.kind === 'message') return `message:${part.messageId || part.presentationKey || part.id}`;
    if (part.kind === 'tool') return `tool:${part.toolCallId}`;
    return `${part.kind}:${part.id}`;
}

// Display-only registry.  A match changes an icon/label only; it never
// rewrites the model's vcp_invoke request, ToolBox catalog, permissions or
// execution target.  Unknown names intentionally use the generic fallback.
const VCP_TOOL_PRESENTATIONS = new Map([
    ['fileoperator', { icon: 'folder', label: 'FileOperator', kind: 'file' }],
    ['serverfileoperator', { icon: 'folder', label: 'ServerFileOperator', kind: 'file' }],
    ['powershellexecutor', { icon: 'terminal', label: 'PowerShellExecutor', kind: 'terminal' }],
    ['canvas', { icon: 'palette', label: 'Canvas', kind: 'canvas' }],
]);

function projectVcpToolPresentation(tool = {}) {
    const payload = tool.payload && typeof tool.payload === 'object' ? tool.payload : {};
    const target = String(payload.toolName || tool.name || 'vcp_invoke');
    const known = VCP_TOOL_PRESENTATIONS.get(target.toLocaleLowerCase());
    if (known) return { ...known, target, fallback: false };
    if (target === 'vcp_invoke') {
        return { icon: 'build_circle', label: 'VCPToolBox 调用', kind: 'generic', target, fallback: true };
    }
    return { icon: 'extension', label: target, kind: 'unknown', target, fallback: true };
}

// A message owns its visual reasoning and attachment subparts.  They remain
// explicit in the projection so a renderer never needs to discover or infer
// them from text, but they intentionally do not become duplicate timeline
// rows beside their parent message.
function messagePart(message, index) {
    const messageId = message?.id || message?.messageId;
    if (!messageId) return null;
    const blocks = [{ kind: 'message', id: messageId }];
    if (message.reasoning) blocks.push({ kind: 'reasoning', id: `reasoning:${messageId}` });
    for (const attachment of message.attachments || []) {
        if (attachment?.id) blocks.push({ kind: 'attachment', id: `attachment:${messageId}:${attachment.id}` });
    }
    return {
        kind: 'message',
        id: messageId,
        messageId,
        turnId: message.turnId || null,
        sequence: sequenceOf(message.firstSequence),
        timestamp: timestampOf(message.createdAt),
        snapshotOrdinal: sequenceOf(message.snapshotOrdinal),
        index,
        blocks,
        value: message,
    };
}

function toolPart(tool, index) {
    const toolCallId = tool?.toolCallId;
    if (!toolCallId) return null;
    return {
        kind: 'tool',
        id: toolCallId,
        toolCallId,
        turnId: tool.turnId || null,
        sequence: sequenceOf(tool.firstSequence),
        timestamp: timestampOf(tool.firstTimestamp),
        snapshotOrdinal: sequenceOf(tool.snapshotOrdinal),
        index,
        blocks: [{ kind: 'tool', id: toolCallId }],
        value: tool,
    };
}

function compareTimelineParts(left, right) {
    const leftLive = left.sequence !== null;
    const rightLive = right.sequence !== null;
    if (leftLive && rightLive && left.sequence !== right.sequence) return left.sequence - right.sequence;
    if (leftLive !== rightLive) return leftLive ? 1 : -1;
    if (left.snapshotOrdinal !== null && right.snapshotOrdinal !== null
        && left.snapshotOrdinal !== right.snapshotOrdinal) {
        return left.snapshotOrdinal - right.snapshotOrdinal;
    }
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.index - right.index;
}

/**
 * Canonical, ephemeral AgentTimelinePart projection.  Approval and observer
 * parts deliberately stay out of this main conversation feed; their owning
 * Activity projection receives the same daemon identities separately.
 */
function createAgentTimelineParts(state = {}) {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const tools = state.tools instanceof Map ? [...state.tools.values()] : [];
    return [
        ...messages.map(messagePart).filter(Boolean),
        ...tools.map((tool, index) => toolPart(tool, messages.length + index)).filter(Boolean),
    ].sort(compareTimelineParts);
}

/**
 * Reconcile keyed timeline rows without replacing the feed or unrelated rows.
 * `create` and `patch` are presentation callbacks so this module cannot learn
 * about Topic persistence, daemon commands, ToolBox execution or approvals.
 */
function reconcileAgentTimeline(container, parts, callbacks, rows = new Map()) {
    const desired = new Set();
    for (const part of parts) {
        const key = timelinePartKey(part);
        desired.add(key);
        let row = rows.get(key);
        if (!row || row.dataset.agentTimelineKind !== part.kind) {
            row?.remove();
            row = callbacks.create(part);
            row.dataset.agentTimelineKey = key;
            row.dataset.agentTimelineKind = part.kind;
            rows.set(key, row);
        } else {
            const patched = callbacks.patch?.(row, part);
            if (patched && patched !== row) {
                row.replaceWith(patched);
                row = patched;
                row.dataset.agentTimelineKey = key;
                row.dataset.agentTimelineKind = part.kind;
                rows.set(key, row);
            }
        }
        // append() moves an existing node instead of recreating it, which also
        // gives sequence reordering a deterministic, keyed implementation.
        container.append(row);
    }
    for (const [key, row] of rows) {
        if (!desired.has(key)) {
            row.remove();
            rows.delete(key);
        }
    }
    return rows;
}

export {
    createAgentTimelineParts,
    projectVcpToolPresentation,
    reconcileAgentTimeline,
    timelinePartKey,
};
