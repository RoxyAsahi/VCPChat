# Harness ↔ VCP fixture capture contract

This directory defines the source and capture contract for the R2-02C
dual-page comparison. It is intentionally not a hand-authored HTML reference:
the Harness side must be rendered from the production components in the local
DeepSeek Harness checkout.

## Harness source of truth

- Input: `deepseek-harness/packages/client/ui-primitives/src/Input.tsx`
- Menu/Select: `deepseek-harness/packages/client/ui-primitives/src/Menu.tsx`
- Field consumers: `deepseek-harness/packages/client/ui-settings-models/src/client/ModelsSection.tsx`
- Styles: the corresponding `*.module.css` files beside those components

The Harness checkout currently exposes these components through its Vite web
entry and Vitest/jsdom component tests, not a standalone static fixture page.
The capture runner must therefore boot that web entry (or a temporary fixture
entry importing the production components) before recording PNG/DOM/style
artifacts. Copying the JSON contract or manually recreating the markup is not
valid reference evidence.

The first capture uses a temporary Vitest test inside the Harness repository to
render production `Input` and `Menu` components. The resulting HTML is stored
under `harness/`; CSS-module hash classes are intentionally preserved and must
be normalized by the structural diff runner rather than replaced by hand.

The production Select supplement is captured through the official
`agent-preset-selection.e2e.ts` scaffold after connecting a temporary workspace;
it is stored as `harness/select.production.dom.html` plus a fixed viewport PNG.
This is a real production web interaction fixture, but it remains a separate
Select-only scene until VCP captures the same agent-preset scenario.

Field description/error are not standalone Harness primitives: the production
settings consumers render labels and error paragraphs directly. A VCP Field
error fixture is therefore stored for contract review, but no Harness Field
error image is fabricated until a concrete production consumer fixture is
selected.

## VCP source of truth

VCP fixtures must load only `modules/uiux/generated/` and mount the same ten
cases from `../fixture-matrix.json`. Both pages use the same Chromium/Electron
engine, 800×600 viewport, DPR 1, system-ui font, and frozen animation policy.

Model Picker uses two explicit evidence modes. `harness-equivalent` disables
search and requires provider-grouped `menuitemradio` rows before DOM/geometry or
pixel comparison is eligible. `vcp-enhanced` keeps search, favorite, disabled,
and provider-detail extensions for product interaction evidence only; it must
not be compared pixel-for-pixel with the Harness capture.

## Required capture outputs

For every case, the runner writes DOM shape, geometry, contract-scoped
computed styles, screenshot, and pixel diff reports. Until the Harness web
Select production fixture runner is available, the matrix status remains
`structural-diff-8-pass-1-fail-1-pending` and no pixel-equivalence claim may be made.
