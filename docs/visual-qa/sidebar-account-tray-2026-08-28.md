# Sidebar Account Menu and App Tray Visual QA - 2026-08-28

This report records a real Electron CSS-cascade inspection of the production
Next sidebar Account menu and App Tray drawer. The fixture is
`scripts/visual-qa-next-sidebar-account-tray.mjs`; it does not invoke menu
business commands or persist Settings.

## Evidence

Both theme legs passed at `800x600`, `1280x800`, and `1680x1000`:

- `reports/visual-forensics-qa/sidebar-account-tray/light/manifest.json`
- `reports/visual-forensics-qa/sidebar-account-tray/qa-final-dark/manifest.json`

The fixture verifies:

- Account menu viewport containment, three `role="menuitem"` nodes, hover,
  focus outline, Escape focus restoration, and reopen.
- App Tray drawer viewport containment, topmost hit testing, generated Button
  geometry, tooltip body portal placement, hover, Escape cleanup/focus
  restoration, and reopen.
- Authored cascade rules for sidebar row height and the absence of a legacy
  `.vcp-harness-button` sidebar override.

Observed stable geometry:

- Account menu: `241x164`, menu items `46px` high, `padding: 0 8px`,
  `gap: 8px`, `border-radius: 4px`.
- Tray drawer: approximately `288x286`, `z-index: 10000`, fully inside the
  viewport.
- Tray generated Button: `36px` rendered height, `padding: 0 14px`,
  `gap: 4px`, `border-radius: 18px`.
- Tooltip: fixed `body` portal, inside the viewport at every tested size.

## Finding

The legacy tray rule still contributes `min-height: 32px`. It does not win in
the current production render because the generated Button owner applies an
inline `height: 36px !important`. This is recorded as cleanup debt, not a
visual regression. Removing or narrowing that legacy selector should remain
part of the Tray migration slice and must be accompanied by this fixture.

## Commands

```sh
VCPCHAT_VISUAL_QA_THEME=light \
  node scripts/visual-qa-next-sidebar-account-tray.mjs
VCPCHAT_VISUAL_QA_THEME=dark \
  VCPCHAT_SIDEBAR_ACCOUNT_TRAY_QA_OUTPUT=reports/visual-forensics-qa/sidebar-account-tray/qa-final-dark \
  node scripts/visual-qa-next-sidebar-account-tray.mjs
VCPCHAT_STRESS_SKIP_PREFLIGHT=1 \
VCPCHAT_STRESS_STAGES=agent-settings \
VCPCHAT_STRESS_CYCLES=1 \
VCPCHAT_STRESS_WARMUP_CYCLES=0 \
VCPCHAT_STRESS_AGENT_SELECT_INTERACTION=1 \
VCPCHAT_STRESS_CAPTURE_AGENT_SETTINGS=1 \
node scripts/test-electron-lifecycle-stress.mjs
npm run check:agent-settings-production-evidence
```

The broad `npm run check:ui-system` gate remains blocked in the current dirty
worktree by the existing design-subtraction baseline and unrelated parallel
changes. That failure is not attributed to this QA fixture.

## Current-turn verification

- `node scripts/test-electron-uiux-app-tray.mjs`: passed open/reopen/Escape,
  focus restoration and teardown.
- `node scripts/visual-qa-next-sidebar-account-tray.mjs`: light-theme real
  Electron capture passed.
- Parallel commits `75370082` and `8c3a3097` are present for tooltip scope
  teardown and notification resize restoration.
