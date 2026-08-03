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
const settings = {
    vcpServerUrl: `http://127.0.0.1:${envValue('PORT') || '6005'}`,
    vcpApiKey: envValue('Key'),
};
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
            // This test exposes only VCP bridge tools and approves once. The model
            // is instructed to call SciCalculator; any unexpected second request fails.
            assert.equal(approval.toolName, 'vcp_invoke');
            assert.equal(approvalCount, 1, 'unexpected additional approval request');
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

async function waitUntil(predicate, timeoutMs = 300000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('live tool run timed out');
}

try {
    assert.equal((await manager.start()).state, 'ready');
    const session = await manager.createSession({
        model,
        systemPrompt: [
            'You are an integration test agent.',
            'You MUST call vcp_invoke exactly once with toolName="SciCalculator" and arguments={"expression":"6*7"}.',
            'After receiving the tool result, answer with exactly TOOL_RESULT_42.',
            'Do not call vcp_delegate and do not call any other tool.',
        ].join(' '),
    });
    const turn = await manager.startTurn({ sessionId: session.sessionId, prompt: 'Run the required calculator test now.' });
    await waitUntil(() => ['idle', 'failed'].includes(manager.registry.get(session.sessionId).state));
    const turnRecord = manager.registry.get(session.sessionId).getTurn(turn.turnId);
    assert.equal(turnRecord.state, 'completed');
    assert.equal(approvalCount, 1);
    assert.equal(events.some((event) => event.type === 'tool.requested'), true);
    assert.equal(events.some((event) => event.type === 'tool.completed'), true);
    const output = events
        .filter((event) => event.type === 'assistant.delta')
        .map((event) => event.payload.text)
        .join('');
    assert.match(output, /TOOL_RESULT_42/);
    console.log(JSON.stringify({
        ok: true,
        model,
        approvalCount,
        output: output.slice(0, 500),
        toolEvents: events.filter((event) => event.type.startsWith('tool.')).map((event) => event.type),
    }, null, 2));
} finally {
    await manager.stop();
}
