# VCPChat primitive comparison

This is the current source-level audit, not a claim that the whole settings
surface is finished.

| Primitive | Harness contract | VCP implementation | Status |
| --- | --- | --- | --- |
| Settings panel | 800px × `min(800px, 100vh - 48px)`, 24px radius, 188px nav, 54px header | Existing SettingsShell geometry, scoped under global modal | aligned in geometry; Electron evidence passing |
| Active section projection | `SettingsRoot` renders only the selected slot into `options` | Active section lives in `.vcp-harness-active-section`; inactive business sections remain in a hidden form bank | aligned with compatibility adaptation |
| Close primitive | 28px icon button with an accessible hidden label | Existing business close button is converted once into icon + hidden label, retaining its listener and identity | aligned in structure |
| Text/select field | 32px, 8px radius, 1px L2 border, layer-1 fill, 14/22 text | Native global inputs and long Select trigger now use this contract | aligned at source level |
| Dropdown surface | 4px inset, 12px radius, inverted hairline, lv3 shadow | Portaled/fixed Harness select popover | aligned in geometry; token mapping differs |
| Dropdown row | 40px min-height, 8px/10px padding, 10px radius, 14/22 text, hover only | Long Select option rows | aligned at source level |
| Short enum | Harness uses compact buttons/segmented controls instead of field-width dropdowns | 2–4 option global selects use Choice primitive | aligned in intent; visual screenshot pending |
| Disclosure | 24px row, 16px leading icon, 6px gap, 14/24 title | Global custom-style disclosure gets scoped geometry | partial; other legacy disclosures remain |
| Autosave | draft/write queue with explicit pending/saving/saved/error states | Settings bridge debounces native form submit and retains IPC/save manager | partial; queue/read-back needs runtime evidence |

Known follow-up items:

- dynamic option lists now trigger a scoped presentation rebuild when options
  are added or removed after mount; Electron evidence still needs to cover the
  assistant and voice controls;
- long Select menus have keyboard movement, Escape, outside-click close and
  active descendant projection; remaining gap is exact Harness Menu token/source
  equivalence rather than lifecycle ownership;
- all global sections still contain legacy copy/card markup and need a field
  schema migration after the primitive contract is stable;
- the screenshot review found legacy sidebar disclosure pseudo-background and
  duplicate arrow layers; those are now scoped out for Next settings;
- the summary-model compound input now uses one capsule surface while keeping
  the original text input and picker command;
- Classic/upstream and Next mode require real Electron round-trip evidence.
