# Harness-Compatible Renderer Adoption

> Status: adopted architecture constraint
>
> Date: 2026-08-25
>
> Applies to: UI-only Runtime 2 work in `/Users/asahi/Documents/Codex/VCPChat-newarchitecture`

## Decision

VCPChat will not invent a separate non-React visual system. It will reproduce the applicable DeepSeek Harness UI contract and replace only the renderer with a narrow TypeScript implementation.

```text
Domain snapshot / command / subscribe
        ↓
SettingsSurface / ShellSurface / OverlaySurface
        ↓
Harness-compatible primitive contract
        ↓
TypeScript Light-DOM renderer
        ↓
Native | Web Awesome | fallback provider
```

This is not source-code copying and is not a commitment to React, Vue, Cordis, a global plugin container, or a full Virtual DOM. It is a commitment to observable equivalence where a Harness primitive is selected as the reference.

## Contract

| Layer | Must remain compatible | VCP implementation responsibility |
| --- | --- | --- |
| DOM | nesting, element semantics, classes, ARIA | Light-DOM mount and keyed update |
| CSS | geometry, typography, state selectors | source-mirrored CSS plus VCP semantic-token color mapping |
| Interaction | pointer, keyboard, focus, Escape, outside dismiss, disabled | explicit primitive state machine |
| Lifecycle | listener, portal, focus restoration, async teardown | one `UiScope` owner and awaited dispose |
| Business | persisted keys, IPC capability, durable state ownership | adapter only; never a primitive-local store |

## Primitive Boundary

The first allowed primitive family is `SettingsRoot`, `Section`, `Field`, `Select`, `Choice`, `Disclosure`, `Overlay`, and `FocusScope`.

`Select` illustrates the required boundary: it owns trigger, native compatibility select, menu portal, options, visual state and its listeners. It does not query IPC, formulate persistence payloads, save settings, or read chat state. `SettingsUiService` remains the snapshot/command boundary.

## Source Mapping Record

Before a primitive enters production, add a record below and mirror the relevant reference material under `docs/reference/deepseek-harness-primitives/` when licensing and repository policy permit.

| VCP primitive | Harness source | Preserved DOM/CSS/interaction | Real consumer | Status |
| --- | --- | --- | --- | --- |
| None yet | N/A | N/A | N/A | candidate |

## Equivalence Gate

A primitive is only `production-active` once its real consumer has all of the following:

1. DOM nesting fixture or inspection of tag, class, key ARIA and containment.
2. Computed-style sampling for font size, line height, padding, gap, border, radius and state colors.
3. Operation-sequence test for pointer, keyboard, focus, disabled, outside dismissal, Escape and dispose.
4. Electron screenshot comparison under the reference light/dark theme and fixed viewport.

The screenshot comparison may document intentional VCP theme-token differences, but may not hide geometry or interaction differences.

## Sequencing

R2-02C remains the immediate gate. First produce the Settings ownership inventory, then migrate a limited appearance/workspace field set to one `SettingsUiService` owner, and remove its matching legacy projection. Only that real consumer may justify the first primitive. Theme global-token ownership follows after the Settings slice; Chat Slots, Apps/Embedded surfaces and business subpages remain out of scope.

## Non-Goals

- No Shadow DOM by default.
- No generic Virtual DOM before a real Surface needs a named capability.
- No primitive-owned durable state or direct IPC.
- No change to StreamCoordinator, StreamProjection, MessageRenderer, chat protocol, persistence, plugin Loader, chat plugin manifest, or dynamic wallpaper.
