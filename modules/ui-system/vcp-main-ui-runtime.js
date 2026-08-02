import VCPUI from './vcp-ui.js';
import UiModeController from './ui-mode-controller.js';
import './webawesome-adapter.js';

const CORE_TAGS = [
    'button', 'card', 'input', 'textarea', 'select', 'option',
    'checkbox', 'switch', 'tab', 'tab-panel', 'tab-group', 'dialog', 'tooltip',
];

let generation = 0;
let releaseScope = null;
let selectObserver = null;
let activationObserver = null;
let activating = false;

function hasActiveTarget() {
    const agent = document.querySelector('.agent-workbench-root');
    const sidebarSettings = document.querySelector('#tabContentSettings[aria-hidden="false"]');
    const globalSettings = document.querySelector('#globalSettingsModal:not([hidden])');
    return Boolean(agent?.isConnected || sidebarSettings?.isConnected || globalSettings?.isConnected);
}

async function activateKernel() {
    if (activating || selectObserver || !hasActiveTarget()) return;
    activating = true;
    const currentGeneration = ++generation;
    try {
        await window.VCPWebAwesome?.loadComponents?.(CORE_TAGS);
        if (currentGeneration !== generation || document.documentElement.dataset.uiMode !== 'next') return;
        releaseScope = window.VCPWebAwesome?.mountScope?.(document.body) || null;
        selectObserver = VCPUI.observeControls(document, {
            kinds: ['Select'],
            filter: select => Boolean(select.closest('.agent-workbench-root, #tabContentSettings, #globalSettingsModal')),
        });
        window.VCPUISettingsBridge?.refresh?.();
    } catch (error) {
        console.warn('[VCPUI Main Runtime] Web Awesome preload failed; native controls remain active:', error);
    } finally {
        activating = false;
    }
}

function enterNextMode() {
    activationObserver?.disconnect();
    activationObserver = new MutationObserver(activateKernel);
    activationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-hidden', 'hidden', 'class'],
    });
    activateKernel();
}

function leaveNextMode() {
    generation += 1;
    activating = false;
    activationObserver?.disconnect();
    activationObserver = null;
    selectObserver?.destroy();
    selectObserver = null;
    releaseScope?.();
    releaseScope = null;
}

UiModeController.createSurfaceController({
    onEnter: enterNextMode,
    onLeave: leaveNextMode,
});
