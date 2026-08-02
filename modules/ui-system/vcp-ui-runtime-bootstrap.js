// vcp-ui-runtime-bootstrap — shared entry for standalone/embedded application
// pages that have adopted the next-UI presentation.
//
// A migrated page includes this module (plus styles/ui-system/runtime.css) and
// then uses window.VCPUI. The bootstrap:
//   - reads the UI mode from the ?uiMode= query param (embedded views are given
//     it by the host; standalone windows fall back to persisted settings),
//   - sets html[data-ui-mode] and dispatches ui-mode-changed,
//   - exposes VCPUI and the UiModeController for the page's own controllers.
//
// The module is inert in classic mode: it only sets the mode attribute and
// never mounts a component tree, so a classic page keeps its current DOM/CSS.

import VCPUI from './vcp-ui.js';
import UiModeController from './ui-mode-controller.js';
import './webawesome-adapter.js';
import './vcp-page-rebuild.js';

window.VCPUI = VCPUI;

if (document.documentElement.dataset.uiMode) {
    // A previous bootstrap (or the host) already resolved the mode.
    window.VCPUiModeController = UiModeController;
} else {
    const controller = await UiModeController.bootstrap();
    window.VCPUiModeController = Object.freeze({
        ...UiModeController,
        bootstrapController: controller,
    });
}

// In next mode the page opts into Web Awesome as the behavior/a11y kernel for
// the core controls it builds through VCPUI.create (Select/Tabs/Modal/Tooltip).
// The bundles load lazily here, so classic pages never fetch them and the
// main renderer keeps Web Awesome out of its boot path.
//
// Timing contract: `vcp-ui-runtime-ready` is dispatched from a DOMContentLoaded
// listener AFTER the Web Awesome bundles have resolved (or failed). DOMContentLoaded
// fires after every page script (classic + module) has run, and page ready
// listeners are attached before this dispatch, so a page that builds its
// next-UI tree in the `vcp-ui-runtime-ready` listener always sees
// VCPUI.create('Select'|'Tabs'|'Modal'|'Tooltip') produce Web Awesome-backed
// elements. In contexts without the preload (main renderer, classic mode)
// VCPUI factories fall back to native DOM.
let waReady = Promise.resolve();
if (document.documentElement.dataset.uiMode === 'next' && window.VCPWebAwesome) {
    waReady = window.VCPWebAwesome.loadComponents([
        'button', 'card', 'input', 'select', 'option',
        'tab', 'tab-panel', 'tab-group', 'dialog', 'tooltip',
    ])
        .catch(error => console.warn('[VCPUI Runtime] Web Awesome preload failed:', error));
}
await waReady;

// Dispatch after DOMContentLoaded (module eval happens in the interactive
// phase, before page DOMContentLoaded handlers attach their ready listeners).
function dispatchRuntimeReady() {
    window.dispatchEvent(new CustomEvent('vcp-ui-runtime-ready', {
        detail: { mode: document.documentElement.dataset.uiMode || 'classic' },
    }));
}
if (document.readyState === 'complete') {
    dispatchRuntimeReady();
} else {
    window.addEventListener('DOMContentLoaded', dispatchRuntimeReady, { once: true });
}

export default VCPUI;
