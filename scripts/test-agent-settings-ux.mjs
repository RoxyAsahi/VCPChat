import assert from 'node:assert/strict';
import fs from 'node:fs';

const workbench = fs.readFileSync(new URL('../modules/ui-system/agent-workbench.js', import.meta.url), 'utf8');
const settingsView = fs.readFileSync(new URL('../modules/ui-system/agent-settings-view.js', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../modules/codex-runtime/runtimeManager.js', import.meta.url), 'utf8');
const adapter = fs.readFileSync(new URL('../modules/codex-runtime/toolboxResponsesAdapter.js', import.meta.url), 'utf8');

for (const label of ['Agent 默认', '当前会话', '高级']) assert.ok(settingsView.includes(label));
assert.ok(settingsView.includes("'vchat-identity'"));
assert.ok(settingsView.includes("'codex-managed'"));
assert.ok(workbench.includes('reasoningEffortsForModel'));
assert.ok(settingsView.includes('该模型没有提供 reasoning effort capability'));
assert.equal(`${workbench}\n${settingsView}`.includes('用此配置新建会话'), false,
    'settings must not retain the redundant create-Session action');
assert.equal(`${workbench}\n${settingsView}`.includes('长按发送'), false,
    'R11 must not reintroduce the explicitly cancelled advanced-send feature');

assert.ok(runtime.includes("effort ? { effort }"), 'validated effort must reach turn/start');
assert.ok(runtime.includes('REASONING_EFFORT_UNSUPPORTED'));
assert.ok(runtime.includes('_threadInstructionParams'));
assert.ok(adapter.includes("trusted?.mode === 'codex-managed'"));
assert.ok(adapter.includes('chat.reasoning_effort = effort'));

console.log('Agent settings UX contract tests passed.');
