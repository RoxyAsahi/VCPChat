import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportPath = path.join(root, 'reports', 'vcp-agent-model-picker-candidate.json');
const screenshotPath = path.join(root, 'reports', 'vcp-agent-model-picker-candidate.png');
const referenceCss = fs.readFileSync(path.join(root, 'docs/reference/deepseek-harness-primitives/model-picker.css'), 'utf8');
assert.ok(fs.existsSync(reportPath), `Agent Model Picker Candidate report is missing: ${reportPath}`);
assert.ok(fs.existsSync(screenshotPath), `Agent Model Picker Candidate screenshot is missing: ${screenshotPath}`);
assert.ok(fs.statSync(screenshotPath).size > 1_000, 'Agent Model Picker Candidate screenshot is unexpectedly small');
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.source, 'VCP generated AgentModelPicker Candidate Electron capture');
assert.equal(report.provenance, 'deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx');
assert.deepEqual(report.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
assert.equal(report.productionConsumer, false, 'Candidate evidence must not claim a production consumer');
assert.equal(report.status, 'candidate-interaction-active');
assert.equal(report.rootPane.triggerHeight, '28px');
assert.equal(report.rootPane.cardPresent, true);
assert.match(report.dom, /vcp-harness-agent-model-picker-trigger/);
assert.equal(report.trigger.tag, 'button');
assert.equal(report.trigger.ariaHaspopup, 'menu');
assert.ok(report.trigger.ariaControls && report.trigger.ariaControls === report.menu?.id,
    'model trigger aria-controls must reference the rendered menu id');
assert.equal(report.trigger.height, '28px');
assert.equal(report.trigger.borderRadius, '24px');
assert.equal(report.menu?.tag, 'div');
assert.equal(report.menu?.role, 'menu');
assert.match(report.menu?.id || '', /^vcp-harness-agent-model-picker-menu-/);
assert.ok(report.menu?.ariaLabel, 'model picker menu must expose an accessible label');
assert.equal(report.menu?.ariaBusy, null, 'ready model picker menu must not remain aria-busy');
assert.equal(report.menu?.cssContract?.borderRadius, '12px');
assert.equal(typeof report.menu?.borderRadius, 'string');
assert.ok(report.menu?.rect?.width > 0 && report.menu?.rect?.height > 0,
    'visible model picker menu must have measurable geometry');
assert.ok(report.menu.rect.x >= 0 && report.menu.rect.x + report.menu.rect.width <= report.viewport.width,
    'visible model picker menu must remain inside the fixed viewport');
assert.ok(report.menu.rect.y >= 0 && report.menu.rect.y + report.menu.rect.height <= report.viewport.height,
    'visible model picker menu must remain vertically inside the fixed viewport');
assert.ok(report.menu.rect.width >= 240, 'visible model picker menu must preserve the 240px Harness width contract');
assert.match(referenceCss, /\.menu\s*\{[^}]*right:\s*0[^}]*bottom:\s*calc\(100% \+ 8px\)/s,
    'Harness reference must retain right/bottom menu placement');
assert.equal(report.modelPane.searchVisible, true);
assert.equal(report.modelPane.optionCount, 3);
assert.deepEqual(report.modelPane.disabledOptions, ['Llama 3.3Local']);
assert.match(report.keyboardNavigation.activeOption || '', /Claude 3\.7 Sonnet/,
    'ArrowDown must move the active model option');
assert.equal(report.effortPane.optionCount, 2);
assert.equal(report.disposed, true);
console.log(JSON.stringify({ source: report.source, viewport: report.viewport, modelOptions: report.modelPane.optionCount, effortOptions: report.effortPane.optionCount, disposed: report.disposed, status: report.status }, null, 2));
