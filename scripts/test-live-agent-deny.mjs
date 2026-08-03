import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { AgentRuntimeManager } = require('../archive/agent-runtime/runtimeManager.js');
const toolboxRoot = process.env.VCP_TOOLBOX_ROOT;
if (!toolboxRoot) throw new Error('VCP_TOOLBOX_ROOT is required');
const envText = fs.readFileSync(path.join(toolboxRoot, 'config.env'), 'utf8');
const envValue = (key) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() || '';
const settings = { vcpServerUrl: `http://127.0.0.1:${envValue('PORT') || 6005}`, vcpApiKey: envValue('Key') };
const model = process.env.VCP_AGENT_MODEL || 'gpt-5.6-terra';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events = [];
let manager;
let denied = false;
manager = new AgentRuntimeManager({
    projectRoot,
    driver: 'pi',
    getSettings: () => settings,
    hasUi: () => true,
    sendEvent: (event) => {
        events.push(event);
        if (event.type === 'approval.requested') {
            denied = true;
            const approval = event.payload.approval;
            queueMicrotask(() => manager.respondApproval({ approvalId: approval.approvalId, decision: 'deny' }));
        }
    },
});
async function waitUntil(predicate, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('deny run timed out');
}
try {
    await manager.start();
    const session = await manager.createSession({
        model,
        systemPrompt: [
            'Call vcp_invoke exactly once with toolName="SciCalculator" and arguments={"expression":"100+23"}.',
            'If the tool is denied, answer exactly TOOL_DENIED_OK. Do not retry any tool.',
        ].join(' '),
    });
    const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'Run the denied-tool test.' });
    await waitUntil(() => ['idle', 'failed'].includes(manager.registry.get(session.sessionId).state));
    assert.equal(manager.registry.get(session.sessionId).getTurn(turn.turnId).state, 'completed');
    assert.equal(denied, true);
    assert.equal(events.some((event) => event.type === 'tool.cancelled'), true);
    assert.equal(events.some((event) => event.type === 'tool.started'), false);
    const output = events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text).join('');
    assert.match(output, /TOOL_DENIED_OK/);
    console.log(JSON.stringify({ ok: true, model, denied, output: output.slice(0, 300) }, null, 2));
} finally {
    await manager.stop();
}
