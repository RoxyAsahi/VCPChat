const AGENT_BLOCK_KINDS = Object.freeze([
    'text',
    'reasoning',
    'tool',
    'attachment',
    'approval',
    'observation',
    'error',
]);

const BLOCK_KIND_SET = new Set(AGENT_BLOCK_KINDS);

function requireIdentity(value, label) {
    const identity = typeof value === 'string' ? value.trim() : '';
    if (!identity) throw new TypeError(`Agent presentation requires ${label}`);
    return identity;
}

function normalizeBlock(block, fallbackOrdinal) {
    if (!block || typeof block !== 'object') throw new TypeError('AgentBlock must be an object');
    const kind = String(block.kind || block.type || '');
    if (!BLOCK_KIND_SET.has(kind)) throw new TypeError(`Unsupported AgentBlock kind: ${kind || '<empty>'}`);
    const sourceId = requireIdentity(block.id || block.itemId || block.callId, `${kind} block identity`);
    const ordinal = Number.isInteger(block.ordinal) ? block.ordinal : fallbackOrdinal;
    return {
        ...block,
        kind,
        id: sourceId,
        ordinal,
        key: `${kind}:${sourceId}:${ordinal}`,
    };
}

function blocksFromMessage(message) {
    const messageId = requireIdentity(message.id || message.messageId, 'messageId');
    const blocks = [];
    if (message.content !== undefined && message.content !== null && String(message.content) !== '') {
        blocks.push({
            kind: 'text',
            id: messageId,
            text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2),
        });
    }
    if (message.reasoning) {
        blocks.push({ kind: 'reasoning', id: messageId, text: String(message.reasoning) });
    }
    for (const attachment of message.attachments || []) {
        const attachmentId = requireIdentity(attachment?.id || attachment?.itemId, 'attachment identity');
        blocks.push({ ...attachment, kind: 'attachment', id: attachmentId });
    }
    return blocks;
}

function blocksFromTool(tool) {
    const callId = requireIdentity(tool.toolCallId || tool.callId, 'toolCallId');
    return [{
        kind: 'tool',
        id: callId,
        callId,
        name: tool.name || tool.toolName || 'tool',
        state: tool.state || 'requested',
        summary: tool.summary || '',
        payload: tool.payload || {},
    }];
}

function normalizeAgentPresentationPart(part) {
    if (!part || typeof part !== 'object') throw new TypeError('AgentTimelinePart must be an object');
    const kind = String(part.kind || '');
    const value = part.value && typeof part.value === 'object' ? part.value : {};
    const sourceId = kind === 'message'
        ? requireIdentity(part.messageId || part.presentationKey || part.id || value.id || value.messageId || value.presentationKey,
            part.presentationKey || value.presentationKey ? 'presentationKey' : 'messageId')
        : kind === 'tool'
            ? requireIdentity(part.toolCallId || part.id || value.toolCallId || value.callId, 'toolCallId')
            : requireIdentity(part.id, 'part identity');
    const sourceBlocks = Array.isArray(value.blocks) && value.blocks.length > 0
        ? value.blocks
        : kind === 'message'
            ? blocksFromMessage(value)
            : kind === 'tool'
                ? blocksFromTool(value)
                : [{ ...value, kind, id: sourceId }];

    return {
        kind,
        id: sourceId,
        key: `${kind}:${sourceId}`,
        sessionId: part.sessionId || value.sessionId || null,
        threadId: part.threadId || value.threadId || null,
        turnId: part.turnId || value.turnId || null,
        role: value.role || (kind === 'message' ? 'assistant' : 'system'),
        state: value.state || 'complete',
        createdAt: Number(value.createdAt || part.timestamp || 0),
        name: value.name || '',
        avatarUrl: value.avatarUrl || '',
        blocks: sourceBlocks.map(normalizeBlock),
        source: value,
    };
}

function createAgentActionDescriptors(part, capabilities = {}) {
    const normalized = normalizeAgentPresentationPart(part);
    const hasText = normalized.blocks.some((block) => block.kind === 'text');
    const completed = normalized.state === 'complete' || normalized.state === 'completed';
    const streaming = normalized.state === 'streaming' || normalized.state === 'running';
    return [
        hasText && capabilities.copy !== false ? { id: 'copy', label: '复制文本' } : null,
        streaming && capabilities.interrupt ? { id: 'interrupt', label: '中止回复', danger: true } : null,
        completed && capabilities.edit ? { id: 'edit', label: '编辑并分支' } : null,
        completed && capabilities.retry ? { id: 'retry', label: '从此处重试' } : null,
        completed && capabilities.fork ? { id: 'fork', label: '创建分支' } : null,
        hasText && capabilities.forward ? { id: 'forward', label: '转发消息' } : null,
    ].filter(Boolean);
}

export {
    AGENT_BLOCK_KINDS,
    createAgentActionDescriptors,
    normalizeAgentPresentationPart,
};
