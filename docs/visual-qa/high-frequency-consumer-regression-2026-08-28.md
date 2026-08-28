# High-Frequency Consumer Regression - 2026-08-28

This checkpoint re-ran real Electron visual and lifecycle evidence against the
current dirty worktree. It covers only already-adopted, non-frozen consumers:
Agent Settings, Sidebar Account/App Tray, and Notification quick actions.
No product file was changed for this checkpoint.

## Coverage and Result

| Surface | Theme and viewport | Geometry/cascade | Interaction and dispose | Result |
| --- | --- | --- | --- | --- |
| Agent Settings | Default production theme, `800x600` | 9 Input, 2 Toggle, 1 Choice, 1 Range, 2 Select, 2 ColorPair; native business controls remain inside generated owners | Select portal/Escape focus, Range output, ColorPair projection and invalid rollback, wrapper-owned Input focus, Prompt switch, six Disclosure owners/reload, one warmup plus one measured lifecycle cycle | Passed |
| Account menu/App Tray | Light + dark; `800x600`, `1280x800`, `1680x1000` | Account menu `241x164`; three `46px` rows. Tray generated Button renders at `36px`, above the older `32px` minimum | hover/focus, topmost hit testing, tooltip body portal, Escape focus restore, reopen | Passed |
| Notification quick actions | Light + dark; `800x600`, `1280x800`, `1680x1000` | Fixed compact and absolute wide menu placements both remain in viewport and topmost. Five neutral generated Buttons render at `36px`; filter checkbox and destructive clear intentionally remain native `32px` actions | hover/focus, filter state, Escape focus restore, reopen, body cleanup | Passed |

## Commands

```sh
VCPCHAT_STRESS_SKIP_PREFLIGHT=1 \
VCPCHAT_STRESS_STAGES=agent-settings \
VCPCHAT_STRESS_CYCLES=1 \
VCPCHAT_STRESS_WARMUP_CYCLES=1 \
VCPCHAT_STRESS_AGENT_SELECT_INTERACTION=1 \
VCPCHAT_STRESS_AGENT_RANGE_INTERACTION=1 \
VCPCHAT_STRESS_AGENT_COLOR_PAIR_INTERACTION=1 \
VCPCHAT_STRESS_AGENT_INPUT_FOCUS_INTERACTION=1 \
VCPCHAT_STRESS_AGENT_PROMPT_INTERACTION=1 \
VCPCHAT_STRESS_CAPTURE_AGENT_SETTINGS=1 \
node scripts/test-electron-lifecycle-stress.mjs
npm run check:agent-settings-production-evidence

VCPCHAT_VISUAL_QA_THEME=light \
  VCPCHAT_SIDEBAR_ACCOUNT_TRAY_QA_OUTPUT=reports/visual-forensics-qa/sidebar-account-tray/qa-regression-light \
  node scripts/visual-qa-next-sidebar-account-tray.mjs
VCPCHAT_VISUAL_QA_THEME=dark \
  VCPCHAT_SIDEBAR_ACCOUNT_TRAY_QA_OUTPUT=reports/visual-forensics-qa/sidebar-account-tray/qa-regression-dark \
  node scripts/visual-qa-next-sidebar-account-tray.mjs

VCPCHAT_VISUAL_QA_THEME=light \
  VCPCHAT_NOTIFICATION_MENU_QA_OUTPUT=reports/visual-forensics-qa/notification-menu/qa-regression-light \
  node scripts/visual-qa-next-notification-menu.mjs
VCPCHAT_VISUAL_QA_THEME=dark \
  VCPCHAT_NOTIFICATION_MENU_QA_OUTPUT=reports/visual-forensics-qa/notification-menu/qa-regression-dark \
  node scripts/visual-qa-next-notification-menu.mjs
```

## Lifecycle Observation

The Agent Settings runner reported `439` owner-managed lifecycle resources in
both the baseline and measured checkpoint, with no detached roots, icons,
options, transient scopes, or stale weak nodes. Its browser-wide listener
sample moved from `518` to `524`; this is outside the owner-resource count and
the existing stress contract accepted the run. Treat it as an observation for
future listener attribution, not proof of a leak or a reason to expand this
QA slice.

## Remaining Limits

This does not create Agent Settings dark-theme evidence; its production runner
currently boots the default theme. The separately covered Settings modal,
ModelPicker, Account/App Tray, and Notification fixtures provide light/dark
evidence for their own surfaces only. None of these results upgrades a
Candidate primitive to Stable or claims a Harness production pixel comparison.
