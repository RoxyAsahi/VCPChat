# DeepSeek Harness settings-page source snapshot

This is a trimmed source copy of the settings page composition, kept for
source-level comparison with VCPChat. The original checkout is
`/Users/asahi/Documents/Codex/deepseek-harness`.

The important design decision is composition rather than a monolithic form:

```text
SettingsRoot
  SettingsPanel
    nav / navCell
    content / header / options
      GeneralSection
        settings.general.item contributions
          AppearanceRow / feature-owned rows
```

Each feature owns its row and persistence action. The root owns only modal
viewing state, active section, focus, Escape and mask close. This snapshot is
reference-only and is not imported into VCPChat.
