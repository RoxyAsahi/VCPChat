# Notification menu isolated pair (2026-08-28)

The production Next notification menu now has a reusable light/dark runner and
manifest verifier. The fixture launches the shipped Electron renderer and
captures `800x600`, `1280x800`, and `1680x1000`; it checks generated Button
geometry, menu viewport/topmost placement, hover/focus, selected filter state,
Escape focus restoration, and close/reopen behavior.

Fresh run (real Electron):

```text
reports/visual-forensics-qa/notification-menu/run-ntLvYF/{light,dark}
```

Both manifests report `gate.pass:true`; the verifier exits 0:

```bash
node scripts/check-visual-qa-next-notification-menu.mjs \
  reports/visual-forensics-qa/notification-menu/run-ntLvYF/light \
  reports/visual-forensics-qa/notification-menu/run-ntLvYF/dark
```

The pair is evidence for the production consumer only. It does not establish
Harness↔production pixel equivalence, Windows/packaged-runtime parity, or
stability of the legacy checkbox/clear controls.
