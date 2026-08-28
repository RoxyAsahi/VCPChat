# Notification Menu Visual QA - 2026-08-28

The production Next notification menu is covered by
`scripts/visual-qa-next-notification-menu.mjs`. It launches an isolated
Electron profile and never invokes a Forum, Memo, Log, Observer, Settings, or
Clear business command.

## Startup classification

The DevTools endpoint can open before Electron creates `main.html`. The
fixture now polls for the real, non-closed `main.html` renderer before it waits
for the shipped renderer readiness marker and notification-menu DOM. This
distinguishes test harness startup ordering from a product menu failure.

## Real Electron evidence

Both independent theme captures passed at `800x600`, `1280x800`, and
`1680x1000`:

- `reports/visual-forensics-qa/notification-menu/qa-retry-light/manifest.json`
- `reports/visual-forensics-qa/notification-menu/qa-final-dark/manifest.json`

At every viewport the fixture records and verifies:

- a visible, topmost, in-viewport `role="menu"` surface;
- the seven expected menu actions and their ARIA state;
- generated Harness Button adoption and `36px` rendered geometry for the five
  neutral menu actions;
- retained `32px` native geometry for the filter checkbox and destructive
  clear action, which intentionally stay outside generated Button adoption;
- light/dark hover and focus styles;
- filter checked/state projection;
- Escape close, trigger-focus restoration, reopen, and body inline-style
  cleanup.

The compact `800x600` menu is a fixed, right-aligned surface; wider layouts
are an absolute surface owned by the sidebar action region. Both real layouts
were in the viewport and passed center hit testing.

## Command

```sh
VCPCHAT_VISUAL_QA_THEME=light \
  VCPCHAT_NOTIFICATION_MENU_QA_OUTPUT=reports/visual-forensics-qa/notification-menu/qa-retry-light \
  node scripts/visual-qa-next-notification-menu.mjs
VCPCHAT_VISUAL_QA_THEME=dark \
  VCPCHAT_NOTIFICATION_MENU_QA_OUTPUT=reports/visual-forensics-qa/notification-menu/qa-final-dark \
  node scripts/visual-qa-next-notification-menu.mjs
```
