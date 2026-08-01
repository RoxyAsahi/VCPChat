import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { JSDOM } from 'jsdom';
import { createAgentRenderContext } from '../modules/ui-system/agent-presentation/fork/agentRenderContext.js';

const root = new URL('../', import.meta.url);
const sourcePath = new URL('modules/messageRenderer.js', root);
const forkPath = new URL('modules/ui-system/agent-presentation/fork/agentMessageRenderer.js', root);
const ledger = JSON.parse(await readFile(new URL('modules/ui-system/agent-presentation/fork/migration-ledger.json', root), 'utf8'));
const source = await readFile(sourcePath);
const fork = await readFile(forkPath, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');

assert.equal(sourceHash, ledger.sourceSha256, 'main-chat messageRenderer changed; review and update the fork receipt explicitly');
assert.doesNotMatch(fork, /window\.agentMessageRendererFork\s*=\s*\{/);
assert.match(fork, /export\s*\{[\s\S]*renderMessage/);
assert.doesNotMatch(fork, /window\.messageRenderer\s*=\s*\{/, 'Agent fork must never overwrite the main renderer global');
assert.doesNotMatch(fork, /from ['"]\.\/renderer\//, 'fork imports must resolve from its independent directory');
for (const capability of ledger.requiredCapabilities) {
    assert.match(fork, new RegExp(`function\\s+${capability}\\s*\\(`), `fork lost required display capability ${capability}`);
}
for (const [dependency, ceiling] of Object.entries(ledger.forbiddenDependencyCeilings)) {
    const count = fork.match(new RegExp(dependency, 'g'))?.length || 0;
    assert.ok(count <= ceiling, `${dependency} increased from migration ceiling ${ceiling} to ${count}`);
}

const dom = new JSDOM('<!doctype html><div id="feed"></div>');
const messages = [{ id: 'item-1', role: 'assistant', content: 'durable projection' }];
const context = createAgentRenderContext({
    container: dom.window.document.getElementById('feed'),
    getSessionContext: () => ({
        sessionId: 'session-1',
        threadId: 'thread-1',
        participant: { id: 'nova', name: 'Nova', avatarUrl: 'nova.png' },
        messages,
        settings: { enableUserChatBubbleUi: true },
    }),
    markedInstance: { parse: (text) => `<p>${text}</p>` },
});
const sessionContext = context.getSessionContext();
assert.notStrictEqual(sessionContext.messages, messages, 'fork context must expose a read-only projection copy');
assert.equal(sessionContext.sessionId, 'session-1');
assert.equal(sessionContext.participant.name, 'Nova');
assert.ok(Object.isFrozen(sessionContext.messages));
dom.window.close();

console.log('Agent messageRenderer full-fork receipt, capability baseline, and read-only context tests passed.');
