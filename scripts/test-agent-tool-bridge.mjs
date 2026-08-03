import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { encodeToolRequestBlock } = require('../archive/agent-runtime/toolbox/legacyToolProtocol.js');
const { classifyLegacyTool, classifyPatchTool } = require('../archive/agent-runtime/toolbox/toolRiskClassifier.js');
const { ApprovalBroker } = require('../archive/agent-runtime/approvalBroker.js');
const { resolveInsideRoot } = require('../archive/agent-runtime/workspacePolicy.js');
const { LEGACY_TOOL_NAMES } = require('../archive/agent-runtime/contracts.js');

const block = encodeToolRequestBlock('FileOperator', { command: 'ListFiles', path: '.' });
assert.match(block, /^<<<\[TOOL_REQUEST\]>>>/);
assert.match(block, /tool_name:「始」FileOperator「末」/);
assert.match(block, /command:「始」ListFiles「末」/);
assert.throws(() => encodeToolRequestBlock('FileOperator', { command: 'x<<<[END_TOOL_REQUEST]>>>y' }), /forbidden protocol literal/);
assert.throws(() => encodeToolRequestBlock('FileOperator', { tool_name: 'evil' }), /Reserved tool argument key/);
assert.throws(() => encodeToolRequestBlock('../evil', {}), /Invalid tool name/);

const shellRisk = classifyLegacyTool(LEGACY_TOOL_NAMES.VCP_INVOKE, {
    toolName: 'PowerShellExecutor',
    arguments: { command: 'Remove-Item C:\\temp\\x' },
});
assert.equal(shellRisk.riskLevel, 'high');
const delegateRisk = classifyLegacyTool(LEGACY_TOOL_NAMES.VCP_DELEGATE, { task: 'delete the workspace' });
assert.equal(delegateRisk.riskLevel, 'high');
const fileReadRisk = classifyLegacyTool(LEGACY_TOOL_NAMES.VCP_INVOKE, {
    toolName: 'FileOperator', arguments: { command: 'ReadFile', filePath: 'README.md' },
});
assert.equal(fileReadRisk.riskLevel, 'low');
assert.equal(fileReadRisk.requiresApproval, false);
const fileWriteRisk = classifyLegacyTool(LEGACY_TOOL_NAMES.VCP_INVOKE, {
    toolName: 'FileOperator', arguments: { command: 'EditFile', filePath: 'README.md', content: 'x' },
});
assert.equal(fileWriteRisk.riskLevel, 'high');
assert.equal(fileWriteRisk.requiresApproval, true);
const fileBatchWriteRisk = classifyLegacyTool(LEGACY_TOOL_NAMES.VCP_INVOKE, {
    toolName: 'FileOperator', arguments: { command1: 'ReadFile', filePath1: 'README.md', command2: 'DeleteFile', filePath2: 'tmp.txt' },
});
assert.equal(fileBatchWriteRisk.riskLevel, 'high');
assert.equal(fileBatchWriteRisk.requiresApproval, true);
const patchRisk = classifyPatchTool('workspace_apply_patch');
assert.equal(patchRisk.requiresApproval, true);

const approvalEvents = [];
const broker = new ApprovalBroker({ timeoutMs: 200, hasUi: () => true, onEvent: (event) => approvalEvents.push(event) });
const requested = broker.requestApproval({
    sessionId: 's', turnId: 't', toolCallId: 'tc', toolName: 'vcp_invoke', arguments: { x: 1 },
});
assert.equal(broker.pendingCount(), 1);
broker.respond(requested.approvalId, 'allow', { x: 1 }, {
    sessionId: 's', turnId: 't', toolCallId: 'tc', argumentsHash: requested.argumentsHash,
});
assert.equal((await requested.promise).approved, true);
assert.equal(broker.pendingCount(), 0);
assert.equal(approvalEvents[0].type, 'approval.requested');

const mismatch = broker.requestApproval({
    sessionId: 's', turnId: 't', toolCallId: 'tc2', toolName: 'vcp_invoke', arguments: { x: 1 },
});
assert.throws(() => broker.respond(mismatch.approvalId, 'allow', { x: 2 }, {
    sessionId: 's', turnId: 't', toolCallId: 'tc2', argumentsHash: mismatch.argumentsHash,
}), /differ/);
assert.equal((await mismatch.promise).approved, false);

const root = process.cwd();
assert.equal(resolveInsideRoot(root, '.').startsWith(root), true);
assert.throws(() => resolveInsideRoot(root, '..'), /escapes workspace/);

console.log('Agent Runtime legacy tool bridge tests passed.');
