# Agent Settings Focus/Cascade Regression - 2026-08-28

After `e9a93302` retired the typed Agent control focus CSS, the production
Agent Settings journey was rerun in real Electron at `800x600` in both
persisted light and dark themes.

## Result

Both runs passed the lifecycle stress gate and
`check:agent-settings-production-evidence`.

- Typed Input focus remains wrapper-owned: `focusWithin=true`.
- The native Input retains `border-width: 0`, `box-shadow: none`, and
  `outline-style: none`; the wrapper supplies the focus border.
- Agent action buttons retain generated Harness geometry (`36px` height,
  `18px` radius where applicable) with no conflicting `display:flex` rule.
- Agent Settings lifecycle resources remained stable at `439` across warmup and
  measured checkpoints; no detached roots, icons, options, or transient owners
  were reported.
- Each Electron leg wrote a non-empty production screenshot; the standard
  report path is intentionally overwritten by the final (dark) leg.

The runner's browser-wide listener count stayed flat at `509` in both legs.

## Commands

```sh
VCPCHAT_STRESS_THEME=light \
VCPCHAT_STRESS_SKIP_PREFLIGHT=1 \
VCPCHAT_STRESS_STAGES=agent-settings \
VCPCHAT_STRESS_CYCLES=1 \
VCPCHAT_STRESS_WARMUP_CYCLES=1 \
VCPCHAT_STRESS_AGENT_INPUT_FOCUS_INTERACTION=1 \
VCPCHAT_STRESS_CAPTURE_AGENT_SETTINGS=1 \
node scripts/test-electron-lifecycle-stress.mjs
npm run check:agent-settings-production-evidence

VCPCHAT_STRESS_THEME=dark \
VCPCHAT_STRESS_SKIP_PREFLIGHT=1 \
VCPCHAT_STRESS_STAGES=agent-settings \
VCPCHAT_STRESS_CYCLES=1 \
VCPCHAT_STRESS_WARMUP_CYCLES=1 \
VCPCHAT_STRESS_AGENT_INPUT_FOCUS_INTERACTION=1 \
VCPCHAT_STRESS_CAPTURE_AGENT_SETTINGS=1 \
node scripts/test-electron-lifecycle-stress.mjs
npm run check:agent-settings-production-evidence
```

This is compact production evidence for Input focus/cascade and action
geometry, not a claim of full Agent Settings pixel equivalence with Harness.
