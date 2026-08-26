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

## VCP source of truth

VCP fixtures must load only `modules/uiux/generated/` and mount the same nine
cases from `../fixture-matrix.json`. Both pages use the same Chromium/Electron
engine, 800×600 viewport, DPR 1, system-ui font, and frozen animation policy.

## Required capture outputs

For every case, the runner writes DOM shape, geometry, contract-scoped
computed styles, screenshot, and pixel diff reports. Until the Harness web
fixture runner exists, the matrix status remains
`state-fixtures-partial-captured` and no pixel-equivalence claim may be made.
