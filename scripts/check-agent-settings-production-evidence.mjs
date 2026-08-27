import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reportPath = path.join(root, 'reports', 'vcp-agent-settings-production.json');
const screenshotPath = path.join(root, 'reports', 'vcp-agent-settings-production.png');

assert.ok(fs.existsSync(reportPath), `Agent Settings production report is missing: ${reportPath}`);
assert.ok(fs.existsSync(screenshotPath), `Agent Settings production screenshot is missing: ${screenshotPath}`);
assert.ok(fs.statSync(screenshotPath).size > 20_000, 'Agent Settings production screenshot is unexpectedly small');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.source, 'VCP production Agent Settings Electron Surface');
assert.deepEqual(report.viewport, { width: 800, height: 600, deviceScaleFactor: 1 });
assert.equal(typeof report.dom, 'string');
for (const id of [
    'agentNameInput', 'agentModel', 'agentTemperature', 'agentContextTokenLimit',
    'agentMaxOutputTokens', 'agentTopP', 'agentTopK',
    'agentStreamOutputTrue', 'agentStreamOutputFalse',
]) assert.match(report.dom, new RegExp(`id="${id}"`), `production DOM is missing ${id}`);

assert.ok(Array.isArray(report.inputs) && report.inputs.length >= 7, 'typed Agent Input evidence is incomplete');
assert.ok(Array.isArray(report.inputNodes) && report.inputNodes.length >= 7, 'native Agent Input style evidence is incomplete');
assert.ok(Array.isArray(report.toggles) && report.toggles.length >= 2, 'typed Agent Toggle evidence is incomplete');
assert.equal(Array.isArray(report.choice) ? report.choice.length : 0, 1, 'typed Agent Choice evidence is incomplete');
assert.equal(Array.isArray(report.streamRadios) ? report.streamRadios.length : 0, 2, 'native Agent stream radio evidence is incomplete');

console.log(JSON.stringify({
    source: report.source,
    viewport: report.viewport,
    inputs: report.inputs.length,
    toggles: report.toggles.length,
    choiceGroups: report.choice.length,
    streamRadios: report.streamRadios.length,
    screenshotBytes: fs.statSync(screenshotPath).size,
    status: 'production-baseline-valid',
}, null, 2));
