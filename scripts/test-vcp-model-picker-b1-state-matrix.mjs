import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const reports = path.join(root, 'reports');
const harnessRoot = '/Users/asahi/Documents/Codex/deepseek-harness';
const expectedViewport = { width: 800, height: 600, deviceScaleFactor: 1 };
const capture = scenario => {
    const env = { ...process.env, VCP_MODEL_PICKER_MODE: 'harness-equivalent' };
    if (scenario) env.VCP_MODEL_PICKER_SCENARIO = scenario;
    execFileSync(process.execPath, ['scripts/capture-vcp-agent-model-picker-candidate.mjs'], {
        cwd: root,
        env,
        stdio: 'pipe',
    });
};
const read = filename => JSON.parse(fs.readFileSync(path.join(reports, filename), 'utf8'));
const candidateFilename = scenario => `vcp-agent-model-picker-harness-equivalent${scenario ? `-${scenario}` : ''}.json`;
const assertCandidate = (report, scenario) => {
    assert.equal(report.source, 'VCP generated AgentModelPicker Harness-equivalent Electron capture', `${scenario}: wrong capture source`);
    assert.deepEqual(report.viewport, expectedViewport, `${scenario}: fixed viewport drifted`);
    assert.equal(report.status, 'harness-equivalent-fixture-active', `${scenario}: candidate fixture is not active`);
    assert.equal(report.productionConsumer, false, `${scenario}: Lab capture must not claim a production consumer`);
    assert.equal(report.disposed, true, `${scenario}: picker owner did not dispose`);
};

// This is an executable Candidate-Lab matrix, not a promotion criterion. Each
// state is freshly captured so stale JSON cannot masquerade as a completed
// B1 slice. Harness production visual references and legacy retirement remain
// explicitly outside this gate.
for (const scenario of ['', 'hover-focus', 'keyboard-path', 'load-error-retry', 'selecting', 'locked', 'selection-error-toast']) {
    capture(scenario);
}
execFileSync('pnpm', [
    '--dir', harnessRoot, 'exec', 'vitest', 'run',
    '--config', path.join(root, 'scripts/harness-select-trigger-fixture.vitest.config.ts'),
    '--testNamePattern=production image-admission selection failure and Toast',
], { cwd: root, stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/diff-vcp-model-picker-hover-same-engine.mjs'], { cwd: root, stdio: 'pipe' });
execFileSync(process.execPath, ['scripts/diff-vcp-model-picker-keyboard-focus-same-engine.mjs'], { cwd: root, stdio: 'pipe' });

const ready = read(candidateFilename(''));
const hover = read(candidateFilename('hover-focus'));
const keyboard = read(candidateFilename('keyboard-path'));
const loadRetry = read(candidateFilename('load-error-retry'));
const selecting = read(candidateFilename('selecting'));
const locked = read(candidateFilename('locked'));
const selectionError = read(candidateFilename('selection-error-toast'));
const harnessFailureToast = read('harness-agent-model-picker-selection-error-toast.json');
for (const [scenario, report] of Object.entries({ ready, hover, keyboard, loadRetry, selecting, locked, selectionError })) {
    assertCandidate(report, scenario);
}

assert.equal(ready.modelPane?.optionRole, 'menuitemradio');
assert.equal(ready.modelPane?.optionCount, 2);
assert.equal(ready.modelPane?.searchVisible, false);

assert.deepEqual(hover.hoverFocus?.hovered?.pseudo, { hover: true, focus: false, focusVisible: false });
assert.equal(hover.hoverFocus?.hovered?.computed?.backgroundColor, 'rgba(38, 49, 72, 0.06)');
assert.equal(keyboard.trustedKeyboardNavigation?.modelPath?.option?.role, 'menuitemradio');
assert.equal(keyboard.trustedKeyboardNavigation?.modelPath?.option?.optionId, 'deepseek-v4-flash');
assert.equal(keyboard.trustedKeyboardNavigation?.modelPath?.option?.focusVisible, true);
assert.equal(keyboard.trustedKeyboardNavigation?.dismissed?.focusVisible, true);

assert.equal(loadRetry.loadErrorRetry?.pending?.status, 'pending');
assert.equal(loadRetry.loadErrorRetry?.failed?.status, 'failed');
assert.equal(loadRetry.loadErrorRetry?.failed?.alertRole, 'alert');
assert.equal(loadRetry.loadErrorRetry?.failed?.retryVisible, true);
assert.equal(loadRetry.loadErrorRetry?.settled?.status, 'ready');
assert.equal(loadRetry.loadErrorRetry?.settled?.loadAttempts, 2);

assert.equal(selecting.selecting?.popup?.submitting, true);
assert.equal(selecting.selecting?.ariaBusy, 'true');
assert.equal(selecting.selecting?.allNativeRowsDisabled, true);
assert.equal(locked.locked?.triggerDisabled, true);
assert.equal(locked.locked?.popupOpen, false);
assert.equal(locked.locked?.loadAttempts, 0);
assert.equal(selectionError.selectionErrorToast?.popup?.open, true);
assert.equal(selectionError.selectionErrorToast?.menuErrorDisplay, 'none');
assert.equal(selectionError.selectionErrorToast?.retryVisible, false);
assert.equal(selectionError.selectionErrorToast?.toast?.role, 'alert');
assert.equal(harnessFailureToast.source, 'Harness production web ModelSelect');
assert.equal(harnessFailureToast.status, 'harness-production-selection-error-toast-capture');
assert.equal(harnessFailureToast.fixture?.durableImageEventCount, 1);
assert.equal(harnessFailureToast.interaction?.selection, 'normal-pointer-ui');
assert.equal(harnessFailureToast.interaction?.menuRemainedOpen, true);
assert.equal(harnessFailureToast.interaction?.retryVisible, false);
assert.equal(harnessFailureToast.interaction?.selectedModelUnchanged, true);
assert.equal(harnessFailureToast.toast?.role, 'alert');
assert.match(harnessFailureToast.toast?.text ?? '', /does not accept image input/i);

const hoverReference = read('harness-agent-model-picker-electron-reference-hover-focus.json');
const hoverDiff = read('vcp-model-picker-hover-same-engine-diff.json');
const keyboardDiff = read('vcp-model-picker-keyboard-focus-same-engine-diff.json');
assert.equal(hoverReference.referenceKind, 'same-engine-static-source-reference; not a Harness production consumer');
assert.deepEqual(hoverReference.hover?.pseudo, { hover: true, focus: false, focusVisible: false });
assert.equal(hoverDiff.pass, true);
assert.equal(hoverDiff.evidenceKind, 'same-engine-static-source-reference hover ROI; not a Harness production-consumer comparison');
assert.equal(keyboardDiff.pass, true);
assert.equal(keyboardDiff.evidenceKind, 'same-engine-static-source-reference keyboard-focus ROI; not a Harness production-consumer comparison');

const report = {
    generatedAt: new Date().toISOString(),
    status: 'candidate-lab-state-matrix-complete',
    candidateLabPass: true,
    productionEquivalent: false,
    viewport: expectedViewport,
    states: ['ready-selected', 'hover', 'keyboard-focus', 'load-error-retry', 'selecting', 'locked', 'selection-error-toast'],
    visualBaselines: {
        hover: { pass: hoverDiff.pass, differingRatio: hoverDiff.differingRatio, meanChannelDelta: hoverDiff.meanChannelDelta },
        keyboardFocus: { pass: keyboardDiff.pass, differingRatio: keyboardDiff.differingRatio, meanChannelDelta: keyboardDiff.meanChannelDelta },
    },
    harnessProductionFailureToast: {
        captured: true,
        semanticFixture: harnessFailureToast.semanticFixture,
        menuRemainedOpen: harnessFailureToast.interaction.menuRemainedOpen,
        alertRole: harnessFailureToast.toast.role,
        productionComparison: false,
    },
    missingEvidence: [
        'same-semantic VCP selection-error Toast visual comparison',
        'Harness production locked/selecting visual capture',
        'production-consumer pixel equivalence',
        'default IPC favorite mutation journey',
        'deterministic isolated hot/favorite metadata evidence',
        'complete modelSelectModal parity and legacy deletion',
        'packaged artifact-only Electron smoke',
        'Windows evidence',
    ],
};
fs.mkdirSync(reports, { recursive: true });
fs.writeFileSync(path.join(reports, 'vcp-model-picker-b1-state-matrix.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`VCP ModelPicker B1 state matrix: ${report.status}; candidateLabPass=${report.candidateLabPass}; productionEquivalent=${report.productionEquivalent}.`);
