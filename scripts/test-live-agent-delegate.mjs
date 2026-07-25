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
const envValue = (key) => envText.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() || '';
const settings = { vcpServerUrl: `http://127.0.0.1:${envValue('PORT') || 6005}`, vcpApiKey: envValue('Key') };
const model = process.env.VCP_AGENT_MODEL || 'gpt-5.6-terra';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const events = [];
let manager;
let approvalCount = 0;
manager = new AgentRuntimeManager({
    projectRoot,
    driver: 'pi',
    getSettings: () => settings,
    hasUi: () => true,
    sendEvent: (event) => {
        events.push(event);
        if (event.type === 'approval.requested') {
            const approval = event.payload.approval;
            approvalCount += 1;
            assert.equal(approval.toolName, 'vcp_delegate');
            assert.equal(approvalCount, 1);
            queueMicrotask(() => manager.respondApproval({
                approvalId: approval.approvalId,
                decision: 'allow',
                sessionId: approval.sessionId,
                turnId: approval.turnId,
                toolCallId: approval.toolCallId,
                argumentsHash: approval.argumentsHash,
            }));
        }
    },
});
async function waitUntil(predicate, timeoutMs = 360000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('delegate run timed out');
}
try {
    assert.equal((await manager.start()).state, 'ready');
    const session = await manager.createSession({
        model,
        systemPrompt: [
            'You are an integration test agent.',
            'Call vcp_delegate exactly once with task="Do not call any tools. Return exactly DELEGATE_INNER_OK.".',
            'After the delegate result arrives, answer exactly DELEGATE_OUTER_OK.',
            'Never call vcp_invoke.',
        ].join(' '),
    });
    const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'Run the required delegate test.' });
    await waitUntil(() => ['idle', 'failed'].includes(manager.registry.get(session.sessionId).state));
    assert.equal(manager.registry.get(session.sessionId).getTurn(turn.turnId).state, 'completed');
    assert.equal(approvalCount, 1);
    const output = events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text).join('');
    assert.match(output, /DELEGATE_OUTER_OK/);
    assert.equal(events.some((event) => event.type === 'tool.completed'), true);
    console.log(JSON.stringify({ ok: true, model, approvalCount, output: output.slice(0, 500) }, null, 2));
} finally {
    await manager.stop();
}
