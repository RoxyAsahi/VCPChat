import assert from 'node:assert/strict';
import { createAgentRendererHtmlCache } from '../modules/ui-system/agent-presentation/fork/agent-renderer-markdown-pipeline.js';

let renders = 0;
const cache = createAgentRendererHtmlCache({
    version: 'test-v1',
    maxBytes: 200,
    maxEntries: 2,
    maxSingleBytes: 120,
    minTextLength: 4,
    maxTextLength: 100,
    getSettings: () => ({ enableAiMessageButtons: true }),
    containsScopedHtml: (text) => text.includes('<style'),
    renderUncached: (text) => { renders += 1; return `<p>${text}</p>`; },
});

assert.equal(cache.render('abc'), '<p>abc</p>');
assert.equal(cache.render('abc'), '<p>abc</p>');
assert.equal(renders, 2, 'small messages must bypass the cache');

assert.equal(cache.render('message-one'), '<p>message-one</p>');
assert.equal(cache.render('message-one'), '<p>message-one</p>');
assert.equal(renders, 3, 'the second stable render must hit the cache');
assert.equal(cache.stats.hits, 1);

cache.render('message-two');
cache.render('message-three');
assert.ok(cache.size <= 2, 'the cache must enforce its entry bound');
assert.ok(cache.stats.evictions >= 1);

cache.render('<style>unsafe</style>');
cache.render('<style>unsafe</style>');
assert.ok(cache.stats.skips >= 3, 'scoped HTML must bypass raw HTML caching');

cache.clear();
assert.equal(cache.size, 0);
console.log('Agent renderer HTML cache tests passed.');
