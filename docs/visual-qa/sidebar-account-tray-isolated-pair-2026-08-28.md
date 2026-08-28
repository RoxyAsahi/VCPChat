# Sidebar Account/App Tray isolated pair (2026-08-28)

The real Electron Sidebar Account menu and App Tray drawer now have an
isolated light/dark runner and verifier. The gate covers all three supported
viewports, account and tray geometry/topmost placement, generated Button
presentation, hover/focus, Tooltip body-portal positioning, Escape focus
restoration, close teardown, and reopen.

Fresh pair: `reports/visual-forensics-qa/sidebar-account-tray/run-vxgUaU/{light,dark}`.
Both manifests and the verifier exit 0. During this pass the fixture exposed a
real lifecycle defect: closing the drawer left a focused-item Tooltip portal in
`document.body`. The minimal fix disposes the drawer-owned UIUX scope on close
and remounts presentation rows on reopen (`modules/trayManager.js`).

This remains production-consumer evidence only; Harness pixel equivalence and
Windows/packaged-runtime parity are not claimed.
