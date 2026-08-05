// Renderer-only timeline adapter for the Agent Workbench.
//
// Codex remains the execution/context authority and SQLite owns the durable UI
// projection. This module only turns projected state into stable display parts
// and reconciles their DOM nodes in place.

function sequenceOf(value) {
    if (value == null || value === '') return null;
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
    if (part.kind === 'tool-group') return `tool-group:${part.id}`;
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
    const item = payload.item && typeof payload.item === 'object' ? payload.item : {};
    let itemArguments = item.arguments;
    if (typeof itemArguments === 'string') {
        try { itemArguments = JSON.parse(itemArguments); } catch { itemArguments = null; }
    }
    const target = String(payload.toolName || itemArguments?.tool || item.tool || tool.name || 'vcp_invoke');
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

function toolGroupPart(parts) {
    const first = parts[0];
    return {
        kind: 'tool-group',
        id: first.toolCallId,
        turnId: first.turnId,
        sequence: first.sequence,
        timestamp: first.timestamp,
        snapshotOrdinal: first.snapshotOrdinal,
        index: first.index,
        toolCallIds: parts.map((part) => part.toolCallId),
        blocks: parts.flatMap((part) => part.blocks || []),
        value: {
            turnId: first.turnId,
            tools: parts.map((part) => part.value),
        },
    };
}

// Cherry-style display grouping: only adjacent tools from the same identified
// Turn are folded together. Messages, reasoning/error rows and unassociated
// tools are hard boundaries, so grouping cannot invent protocol ownership.
function groupConsecutiveToolParts(parts = []) {
    const grouped = [];
    let pending = [];
    const flush = () => {
        if (pending.length === 1) grouped.push(pending[0]);
        else if (pending.length > 1) grouped.push(toolGroupPart(pending));
        pending = [];
    };
    for (const part of parts) {
        const canJoin = part.kind === 'tool'
            && Boolean(part.turnId)
            && (pending.length === 0 || pending[0].turnId === part.turnId);
        if (canJoin) {
            pending.push(part);
            continue;
        }
        flush();
        if (part.kind === 'tool' && part.turnId) pending.push(part);
        else grouped.push(part);
    }
    flush();
    return grouped;
}

// Bubble-mode metadata for visually continuous Agent activity.  This is a
// presentation-only grouping: protocol ownership still comes exclusively
// from the real Turn/Agent identities carried by each projected part.
function classifyAgentMessageGroups(parts = []) {
    const groups = new Map();
    let active = null;

    for (const part of parts) {
        const key = timelinePartKey(part);
        if (part.kind === 'tool' || part.kind === 'tool-group') {
            if (active && part.turnId && part.turnId === active.turnId) {
                groups.set(key, { position: 'continuation', groupId: active.groupId });
            } else {
                active = null;
                groups.set(key, { position: 'standalone', groupId: null });
            }
            continue;
        }

        if (part.kind !== 'message' || part.value?.role !== 'assistant') {
            active = null;
            groups.set(key, { position: 'standalone', groupId: null });
            continue;
        }

        const turnId = part.turnId || null;
        const agentId = part.value?.agentId || part.value?.participantId || part.value?.name || 'assistant';
        const continues = Boolean(turnId && active
            && active.turnId === turnId
            && active.agentId === agentId);
        const groupId = continues ? active.groupId : `turn:${turnId || key}`;
        groups.set(key, { position: continues ? 'continuation' : 'first', groupId });
        active = turnId ? { turnId, agentId, groupId } : null;
    }

    return groups;
}

function applyAgentMessageGroups(parts, rows) {
    const groups = classifyAgentMessageGroups(parts);
    for (const part of parts) {
        const row = rows.get(timelinePartKey(part));
        if (!row) continue;
        const group = groups.get(timelinePartKey(part));
        if (!group || group.position === 'standalone') {
            delete row.dataset.agentAvatarPosition;
            delete row.dataset.agentMessageGroup;
        } else {
            row.dataset.agentAvatarPosition = group.position;
            row.dataset.agentMessageGroup = group.groupId;
        }
        const avatar = row.querySelector?.('.chat-avatar');
        if (avatar) {
            if (group?.position === 'continuation') avatar.setAttribute('aria-hidden', 'true');
            else avatar.removeAttribute('aria-hidden');
        }
    }
}

/**
 * Canonical, ephemeral AgentTimelinePart projection.  Approval and observer
 * parts deliberately stay out of this main conversation feed; their owning
 * Activity projection receives the same daemon identities separately.
 */
function createAgentTimelineParts(state = {}) {
    const messages = Array.isArray(state.messages) ? state.messages : [];
    const tools = state.tools instanceof Map ? [...state.tools.values()] : [];
    const parts = [
        ...messages.map(messagePart).filter(Boolean),
        ...tools.map((tool, index) => toolPart(tool, messages.length + index)).filter(Boolean),
    ].sort(compareTimelineParts);
    return groupConsecutiveToolParts(parts);
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
            rows.set(key, row);
        } else {
            const patched = callbacks.patch?.(row, part);
            if (patched && patched !== row) {
                row.replaceWith(patched);
                row = patched;
                rows.set(key, row);
            }
        }
        // Message presentation patches synchronize their renderer-owned root
        // attributes and may discard coordinator metadata. Reassert the
        // canonical timeline identity after every create/patch so messages and
        // tool cards remain equally stable across reloads and keyed reorders.
        row.dataset.agentTimelineKey = key;
        row.dataset.agentTimelineKind = part.kind;
        // append() moves an existing node instead of recreating it, which also
        // gives sequence reordering a deterministic, keyed implementation.
        container.append(row);
    }
    applyAgentMessageGroups(parts, rows);
    for (const [key, row] of rows) {
        if (!desired.has(key)) {
            row.remove();
            rows.delete(key);
        }
    }
    return rows;
}

export {
    classifyAgentMessageGroups,
    createAgentTimelineParts,
    groupConsecutiveToolParts,
    projectVcpToolPresentation,
    reconcileAgentTimeline,
    timelinePartKey,
};
