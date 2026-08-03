import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentRuntimeManager } = require('../archive/agent-runtime/runtimeManager.js');

const toolboxRoot = process.env.VCP_TOOLBOX_ROOT;
if (!toolboxRoot) throw new Error('VCP_TOOLBOX_ROOT is required');
const envText = fs.readFileSync(path.join(toolboxRoot, 'config.env'), 'utf8');
function envValue(key) {
    const match = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : '';
}
const settings = {
    vcpServerUrl: `http://127.0.0.1:${envValue('PORT') || '6005'}`,
    vcpApiKey: envValue('Key'),
};
const model = process.env.VCP_AGENT_MODEL || 'gpt-5.6-terra';
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (m) => m.slice(1))), '..');
const events = [];
const manager = new AgentRuntimeManager({
    projectRoot,
    driver: 'pi',
    getSettings: () => settings,
    hasUi: () => true,
    sendEvent: (event) => events.push(event),
});

async function waitUntil(predicate, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('live agent runtime wait timed out');
}

try {
    const status = await manager.start();
    assert.equal(status.state, 'ready');
    const session = await manager.createSession({
        model,
        systemPrompt: 'Answer with exactly the text LIVE_PI_OK and do not use any tools.',
    });
    const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'Return the required exact text now.' });
    await waitUntil(() => ['idle', 'failed'].includes(manager.registry.get(session.sessionId).state));
    const record = manager.registry.get(session.sessionId);
    assert.equal(record.getTurn(turn.turnId).state, 'completed');
    const text = events
        .filter((event) => event.sessionId === session.sessionId && event.type === 'assistant.delta')
        .map((event) => event.payload.text)
        .join('');
    assert.match(text, /LIVE_PI_OK/);
    assert.equal(events.some((event) => event.type === 'tool.requested'), false);
    console.log(JSON.stringify({
        ok: true,
        model,
        sessionId: session.sessionId,
        turnId: turn.turnId,
        output: text.slice(0, 300),
        eventCount: events.length,
    }, null, 2));
} finally {
    await manager.stop();
}
