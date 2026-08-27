# Visual Forensics: Agent Model Picker

Date: 2026-08-27  
Surface: `agentSettingsForm`  
Reference: `deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx`

## Findings

### VF-AGENT-MODEL-001: legacy `display:flex` still matches the Harness trigger

The real Electron report for `#openModelSelectBtn` fails the authored cascade check with `display:flex` still present in the production presentation path. The trigger has both `.vcp-harness-button.button` and `.vcp-harness-agent-model-picker-trigger`, and its current computed layout is being protected by owner-bound inline declarations. That is a migration bridge, not legacy retirement: an old selector can still affect geometry when the inline declaration is removed, restored during dispose, or reordered by a future enhancer.

Reproduce with:

```sh
npm run check:agent-settings-production-evidence
```

Current result: `FAIL: Agent action openModelSelectBtn has a conflicting authored display:flex rule`.

The minimal CSS fixture is [agent-model-picker-trigger-cascade.html](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/visual-qa/fixtures/agent-model-picker-trigger-cascade.html). The smallest correction is to retire the Agent-specific legacy selector for this trigger and add a negative selector gate; group/global model controls remain out of scope.

### VF-AGENT-MODEL-002: reopen after selection does not close on first Escape

The production interaction probe selects `Probe Secondary`, reopens the picker, and dispatches Escape. The observed result is `escaped=false` and `focusRestored=false`; the first Escape only changes the internal pane from `model` to `root`. The trigger click path calls `popup.open()` directly, while the public `open()` helper is the only path that resets `pane='root'`.

Reproduce with:

```sh
VCPCHAT_STRESS_AGENT_MODEL_PICKER_INTERACTION=1 npm run test:electron-agent-settings-interaction
```

Current result: `FAIL ... escaped=false, focusRestored=false`.

The minimal correction is to reset the pane before opening from the trigger, then retain the existing root-pane Escape dismissal and focus restoration contract. This is a production consumer defect, not a Candidate Lab-only gap.

## Scope and evidence gaps

This audit did not modify Settings, chat rendering, IPC, persistence, Plugin Loader, Composer internals, or DiffBlock. Current production evidence is fixed at `800x600@1x`; `1280x800` and `1680x1000` captures, open-section screenshots, and light/dark state screenshots are still missing. The full structured record is [agent-model-picker-2026-08-27.json](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/visual-qa/agent-model-picker-2026-08-27.json).

The default Agent Settings npm command does not enable the model-picker interaction probe, so the explicit environment-variable command must remain part of the QA gate until the main thread decides where to wire it.

## Verification

`npm run check:uiux` passes. Candidate-only model picker evidence passes. Agent Settings production evidence currently fails on the authored cascade rule, and the explicit model-picker interaction run fails on reopen/Escape focus behavior.
