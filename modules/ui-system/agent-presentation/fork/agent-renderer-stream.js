import { createAnimationFrameBatcher } from '../stream-batcher.js';

function createAgentRendererStream({ requestFrame, cancelFrame, onFlush }) {
    if (typeof requestFrame !== 'function') throw new TypeError('requestFrame is required');
    if (typeof onFlush !== 'function') throw new TypeError('onFlush is required');
    const streams = new Map();
    const batcher = createAnimationFrameBatcher({
        requestFrame,
        cancelFrame,
        flush(batch) {
            for (const [messageId, content] of batch) onFlush(messageId, content);
        },
    });

    return {
        has: (messageId) => streams.has(messageId),
        start(message) {
            const messageId = message?.id;
            if (!messageId) throw new TypeError('Streaming Agent message requires message.id');
            streams.set(messageId, {
                message: { ...message, state: 'streaming' },
                content: typeof message.content === 'string' ? message.content : '',
            });
        },
        append(messageId, chunkData, context) {
            const current = streams.get(messageId)
                || { message: { id: messageId, role: 'assistant', state: 'streaming' }, content: '' };
            const delta = typeof chunkData === 'string'
                ? chunkData
                : chunkData?.delta ?? chunkData?.text ?? chunkData?.content ?? '';
            current.content += String(delta || '');
            current.context = context || current.context;
            streams.set(messageId, current);
            batcher.enqueue(messageId, current.content);
        },
        finalize(messageId, finalPayload = null) {
            const current = streams.get(messageId) || {};
            const finalContent = typeof finalPayload === 'string'
                ? finalPayload
                : finalPayload?.content ?? finalPayload?.text ?? current.content ?? '';
            batcher.flushNow();
            streams.delete(messageId);
            return { current, finalContent };
        },
        clear() {
            streams.clear();
        },
        dispose() {
            batcher.dispose();
            streams.clear();
        },
    };
}

export { createAgentRendererStream };
