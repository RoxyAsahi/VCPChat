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
assert.match(report.dom, /<button[^>]*id="openModelSelectBtn"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'model trigger must retain the canonical button id and Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="openModelSelectBtn"[^>]*aria-label="选择模型"/,
    'model trigger must expose an explicit accessible name');
assert.match(report.dom, /<button[^>]*type="submit"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Agent save action must remain a native submit button with Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="deleteAgentBtn"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Agent delete action must retain its canonical button id and Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="refreshTtsModelsBtn"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'TTS refresh action must retain its canonical button id and Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="refreshTtsModelsBtn"[^>]*aria-label="刷新模型列表"/,
    'TTS refresh action must expose an explicit accessible name');
assert.match(report.dom, /<button(?=[^>]*id="openModelSelectBtn")(?=[^>]*type="button")[^>]*>/,
    'model trigger must remain a non-submitting native button');
assert.match(report.dom, /<button(?=[^>]*id="refreshTtsModelsBtn")(?=[^>]*type="button")[^>]*>/,
    'TTS refresh action must remain a non-submitting native button');
assert.match(report.dom, /<button(?=[^>]*id="deleteAgentBtn")(?=[^>]*type="button")[^>]*>/,
    'Agent delete action must remain a non-submitting native button');
assert.match(report.dom, /<button[^>]*type="submit"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Agent save action must retain submit semantics after Button mounting');

assert.ok(Array.isArray(report.inputs) && report.inputs.length >= 7, 'typed Agent Input evidence is incomplete');
assert.ok(Array.isArray(report.inputNodes) && report.inputNodes.length >= 7, 'native Agent Input style evidence is incomplete');
assert.deepEqual(report.inputNodes.map(node => node.id).sort(), [
    'agentContextTokenLimit', 'agentMaxOutputTokens', 'agentModel', 'agentNameInput', 'agentTemperature', 'agentTopK', 'agentTopP',
].sort(), 'typed Agent Input evidence must target the seven canonical fields');
for (const node of report.inputNodes) {
    assert.equal(node.style.height, '22px', 'typed Agent native input must keep the Harness 22px line box');
    assert.equal(node.style.padding, '0px 10px', 'typed Agent native input padding drifted');
    assert.equal(node.style.lineHeight, '22px', 'typed Agent native input line-height drifted');
    assert.equal(node.style.borderRadius, '0px', 'typed Agent native input must defer radius to the Harness wrapper');
}
assert.ok(Array.isArray(report.toggles) && report.toggles.length >= 2, 'typed Agent Toggle evidence is incomplete');
assert.deepEqual(report.toggles.map(node => node.controlId).sort(), ['disableCustomColors', 'useThemeColorsInChat'], 'typed Agent Toggle evidence must target canonical appearance controls');
assert.equal(Array.isArray(report.choice) ? report.choice.length : 0, 1, 'typed Agent Choice evidence is incomplete');
assert.equal(Array.isArray(report.choiceOptions) ? report.choiceOptions.length : 0, 2, 'typed Agent Choice option evidence is incomplete');
assert.deepEqual(report.choiceOptions.map(node => node.controlId).sort(), ['agentStreamOutputFalse', 'agentStreamOutputTrue'], 'Choice options must retain canonical radio ids');
assert.equal(Array.isArray(report.streamRadios) ? report.streamRadios.length : 0, 2, 'native Agent stream radio evidence is incomplete');
assert.equal(Array.isArray(report.ranges) ? report.ranges.length : 0, 1, 'typed Agent Range evidence is incomplete');
assert.equal(Array.isArray(report.rangeInputs) ? report.rangeInputs.length : 0, 1, 'native Agent range evidence is incomplete');
assert.equal(Array.isArray(report.selects) ? report.selects.length : 0, 2, 'typed Agent Select evidence is incomplete');
assert.equal(Array.isArray(report.selectNodes) ? report.selectNodes.length : 0, 2, 'native Agent Select evidence is incomplete');
assert.equal(report.rangeInputs[0].id, 'agentTtsSpeed', 'typed Agent Range must retain the canonical TTS speed node');
assert.equal(report.ranges[0].controlId, 'agentTtsSpeed', 'typed Agent Range wrapper must target the canonical TTS speed node');
assert.deepEqual(report.selectNodes.map(node => node.id).sort(), ['agentTtsVoicePrimary', 'agentTtsVoiceSecondary'], 'typed Agent Select evidence must target both canonical TTS voice nodes');
assert.deepEqual(report.selects.map(node => node.controlId).sort(), ['agentTtsVoicePrimary', 'agentTtsVoiceSecondary'], 'typed Agent Select wrappers must target both canonical TTS voice nodes');
assert.equal(report.choiceOptions.every(node => node.tag === 'label'), true, 'Choice options must remain native radio labels');
if (report.agentSelectInteraction !== null && report.agentSelectInteraction !== undefined) {
    assert.deepEqual(report.agentSelectInteraction, {
        opened: true, menuOwner: true, role: 'menu', closed: true, focusRestored: true,
    }, 'voice Select interaction evidence must prove portal open, Escape close, and focus restore');
}

console.log(JSON.stringify({
    source: report.source,
    viewport: report.viewport,
    inputs: report.inputs.length,
    toggles: report.toggles.length,
    choiceGroups: report.choice.length,
    choiceOptions: report.choiceOptions.length,
    streamRadios: report.streamRadios.length,
    ranges: report.ranges.length,
    selects: report.selects.length,
    modelTriggerButton: 'openModelSelectBtn',
    agentSelectInteraction: report.agentSelectInteraction ?? null,
    screenshotBytes: fs.statSync(screenshotPath).size,
    status: 'production-baseline-valid',
}, null, 2));
