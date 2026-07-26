import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { AgentRuntimeManager } = require('../modules/agent-runtime/runtimeManager.js');
const stored = JSON.parse(fs.readFileSync(path.join(root, 'AppData', 'settings.json'), 'utf8'));
const settings = {
    vcpServerUrl: process.env.VCP_SERVER_URL || stored.vcpServerUrl,
    vcpApiKey: process.env.VCP_API_KEY || stored.vcpApiKey,
};
const toolboxRoot = process.env.VCP_TOOLBOX_ROOT || path.resolve(root, '..', '..', 'VCPToolBox-upstream-latest');
const approvalPath = path.join(toolboxRoot, 'toolApprovalConfig.json');
const approvalBefore = fs.existsSync(approvalPath) ? fs.readFileSync(approvalPath, 'utf8') : null;
const events = [];
let manager;
let node;

function waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const timer = setInterval(() => {
            if (predicate()) { clearInterval(timer); resolve(); }
            else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error(`${label} timed out`)); }
        }, 100);
    });
}

try {
    assert.ok(settings.vcpServerUrl && settings.vcpApiKey, 'VCP settings are required');
    if (approvalBefore) {
        const config = JSON.parse(approvalBefore);
        fs.writeFileSync(approvalPath, `${JSON.stringify({ ...config, enabled: false }, null, 2)}\n`);
    }
    node = fork(path.join(root, 'scripts', 'live-fileoperator-node.cjs'), [], {
        cwd: root,
        env: { ...process.env, VCP_SERVER_URL: settings.vcpServerUrl, VCP_API_KEY: settings.vcpApiKey, ALLOWED_DIRECTORIES: root },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let nodeOutput = '';
    node.stdout.on('data', (chunk) => { nodeOutput += chunk; });
    node.stderr.on('data', (chunk) => { nodeOutput += chunk; });
    await waitFor(() => /Sent registration for \d+ tools/.test(nodeOutput), 60000, 'FileOperator distributed node registration');

    manager = new AgentRuntimeManager({
        projectRoot: root, driver: 'pi', getSettings: () => settings, hasUi: () => true,
        sendEvent: (event) => {
            events.push(event);
            if (event.type === 'approval.requested') {
                const approval = event.payload.approval;
                queueMicrotask(() => manager.respondApproval({
                    approvalId: approval.approvalId, decision: 'allow', sessionId: approval.sessionId,
                    turnId: approval.turnId, toolCallId: approval.toolCallId, argumentsHash: approval.argumentsHash,
                }));
            }
        },
    });
    await manager.start();
    const session = await manager.createSession({ workspaceRoot: root, model: process.env.VCP_AGENT_MODEL || 'gpt-5.6-terra', systemPrompt: '{{Nova}}' });
    const turn = await manager.startTurn({
        sessionId: session.sessionId,
        prompt: '完成一个多步骤验证：先调用 vcp_invoke(FileOperator, {command:"ListAllowedDirectories"}) 获取真实工作区；再调用 vcp_invoke(SciCalculator, {expression:"6*7"})。必须在两个真实结果都返回后，用中文说明工作区路径和计算值，并包含标记 LONG_TASK_FILE_AND_42。',
    });
    await waitFor(() => ['completed', 'failed', 'cancelled'].includes(manager.registry.get(session.sessionId).getTurn(turn.turnId).state), 240000, 'long task');
    const completed = events.filter((event) => event.type === 'tool.completed');
    const failed = events.filter((event) => event.type === 'tool.failed');
    const output = events.filter((event) => event.type === 'assistant.delta').map((event) => event.payload.text || '').join('');
    assert.equal(manager.registry.get(session.sessionId).getTurn(turn.turnId).state, 'completed');
    assert.equal(completed.length, 2);
    assert.equal(failed.length, 0);
    assert.match(JSON.stringify(completed), /VCPChat-agent-runtime/);
    assert.match(JSON.stringify(completed), /42/);
    assert.match(output, /LONG_TASK_FILE_AND_42/);
    console.log(JSON.stringify({ ok: true, completedTools: completed.length, output: output.slice(0, 500) }, null, 2));
} finally {
    await manager?.stop().catch(() => {});
    if (node && node.exitCode === null) node.kill('SIGTERM');
    if (approvalBefore !== null) fs.writeFileSync(approvalPath, approvalBefore);
}
