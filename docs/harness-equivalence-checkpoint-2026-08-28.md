# Harness Equivalence Checkpoint (2026-08-28)

## Verified This Round

- UIUX TypeScript compilation and generated-artifact consistency pass.
- UIUX focused tests pass (63/63 in the current tree).
- Agent Model Picker Electron journey passes after resolving the owned portal card through the trigger `aria-controls` contract.
- Agent Settings lifecycle stress remains stable at 474 listeners and 312 lifecycle resources, with zero detached roots/options.
- Harness and VCP Select open-menu fixtures use the same semantic route, Chromium engine, viewport, and ROI. The current pixel report passes with 74 differing pixels / 123,580 pixels (0.05988%) and mean channel delta 0.00308 under the active 1% / 2-channel policy.
- Visual Forensics baseline passes for light and dark themes at 800x600, 1280x800, and 1680x1000.
- Chat-kernel consumer guard passes.

## Status Boundaries

The Select result proves only the open, selected, hover menu ROI. It does not prove closed-trigger, focus, disabled, reload, or full Surface equivalence. The Model Picker remains `production-consumer-active / visual-equivalence-pending`; its legacy hot/favorite/refresh behavior has not been retired.

The Candidate Lab remains distinct from Stable production primitives. A primitive may advance only after a real VCP production consumer, complete interaction/lifecycle evidence, same-engine visual evidence for the relevant states, and deletion evidence for its legacy presentation path.

No chat rendering, streaming, protocol, persistence, Plugin Loader, chat manifest, or composer-internal layout was changed in this checkpoint.

## Next Evidence-Driven Work

1. Complete Model Picker semantic DOM/group parity before attempting to retire its legacy modal.
2. Resolve the remaining Button computed-style sampling discrepancy without guessing at legacy CSS.
3. Continue field-level Settings single-owner migration only when the corresponding Harness DOM, geometry, interaction, reload, teardown, and legacy-deletion evidence is available.
4. Keep Theme legacy reads and artifact-only Electron smoke as explicit open gates.

## Follow-up Verification

The subsequent production overlay closure (`f2c97861`) confirms the external
Model Picker portal is positioned from the live trigger, remains topmost at the
required viewport sizes, restores trigger focus on Escape, and removes its body
portal on teardown. The stress runner now resolves that portal through the
trigger's `aria-controls` relationship rather than assuming it is inside the
Settings form.

The paired Select menu pixel report remains passing, while the Model Picker
itself remains pending because its full Harness semantic/group contract and
legacy hot/favorite/refresh parity are separate requirements. This distinction
is intentional: a passing menu ROI must not promote an enhanced picker or
silently retire the legacy modal.

## Current Recheck

The latest Agent Settings production evidence records 9 typed Inputs, 2
Toggles, 1 Choice group with 2 radio options, 1 Range, and 2 Selects. The
Model Picker journey now proves open, filter, select, close, reopen, Escape,
focus restoration, and portal cleanup on the real Electron surface. Lifecycle
stress remains flat at 474 listeners and 312 resources with no detached roots
or options.

Visual Forensics remains green for both themes at 800x600, 1280x800, and
1680x1000. The provenance gate currently reports `38/49` contracts with
`16` gaps; these are explicit evidence gaps, not a basis for promotion. The
remaining work therefore stays evidence-first: close provenance and full
state coverage before retiring any legacy presentation path.

## Inventory and Provenance Recheck (2026-08-28)

The contract provenance gate now reports `51/51` declared boundaries complete
(`0` metadata gaps). This closes only source-provenance bookkeeping; it does
not close Candidate interaction, production-consumer, semantic-fixture, or
pixel evidence.

The Harness client export inventory reports `227` exports: `91` portable
primitives, `21` composites, `59` frozen domain surfaces, and `56`
scope-blocked runtime surfaces. With no uncovered in-scope export, its status
is `inventory-scoped-complete`. `web/**` remains explicitly frozen as the
Plugin Loader runtime shell and `web-react/**` as the chat-session Provider
runtime; neither classification authorizes a port or a production integration.

This is not a global Harness-parity or VCP production-completion claim. The
Model Picker still has a pending same-semantic pixel diff, and frozen-domain
or scope-blocked surfaces remain outside this checkpoint's implementation
authority.
