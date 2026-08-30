import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const candidatePath = process.env.VCP_MODEL_PICKER_TRUSTED_KEYBOARD_REPORT
    || path.join(root, 'reports', 'vcp-agent-model-picker-harness-equivalent-keyboard-path.json');
const harnessPath = process.env.HARNESS_MODEL_PICKER_REPORT
    || path.join(root, 'reports', 'harness-agent-model-picker.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

assert.ok(fs.existsSync(candidatePath), `trusted VCP ModelPicker keyboard report is missing: ${candidatePath}`);
assert.ok(fs.existsSync(harnessPath), `Harness ModelSelect keyboard reference is missing: ${harnessPath}`);

const candidate = read(candidatePath);
const harness = read(harnessPath);
const candidatePathEvidence = candidate.trustedKeyboardNavigation;
const harnessOption = harness.keyboardNavigation?.modelPath?.option?.active;

assert.equal(candidate.fixtureMode, 'harness-equivalent');
assert.equal(candidate.scenario, 'keyboard-path');
assert.deepEqual(candidate.viewport, harness.viewport, 'trusted keyboard captures must use the same viewport');
assert.match(candidatePathEvidence?.evidenceKind ?? '', /trusted Puppeteer keyboard input/);
assert.deepEqual(candidatePathEvidence?.steps?.map(step => step.step), [
    'trigger-focus',
    'trigger-enter-open-root',
    'tab-root-model-row',
    'enter-open-model-pane',
    'tab-model-option',
]);
assert.equal(candidatePathEvidence?.modelPath?.modelRow?.role, 'menuitem');
assert.equal(candidatePathEvidence?.modelPath?.option?.role, 'menuitemradio');
assert.equal(candidatePathEvidence?.modelPath?.option?.focusVisible, true);
assert.equal(candidatePathEvidence?.modelPath?.option?.text, harnessOption?.text,
    'VCP Tab destination must match the current Harness production fixture');
assert.equal(harnessOption?.role, 'menuitemradio');
assert.equal(harnessOption?.focusVisible, true);
assert.equal(candidatePathEvidence?.dismissed?.tag, 'button');
assert.equal(candidatePathEvidence?.dismissed?.focusVisible, true);
assert.deepEqual(candidate.keyboardCapture, {
    screenshot: 'vcp-agent-model-picker-harness-equivalent-keyboard-path-closed.png',
    terminalState: 'closed-trigger-focus-restored',
    visualComparison: 'not-evaluated: keyboard-path is interaction evidence, not an open-menu pixel baseline',
});
assert.equal(candidate.disposed, true);

console.log(JSON.stringify({
    source: candidate.source,
    harnessSource: harness.source,
    viewport: candidate.viewport,
    tabDestination: candidatePathEvidence.modelPath.option,
    terminalState: candidate.keyboardCapture.terminalState,
    disposed: candidate.disposed,
    status: 'trusted-model-picker-keyboard-evidence-valid',
}, null, 2));
