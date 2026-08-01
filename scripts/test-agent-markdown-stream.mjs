import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
    canReusePendingMarkdownBlock,
    projectMarkdownStream,
    streamMarkdown,
} from '../modules/ui-system/agent-presentation/markdown-stream.js';
import {
    createAgentStreamingAccumulator,
    mergeAgentStreamingChunk,
} from '../modules/ui-system/agent-presentation/streaming-accumulator.js';
import { patchAgentStreamingMarkdown } from '../modules/ui-system/agent-presentation/markdown-stream-dom.js';

assert.deepEqual(streamMarkdown('before\n\n```ts\nconst x = 1', true).map(({ key, ...block }) => block), [
    { raw: 'before\n\n', src: 'before\n\n', mode: 'full' },
    { raw: '```ts\nconst x = 1', src: 'const x = 1', mode: 'code', language: 'ts', complete: undefined },
]);

const completedFence = streamMarkdown('before\n\n```ts\nconst x = 1\n```', true);
assert.equal(completedFence.at(-1).complete, true);
assert.equal(completedFence.at(-1).src, 'const x = 1');

const initial = projectMarkdownStream(undefined, '# Plan\n\n```ts\nconst one = 1\n', true);
const advanced = projectMarkdownStream(initial, `${initial.text}const two = 2\n`, true);
assert.strictEqual(advanced.blocks[0], initial.blocks[0], 'frozen head must retain object identity');
assert.equal(advanced.blocks.at(-1).src, 'const one = 1\nconst two = 2\n');

const replaced = projectMarkdownStream(advanced, '# Replacement\n\nnew body', true);
assert.deepEqual(replaced.blocks.map((block) => block.mode), ['full', 'live']);
assert.equal(canReusePendingMarkdownBlock(initial.blocks.at(-1), advanced.blocks.at(-1)), true);
assert.equal(canReusePendingMarkdownBlock(initial.blocks.at(-1), replaced.blocks.at(-1)), false);

assert.deepEqual(streamMarkdown('[docs][1]\n\n[1]: https://example.com', true).map((block) => block.mode), ['live']);
assert.equal(mergeAgentStreamingChunk('hello world', 'world!'), 'hello world!');
assert.equal(mergeAgentStreamingChunk('hello', 'hello world'), 'hello world');
assert.equal(mergeAgentStreamingChunk('hello', 'hello'), 'hello');
const accumulator = createAgentStreamingAccumulator();
accumulator.append('hello');
accumulator.append('hello world');
accumulator.append(' world!');
assert.equal(accumulator.value, 'hello world!');

const dom = new JSDOM('<!doctype html><div class="md-content"></div>');
const content = dom.window.document.querySelector('.md-content');
const marked = { parse: (value) => `<p>${value}</p>` };
patchAgentStreamingMarkdown(content, '# Plan\n\n```ts\nconst one = 1\n', marked);
const frozenHead = content.querySelector('[data-agent-markdown-key="markdown:0"]');
const liveCode = content.querySelector('[data-agent-markdown-key="markdown:1"]');
patchAgentStreamingMarkdown(content, '# Plan\n\n```ts\nconst one = 1\nconst two = 2\n', marked);
assert.strictEqual(content.querySelector('[data-agent-markdown-key="markdown:0"]'), frozenHead,
    'frozen Markdown DOM must not be replaced by a code delta');
assert.strictEqual(content.querySelector('[data-agent-markdown-key="markdown:1"]'), liveCode,
    'open code DOM must be patched in place');
assert.match(liveCode.textContent, /const two/);
dom.window.close();

console.log('Agent markdown frozen-tail and stream accumulator tests passed.');
