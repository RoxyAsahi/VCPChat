# Visual Forensics: Agent Model Picker

Date: 2026-08-27  
Surface: `agentSettingsForm`  
Reference: `deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx`

## Findings

### VF-AGENT-MODEL-001: legacy `display:flex` still matches the Harness trigger (resolved)

The original report found a generic Settings Shell `display:flex` rule matching `#openModelSelectBtn`. The Agent picker now excludes `.vcp-harness-agent-model-picker-trigger` from that rule, and the legacy trigger SVG rule is similarly gated. The generated Harness trigger remains the sole presentation owner for this control.

Reproduce with:

```sh
npm run check:agent-settings-production-evidence
```

Current result: `PASS: npm run check:agent-settings-production-evidence`.

The minimal CSS fixture remains [agent-model-picker-trigger-cascade.html](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/visual-qa/fixtures/agent-model-picker-trigger-cascade.html). Group/global model controls remain out of scope.

### VF-AGENT-MODEL-002: reopen after selection does not close on first Escape (resolved)

The production interaction probe previously selected `Probe Secondary`, reopened the picker, and observed the first Escape only changing the internal pane. The trigger path now resets `pane='root'` before opening, so Escape dismisses the popup and restores trigger focus.

Reproduce with:

```sh
VCPCHAT_STRESS_AGENT_MODEL_PICKER_INTERACTION=1 npm run test:electron-agent-settings-interaction
```

Current result: `PASS ... escaped=true, focusRestored=true`.

The correction is covered by the Agent picker production interaction sequence and late-settlement regression test. This remains a production consumer contract, not a Candidate Lab-only gap.

## Scope and evidence gaps

This audit did not modify Settings, chat rendering, IPC, persistence, Plugin Loader, Composer internals, or DiffBlock. Current production evidence is fixed at `800x600@1x`; `1280x800` and `1680x1000` captures, open-section screenshots, and light/dark state screenshots are still missing. The full structured record is [agent-model-picker-2026-08-27.json](/Users/asahi/Documents/Codex/VCPChat-newarchitecture/docs/visual-qa/agent-model-picker-2026-08-27.json).

The default Agent Settings npm command does not enable the model-picker interaction probe, so the explicit environment-variable command must remain part of the QA gate until the main thread decides where to wire it.

## Verification

`npm run check:uiux` passes. Candidate-only model picker evidence passes. Agent Settings production evidence and the explicit model-picker interaction run pass. Strict Harness pixel diff remains pending (the latest equivalent capture is approximately 6.19% differing pixels), so the control is still `production-consumer-active / visual-equivalence-pending`, not Stable.
