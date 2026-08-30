# Settings Harness Diagnosis - 2026-08-24

## Test Results Summary

All automated tests are **PASSING**:

- ✅ Source equivalence check: `legacyClean: true` (0 legacy rows, 0 inline styles, 0 legacy CSS selectors)
- ✅ Settings WA persistence: 8/8 categories (load → modify → save → fail → reopen-restore)
- ✅ Settings Electron gate: 8/8 tests (structure, controls, save/reload, screenshots)
- ✅ Geometry contracts: All Harness reference dimensions matched (panel 800px, nav 188px, header 54px, etc.)
- ✅ DOM tree structure: Canonical SettingsRoot → Panel → (Nav + Content) → (Header + Options)

## Current Implementation State

### What's Working
1. **Canonical DOM structure** - The bridge correctly constructs the Harness tree
2. **Select/Menu projection** - Native `<select>` with Harness Menu presentation layer
3. **Choice controls** - Segmented controls for 2-4 options with roving tabindex
4. **Autosave mechanism** - dirty/saving/saved/error states in header
5. **Disclosure/collapsible sections** - ARIA attributes and keyboard handling
6. **Input wrappers** - Text inputs wrapped in `.vcp-harness-input-wrap`
7. **Lifecycle management** - Proper cleanup via `VCPLifecycle.LifecycleScope`
8. **Dynamic options rebuild** - MutationObserver watching native select changes

### Visual Comparison (Screenshot Analysis)

From the dark theme screenshot captured, the modal shows:
- Panel is properly centered and sized
- Navigation rail on left with 8 category buttons
- Content area on right with settings form
- Error notification visible at top (autosave feedback)
- Sliders, inputs, and choice controls rendered

### Potential Issues to Investigate

Given the user reports "many bugs and doesn't look right", here are likely problem areas:

#### 1. **Color Token Mapping**
The VCPChat theme uses `--vcp-ui-*` tokens while DeepSeek Harness uses `--dsw-*` tokens. Potential mismatches:

- **Navigation active state**:
  - Harness uses `--dsw-specific-sidebar-nav-item-active` (#EBEEF2)
  - VCPChat uses `--vcp-ui-fill-1` (may be different color)

- **Panel background**:
  - Harness: `--dsw-alias-bg-layer-2` (white in light, elevated surface in dark)
  - VCPChat: `--vcp-ui-bg-0` (may not have proper elevation)

- **Shadow depth**:
  - Harness: `--dsw-shadow-lv3` (prominent elevation shadow)
  - VCPChat: `--vcp-ui-shadow-md` (may be too subtle)

#### 2. **Typography Inconsistency**
- Harness nav cell label: 14px/400/lh22
- VCPChat implementation: Claims 14px but may have font-weight or line-height drift
- Icon sizing: Harness uses explicit 16px icon containers

#### 3. **Hover/Focus States**
- Harness has distinct hover state: `--dsw-specific-sidebar-nav-item-hover`
- VCPChat may not have enough visual feedback on hover
- Focus-visible ring may be too subtle or missing

#### 4. **Content Area Scrolling**
- Harness: `.options` scrolls with custom scrollbar styling
- VCPChat: May have default browser scrollbar or wrong overflow behavior

#### 5. **Spacing and Rhythm**
- Nav list gap: Harness uses 4px, VCPChat should match
- Nav title padding: 0 12px in Harness
- Panel border-radius: Both use 24px but check if applied correctly

#### 6. **Theme Integration**
The CSS shows dual selectors: `:is(html, html.vcp-global-settings-host)`
- Check if `.vcp-global-settings-host` class is properly toggled on `<html>` element
- Verify theme tokens are properly defined in both light and dark modes

## Action Items for Debugging

### 1. Compare Visual Outputs Side-by-Side
Run both DeepSeek Harness and VCPChat settings side-by-side:
```bash
# Terminal 1: DeepSeek Harness
cd C:/VCP/vchat-develop/deepseek-harness
npm run dsh

# Terminal 2: VCPChat
cd C:/VCP/vchat-develop/VCPChat-settings-harness-merge
npm start
```

### 2. Check Computed Styles in DevTools
Open both modals and compare computed styles for:
- `.vcp-harness-settings-panel` background, shadow, border-radius
- `.vcp-harness-settings-nav-cell` background colors (default, hover, active)
- `.vcp-harness-settings-nav-cell .vcp-harness-settings-nav-icon` size and color
- Font rendering: check if correct font-family is loaded

### 3. Verify Theme Token Values
Check `AppData/settings.json` for current theme and verify tokens:
```javascript
// In browser DevTools console
getComputedStyle(document.documentElement).getPropertyValue('--vcp-ui-bg-0')
getComputedStyle(document.documentElement).getPropertyValue('--vcp-ui-fill-1')
getComputedStyle(document.documentElement).getPropertyValue('--vcp-ui-shadow-md')
```

### 4. Check for CSS Cascade Issues
The CSS uses `@layer vcp-ui.components` - verify:
- Layer is properly defined in parent stylesheet
- No other styles with higher specificity override Harness rules
- The `.vcp-global-settings-surface` class is added by bridge

### 5. Test Specific Interactions
- Click each nav button - does active state appear?
- Hover over nav buttons - is hover state visible?
- Open select dropdowns - do they position correctly?
- Resize window - does panel maintain constraints?
- Switch between light/dark theme - do colors update?

## Expected vs Actual Comparison Checklist

For the user to fill out:

- [ ] Panel shadow: Should be prominent (lv3), is it too subtle?
- [ ] Nav button active state: Should have light gray fill, is it visible?
- [ ] Nav button hover: Should darken slightly on hover, does it?
- [ ] Nav icons: Should be 16x16px, are they correctly sized?
- [ ] Panel background: Should be elevated white (light) / elevated dark (dark), is it?
- [ ] Content scrollbar: Should be custom styled, is it default browser?
- [ ] Input fields: Should have 8px border-radius, correct?
- [ ] Select triggers: Should have 18px border-radius, correct?
- [ ] Font rendering: Should use system font stack, is it?
- [ ] Header close button: Visible and properly positioned?

## Next Steps

1. **User provides specific bugs**: "doesn't look right" is too vague - need concrete issues
2. **Compare screenshots**: Place Harness and VCPChat screenshots side-by-side
3. **Check theme tokens**: Verify all `--vcp-ui-*` tokens map correctly to design intent
4. **Test in both themes**: Light and dark mode comparison
5. **Browser DevTools inspection**: Compare computed styles between reference and implementation

## Hypothesis

Based on the passing tests but user dissatisfaction, the issue is likely **visual fidelity** rather than structural:

- Colors don't match the Harness design (wrong elevation, wrong hover states)
- Typography rendering differs (font loading, weight, line-height)
- Interactive feedback is too subtle (hover/active states barely visible)
- Theme tokens don't properly represent the design system intent

The structure is correct (tests prove this), but the **visual polish** may be lacking.
