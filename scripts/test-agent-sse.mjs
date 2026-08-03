import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseOpenAiSse, splitModelDelta } = require('../archive/agent-runtime/runtimeManager.js');

const encoder = new TextEncoder();
const payload = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"think","tool_calls":[{"index":0,"id":"call_1","function":{"name":"vcp_","arguments":"{\\"task\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"delegate","arguments":"\\"ok\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}}\n\n',
    'data: [DONE]\n\n',
].join('');
const cuts = [7, 23, 61, 120, payload.length];
let previous = 0;
const stream = new ReadableStream({
    pull(controller) {
        const cut = cuts.shift();
        if (cut === undefined) return controller.close();
        controller.enqueue(encoder.encode(payload.slice(previous, cut)));
        previous = cut;
    },
});
const chunks = [];
await parseOpenAiSse(stream, (chunk) => chunks.push(chunk));
assert.equal(chunks.length, 3);
assert.equal(chunks[0].choices[0].delta.content, 'hello');
assert.equal(chunks[1].choices[0].delta.reasoning_content, 'think');
assert.equal(chunks[2].usage.total_tokens, 7);

const large = '你'.repeat(6000);
const slices = splitModelDelta({ content: large }, 8 * 1024);
assert.equal(slices.map((entry) => entry.content).join(''), large);
assert.equal(slices.every((entry) => Buffer.byteLength(entry.content, 'utf8') <= 8 * 1024), true);

console.log('Agent Runtime OpenAI SSE parsing and 8KB UTF-8 slicing tests passed.');
