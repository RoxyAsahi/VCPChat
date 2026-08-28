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
assert.match(report.dom, /<button[^>]*id="openModelSelectBtn"[^>]*class="[^"]*vcp-harness-agent-model-picker-trigger[^\"]*"/,
    'model trigger must retain the canonical button id and model-picker presentation');
assert.match(report.dom, /<button[^>]*id="openModelSelectBtn"[^>]*aria-label="选择模型"/,
    'model trigger must expose an explicit accessible name');
assert.match(report.dom, /<button[^>]*type="submit"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Agent save action must remain a native submit button with Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="deleteAgentBtn"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Agent delete action must retain its canonical button id and Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="refreshTtsModelsBtn"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'TTS refresh action must retain its canonical button id and Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="resetAvatarColorsBtn"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Avatar color reset action must retain its canonical button id and Harness Button presentation');
assert.match(report.dom, /<button[^>]*id="refreshTtsModelsBtn"[^>]*aria-label="刷新模型列表"/,
    'TTS refresh action must expose an explicit accessible name');
assert.match(report.dom, /<button(?=[^>]*id="openModelSelectBtn")(?=[^>]*type="button")[^>]*>/,
    'model trigger must remain a non-submitting native button');
assert.match(report.dom, /class="[^"]*vcp-harness-agent-model-picker-trigger[^"]*"/,
    'Agent model trigger must use the Harness model-picker trigger contract');
assert.ok(Array.isArray(report.modelPicker) && report.modelPicker.length === 1,
    'Agent model picker production projection is missing');
assert.match(report.dom, /<button(?=[^>]*id="refreshTtsModelsBtn")(?=[^>]*type="button")[^>]*>/,
    'TTS refresh action must remain a non-submitting native button');
assert.match(report.dom, /<button(?=[^>]*id="deleteAgentBtn")(?=[^>]*type="button")[^>]*>/,
    'Agent delete action must remain a non-submitting native button');
assert.match(report.dom, /<button(?=[^>]*id="resetAvatarColorsBtn")(?=[^>]*type="button")[^>]*>/,
    'Avatar color reset action must remain a non-submitting native button');
assert.match(report.dom, /<button(?=[^>]*id="resetAvatarColorsBtn")(?=[^>]*style="[^"]*display:\s*inline-flex\s*!important[^"]*")[^>]*>/,
    'Avatar color reset action must retain the Harness inline-flex geometry declaration');
assert.match(report.dom, /<button[^>]*type="submit"[^>]*class="[^"]*vcp-harness-button[^\"]*"/,
    'Agent save action must retain submit semantics after Button mounting');

assert.ok(Array.isArray(report.inputs) && report.inputs.length >= 9, 'typed Agent Input evidence is incomplete');
assert.ok(Array.isArray(report.inputNodes) && report.inputNodes.length >= 9, 'native Agent Input style evidence is incomplete');
assert.deepEqual(report.inputNodes.map(node => node.id).sort(), [
    'agentContextTokenLimit', 'agentMaxOutputTokens', 'agentModel', 'agentNameInput', 'agentTemperature', 'agentTopK', 'agentTopP',
    'agentTtsRegexPrimary', 'agentTtsRegexSecondary',
].sort(), 'typed Agent Input evidence must target the nine canonical fields');
assert.deepEqual((report.regexInputs ?? []).map(node => node.id).sort(), ['agentTtsRegexPrimary', 'agentTtsRegexSecondary'],
    'typed Agent TTS regex Input evidence must target both canonical regex fields');
assert.ok(Array.isArray(report.actionBar) && report.actionBar.length >= 1
    && String(report.actionBar[0].class || '').includes('vcp-ui-settings-action-bar'),
    'Agent Settings action bar must be enhanced by the SettingsActionBar component');
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
assert.ok(Array.isArray(report.actions) && report.actions.length >= 5, 'typed Agent Button evidence is incomplete');
assert.deepEqual(report.actions.map(node => node.controlId).sort(), [
    'deleteAgentBtn', 'openModelSelectBtn', 'refreshTtsModelsBtn', 'resetAvatarColorsBtn',
].sort().concat([null]).sort(), 'Agent action evidence must include the four canonical id buttons and the submit action');
assert.equal(report.actions.filter(node => node.controlId === 'resetAvatarColorsBtn').length, 1,
    'Avatar color reset action must have exactly one mounted Button projection');
assert.ok(Array.isArray(report.colorPairs) && report.colorPairs.length >= 2, 'typed Agent ColorPair evidence is incomplete');
assert.deepEqual(report.colorPairs.map(node => node.controlId).sort(), [
    'agentAvatarBorderColor', 'agentNameTextColor',
].sort(), 'typed Agent ColorPair evidence must target both canonical color inputs');
assert.ok(Array.isArray(report.promptButtons) && report.promptButtons.length >= 3, 'typed Agent prompt mode Button evidence is incomplete');
assert.deepEqual(report.promptButtons.map(node => node.controlId), [null, null, null],
    'prompt mode Buttons must retain their original no-id contract');
assert.deepEqual(report.promptButtons.map(node => node.ariaPressed), ['true', 'false', 'false'],
    'prompt mode Buttons must expose the selected mode through aria-pressed');
for (const button of report.promptButtons) {
    assert.match(button.class, /vcp-harness-button/, 'prompt mode Button must retain Harness presentation');
}
for (const action of report.actions) {
    if (action.controlId === 'openModelSelectBtn') continue;
    assert.match(action.class, /vcp-harness-button/, `Agent action ${action.controlId} must retain Harness Button presentation`);
    assert.ok(Array.isArray(action.style?.authored?.matchedRules), `Agent action ${action.controlId} must report authored CSS rules`);
    assert.ok(action.style.authored.matchedRules.some(rule => rule.selector === '.vcp-harness-button.button' && rule.declarations?.display === 'inline-flex'),
        `Agent action ${action.controlId} must retain the Harness inline-flex rule`);
    assert.equal(action.style.authored.matchedRules.some(rule => rule.declarations?.display === 'flex'
        && rule.selector !== '.vcp-harness-agent-model-picker-trigger'), false,
        `Agent action ${action.controlId} has a conflicting authored display:flex rule`);
}
for (const button of report.promptButtons) {
    assert.ok(Array.isArray(button.style?.authored?.matchedRules), 'prompt mode Button must report authored CSS rules');
    assert.ok(button.style.authored.matchedRules.some(rule => rule.selector === '.vcp-harness-button.button' && rule.declarations?.display === 'inline-flex'),
        'prompt mode Button must retain the Harness inline-flex authored rule');
}
if (report.agentSelectInteraction !== null && report.agentSelectInteraction !== undefined) {
    assert.deepEqual(report.agentSelectInteraction, {
        opened: true, menuOwner: true, role: 'menu', closed: true, focusRestored: true,
    }, 'voice Select interaction evidence must prove portal open, Escape close, and focus restore');
}
if (report.agentRangeInteraction !== null && report.agentRangeInteraction !== undefined) {
    assert.equal(report.agentRangeInteraction.available, true, 'Agent TTS Range interaction evidence is unavailable');
    assert.equal(report.agentRangeInteraction.native, true, 'Agent TTS Range must retain the native range input');
    assert.equal(report.agentRangeInteraction.wrapperOwnsInput, true, 'Agent TTS Range wrapper must retain the native range');
    assert.equal(report.agentRangeInteraction.wrapperOwnsOutput, true, 'Agent TTS Range wrapper must own the canonical value text');
    assert.deepEqual(report.agentRangeInteraction.projected, { value: '1.4', output: '1.4' },
        'Agent TTS Range must project the native input into the one-decimal value text');
    assert.deepEqual(report.agentRangeInteraction.restored, report.agentRangeInteraction.before,
        'Agent TTS Range interaction capture must restore the canonical test value');
}
if (report.agentColorPairInteraction !== null && report.agentColorPairInteraction !== undefined) {
    assert.equal(report.agentColorPairInteraction.available, true, 'Agent ColorPair interaction evidence is unavailable');
    assert.equal(report.agentColorPairInteraction.native, true, 'Agent ColorPair must retain native controls');
    assert.equal(report.agentColorPairInteraction.wrappersOwnControls, true, 'Agent ColorPair wrappers must retain canonical controls');
    assert.deepEqual(report.agentColorPairInteraction.pickerProjection, {
        borderColor: '#112233', borderText: '#112233', previewBorderColor: 'rgb(17, 34, 51)',
    }, 'Agent border ColorPair must sync picker, text and avatar preview');
    assert.deepEqual(report.agentColorPairInteraction.textProjection, { nameColor: '#445566', nameText: '#445566' },
        'Agent name ColorPair must sync valid text into the native color input');
    assert.deepEqual(report.agentColorPairInteraction.invalidRollback, { borderColor: '#112233', borderText: '#112233' },
        'Agent ColorPair must roll invalid text back to the native color value');
    assert.deepEqual(report.agentColorPairInteraction.restored, report.agentColorPairInteraction.before,
        'Agent ColorPair interaction capture must restore canonical controls');
}
if (report.agentInputFocusInteraction !== null && report.agentInputFocusInteraction !== undefined) {
    assert.equal(report.agentInputFocusInteraction.available, true, 'Agent typed Input focus evidence is unavailable');
    assert.equal(report.agentInputFocusInteraction.native, true, 'Agent typed Input must retain the native business node');
    assert.equal(report.agentInputFocusInteraction.wrapperOwnsInput, true, 'Agent typed Input wrapper must own the native node');
    assert.equal(report.agentInputFocusInteraction.focusWithin, true, 'Agent typed Input focus must activate the wrapper owner');
    assert.equal(report.agentInputFocusInteraction.innerBorderWidth, '0px', 'Agent typed Input must not regain a legacy inner border');
    assert.equal(report.agentInputFocusInteraction.innerBoxShadow, 'none', 'Agent typed Input must not regain a legacy inner focus halo');
    assert.equal(report.agentInputFocusInteraction.innerOutlineStyle, 'none', 'Agent typed Input must defer focus outline to its wrapper');
}
if (report.agentModelPickerInteraction !== null && report.agentModelPickerInteraction !== undefined) {
    const { refreshRows, ...interaction } = report.agentModelPickerInteraction;
    assert.deepEqual(interaction, {
        available: true,
        opened: true,
        rootPane: true,
        modelPane: true,
        refreshAvailable: true,
        refreshBusy: true,
        refreshSettled: true,
        refreshPreservedInput: true,
        filteredCount: 1,
        selectedBefore: interaction.selectedBefore,
        selected: true,
        afterSelectClosed: true,
        reopened: true,
        escaped: true,
        focusRestored: true,
        cardConnected: false,
        rowsAfterEscape: 0,
    }, 'Agent model picker interaction evidence is incomplete');
    // The actual model catalog comes from the fixture HTTP server, while
    // upstream hot/favorite metadata is intentionally retained in its own
    // AppData store. A row may thus occur in one or more legacy-ordered
    // sections; require the refreshed source set rather than a false claim
    // that the global metadata is test-profile isolated.
    assert.ok(Array.isArray(refreshRows) && refreshRows.includes('probe-model') && refreshRows.includes('probe-secondary'),
        'Agent model picker refresh evidence is missing the real model service response');
    assert.ok(refreshRows.every(id => id === 'probe-model' || id === 'probe-secondary'),
        'Agent model picker refresh evidence includes a row outside the real model service response');
}
if (report.agentPromptInteraction !== null && report.agentPromptInteraction !== undefined) {
    assert.deepEqual(report.agentPromptInteraction, { available: true, switched: true, restored: true },
        'prompt mode Button interaction evidence must prove modular switch and original restoration');
}
assert.equal(report.agentDisclosureInteraction?.available, true, 'Agent disclosure interaction evidence is incomplete');
assert.equal(report.agentDisclosureInteraction.count, 6, 'Agent disclosure owner count drifted');
assert.equal(report.agentDisclosureInteraction.openedByHeader.expanded, 'true');
assert.equal(report.agentDisclosureInteraction.openedByHeader.collapsed, false);
assert.equal(report.agentDisclosureInteraction.closedByToggle.expanded, 'false');
assert.equal(report.agentDisclosureInteraction.closedByToggle.collapsed, true);
assert.equal(report.agentDisclosureInteraction.openedByKeyboard.expanded, 'true');
assert.equal(report.agentDisclosureInteraction.openedByKeyboard.collapsed, false);
for (const state of ['openedByHeader', 'closedByToggle', 'openedByKeyboard']) {
    assert.equal(report.agentDisclosureInteraction[state].headerRole, null, `Disclosure header has invalid role during ${state}`);
    assert.equal(report.agentDisclosureInteraction[state].headerTabIndex, null, `Disclosure header has invalid tabindex during ${state}`);
    assert.equal(report.agentDisclosureInteraction[state].headerExpanded, null, `Disclosure header has invalid aria-expanded during ${state}`);
}
assert.deepEqual(report.agentDisclosureReload, {
    success: true, warmupSuccess: true, persisted: true, persistedIdentity: false,
    owners: 6, expanded: 'true', collapsed: false, headerRole: null,
}, 'Agent disclosure reload must restore canonical uiCollapseStates through the generated single owner');

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
    agentRangeInteraction: report.agentRangeInteraction ?? null,
    agentColorPairInteraction: report.agentColorPairInteraction ?? null,
    agentInputFocusInteraction: report.agentInputFocusInteraction ?? null,
    agentModelPickerInteraction: report.agentModelPickerInteraction ?? null,
    screenshotBytes: fs.statSync(screenshotPath).size,
    status: 'production-baseline-valid',
}, null, 2));
