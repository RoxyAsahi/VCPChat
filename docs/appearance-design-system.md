# VChat Appearance Design System

> Status: Phase 1 implemented, shell decomposition remains experimental.

## Goal

VChat appearance is no longer defined by one `classic/next` switch. The UI mode remains a compatibility boundary while visual choices become independent, persistent settings.

```text
uiMode
  controls runtime compatibility, Next shell mounting and legacy fallback

appearanceProfile
  controls density, radius, typography, font scale, content width and surface material

chatPresentationMode
  controls bubble, panel or immersive message presentation
```

The three settings are intentionally separate. Changing message presentation must not silently change the shell, and changing radius must not mount or tear down Next runtime.

## Current Schema

```js
appearanceProfile: {
  density: 'compact' | 'comfortable' | 'relaxed',
  radius: 'square' | 'small' | 'medium' | 'round',
  typography: 'system' | 'humanist' | 'serif',
  fontScale: 'small' | 'normal' | 'large',
  contentWidth: 'full' | 'centered',
  surface: 'solid' | 'translucent'
}
```

The authoritative copy lives in `settings.json`. Local storage is only an early-paint cache, following the same rule as `uiMode`; it never becomes the settings authority.

The renderer projects the profile onto the document:

```text
data-vcp-density
data-vcp-radius
data-vcp-typography
data-vcp-font-scale
data-vcp-content-width
data-vcp-surface
```

`modules/ui-system/appearance-engine.js` validates values, applies attributes, updates VCPUI density scopes and emits `vcp-appearance-changed`. `styles/appearance.css` is a separate cross-mode layer that maps those attributes to semantic tokens; it deliberately does not live under the Next-only `styles/ui-system/` boundary.

## Compatibility Presets

When an older settings file has no `appearanceProfile`, the engine derives a complete profile from `uiMode`:

| Compatibility mode | Density | Radius | Typography | Width | Surface |
| --- | --- | --- | --- | --- | --- |
| classic | comfortable | small | system | full | translucent |
| next | comfortable | medium | humanist | full | translucent |

These are migration defaults, not permanent coupled modes. Once saved, every field is independent.

## Design Tokens

- Color remains owned by the existing theme engine.
- Spacing uses the existing 4px token grid; density changes semantic control and panel spacing.
- Radius changes semantic radius tokens, not scattered component pixels.
- Typography changes the UI family and font scale; chat, code, diary and tool content keep their specialized font settings.
- Surface selects blur/translucency policy without changing the wallpaper or theme.
- Motion keeps the existing 160ms and 260ms tokens and respects reduced motion.

## Boundaries

- No main chat state, Agent Runtime or ToolBox behavior is changed.
- `classic/next` is not removed yet. It still owns Next runtime loading, Web Awesome availability, child-app allowlists and legacy teardown.
- The Appearance layer does not make classic pages VCPUI components.
- The first phase does not expose navigation structure or shell geometry as independent controls because those still have runtime lifecycle consequences.

## Delivery Roadmap

### Phase 1: Appearance profile foundation

- Persistent schema and validation.
- Boot cache and document attribute engine.
- Radius, density, typography, font scale, content width and surface controls.
- Contract test and UI-system gate integration.

### Phase 2: Token coverage

- Replace high-impact hard-coded radius, spacing and font sizes with semantic bridge tokens.
- Cover main chat, settings, notifications, Agent Workbench and embedded active surfaces.
- Publish a coverage report; do not claim a setting is global before the surface consumes its token.

### Phase 3: Shell decomposition

Introduce orthogonal shell settings only after lifecycle work is complete:

```js
shell: 'inset' | 'edge'
navigation: 'top-tabs' | 'classic-titlebar'
```

At that point `uiMode` becomes an internal compatibility profile rather than a user-facing visual mode. Next runtime mounting and classic fallback must remain fail-closed.

### Phase 4: Quick appearance drawer

- Add a compact live-preview drawer modeled on the ToolBox Admin Panel.
- Provide presets plus independent overrides.
- Cancel restores the persisted profile; save writes through Main.
- Support import/export only after schema versioning exists.

### Phase 5: Deprecation audit

- Audit every `data-ui-mode` selector and runtime branch.
- Remove `uiMode` only if no remaining branch controls behavior or availability.
- Keep migration support for older settings files.

## Verification

```powershell
npm run test:appearance-engine
npm run check:ui-system
```

Visual acceptance must cover classic and next modes, light and dark themes, narrow and wide windows, wallpaper enabled/disabled, and Agent Workbench open/closed.
