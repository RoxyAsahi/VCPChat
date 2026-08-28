# DeepSeek Harness primitive reference

This directory is a deliberately trimmed, read-only reference snapshot of the
local DeepSeek Harness source. It is kept beside VCPChat's own implementation
so visual changes can be reviewed against source geometry instead of screenshots.

Source checkout: `/Users/asahi/Documents/Codex/deepseek-harness`

The excerpts preserve the relevant DOM/CSS contract and source path. They do
not add a runtime dependency and must not be imported by the Electron app.

| VCP primitive | Harness source | Reference |
| --- | --- | --- |
| settings shell | `packages/client/ui-settings-general/src/client/SettingsRoot.module.css` | `settings-shell.css` |
| text/input/select field | `packages/client/ui-settings-models/src/client/ModelsSection.module.css` | `field-select.css` |
| menu/dropdown | `packages/client/ui-primitives/src/Menu.module.css` | `menu.css` |
| popup select | `packages/client/ui-commands/src/client/PopupSelectView.module.css` | `popup-select.css` |
| agent model picker | `packages/client/ui-model-selection/src/client/ModelSelect.tsx` | `model-picker.css`, `model-picker.dom.json` |
| buttons | `packages/client/ui-primitives/src/Button.module.css` | `button.css` |
| agent preset section | `packages/client/ui-agent-preset/src/client/AgentPresetSection.tsx` | `agent-preset-section.dom.json`, `agent-preset-section.geometry.json` |
| agent preset label | `packages/client/ui-agent-preset/src/client/AgentPresetLabel.tsx` | `agent-preset-label.dom.json`, `agent-preset-label.geometry.json` |
| preset menu composition | `packages/client/ui-agent-preset/src/client/PresetMenu.tsx` | `preset-menu.dom.json`, `preset-menu.geometry.json` (delegates geometry to `menu.geometry.json`) |
| disclosure | `packages/client/ui-primitives/src/DisclosureRow.module.css` | `disclosure.css` |

## Comparison rules

`npm run check:harness-contract-provenance` validates every `*.dom.json` and
`*.geometry.json` boundary against the local Harness checkout, including source
and style provenance, candidate status, and geometry token presence. A passing
provenance gate is reference evidence only; it does not imply a VCP consumer,
computed-style match, screenshot match, or pixel equivalence.

- Keep the source geometry (height, padding, radius, gap, typography and
  hover/focus behavior) unchanged when porting a primitive.
- Only map `--dsw-*` color/elevation aliases to VCP theme variables.
- Preserve one native business node (`input`, `select`, `textarea` or radio)
  and treat any wrapper as presentation.
- A VCP deviation requires a written reason in the audit document and a test.
