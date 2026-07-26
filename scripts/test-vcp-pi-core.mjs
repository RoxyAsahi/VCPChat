import assert from 'node:assert/strict';
import { Agent, createAssistantMessageEventStream } from '../agent-runtime/vcp-pi-core/index.mjs';

let requestCount = 0;
let agent;

function streamMessage(message) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
        const partial = { ...message, content: message.content.slice() };
        stream.push({ type: 'start', partial });
        for (const part of message.content) {
            if (part.type === 'toolCall') stream.push({ type: 'toolcall_end', partial, toolCall: part });
            if (part.type === 'text') stream.push({ type: 'text_delta', partial, delta: part.text });
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
    });
    return stream;
}

agent = new Agent({
    initialState: {
        systemPrompt: 'test', model: { id: 'test', provider: 'vcp', api: 'openai-completions' },
        tools: [{
            name: 'queue_steering', parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => {
                agent.steer({ role: 'user', content: [{ type: 'text', text: '先检查 steering 是否进入上下文' }], timestamp: 2 });
                return { content: [{ type: 'text', text: 'queued' }], details: {} };
            },
        }],
    },
    toolExecution: 'sequential',
    streamFn: async (_model, context) => {
        requestCount += 1;
        if (requestCount === 1) {
            return streamMessage({
                role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'queue_steering', arguments: {} }],
                stopReason: 'toolUse', usage: {}, timestamp: 1,
            });
        }
        assert.equal(context.messages.at(-1).role, 'user');
        assert.match(context.messages.at(-1).content[0].text, /steering/);
        return streamMessage({
            role: 'assistant', content: [{ type: 'text', text: 'STEERING_OK' }], stopReason: 'stop', usage: {}, timestamp: 3,
        });
    },
});

await agent.prompt('开始');
assert.equal(requestCount, 2);
assert.equal(agent.state.messages.filter((message) => message.role === 'user').length, 2);
assert.equal(agent.state.messages.at(-1).content[0].text, 'STEERING_OK');
console.log('VCP Pi core steering/follow-up boundary test passed.');
