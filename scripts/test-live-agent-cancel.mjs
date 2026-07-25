import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { AgentRuntimeManager } = require('../modules/agent-runtime/runtimeManager.js');
const toolboxRoot = process.env.VCP_TOOLBOX_ROOT;
if (!toolboxRoot) throw new Error('VCP_TOOLBOX_ROOT is required');
const envText = fs.readFileSync(path.join(toolboxRoot, 'config.env'), 'utf8');
const val = (key) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() || '';
const settings = { vcpServerUrl: `http://127.0.0.1:${val('PORT') || 6005}`, vcpApiKey: val('Key') };
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manager = new AgentRuntimeManager({
    projectRoot,
    driver: 'pi',
    getSettings: () => settings,
    hasUi: () => true,
    sendEvent: () => {},
});
try {
    await manager.start();
    const session = await manager.createSession({ model: process.env.VCP_AGENT_MODEL || 'gpt-5.6-terra' });
    const turn = await manager.startTurn({
        sessionId: session.sessionId,
        prompt: 'Write a very long essay with at least 10000 words about distributed systems. Do not use tools.',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cancelled = await manager.cancelTurn({ sessionId: session.sessionId, turnId: turn.turnId });
    assert.equal(cancelled.ok, true);
    assert.equal(manager.registry.get(session.sessionId).getTurn(turn.turnId).state, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(manager.registry.get(session.sessionId).getTurn(turn.turnId).state, 'cancelled');
    console.log(JSON.stringify({ ok: true, state: 'cancelled', model: process.env.VCP_AGENT_MODEL || 'gpt-5.6-terra' }, null, 2));
} finally {
    await manager.stop();
}
