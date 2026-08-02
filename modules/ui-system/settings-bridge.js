const controllers = new Set();
const injectedNodes = new Set();
let observer = null;
let refreshQueued = false;

function isNextUi() {
    return document.documentElement.dataset.uiMode === 'next'
        && settingsHost?.dataset.settingsPresentation !== 'classic';
}

function isGlobalSettingsNextUi() {
    return document.documentElement.dataset.uiMode === 'next';
}

function enhance(name, element, options = {}) {
    if (!element || window.VCPUI.getController(element)) return;
    try {
        controllers.add(window.VCPUI.enhance(name, element, options));
    } catch (error) {
        console.warn(`[VCPUI SettingsBridge] Could not enhance ${name}:`, error);
    }
}

function enhanceForm(form) {
    form.querySelectorAll('.agent-settings-section, .group-settings-section').forEach(section => {
        enhance('SettingsSection', section);
    });
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => enhance('Select', select));
    form.querySelectorAll('input[type="range"]').forEach(range => enhance('Range', range));
    form.querySelectorAll('label.switch').forEach(control => enhance('Switch', control));
    form.querySelectorAll('.agent-name-wrapper, .group-name-wrapper, .group-settings-field-shell, .style-control-item, .params-content > div:not(.form-group-inline)').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    form.querySelectorAll(':scope > .form-actions').forEach(actionBar => {
        enhance('SettingsActionBar', actionBar, { form });
    });
}

// Global settings modal: same control enhancement as the sidebar forms, plus a
// VCP save bar on the footer and an injected search field that filters the
// category nav and locates the first matching section.
function enhanceGlobalSettings(root, form) {
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => enhance('Select', select));
    form.querySelectorAll('input[type="range"]').forEach(range => enhance('Range', range));
    form.querySelectorAll('label.switch').forEach(control => enhance('Switch', control));
    form.querySelectorAll('.agent-name-wrapper').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    const footer = root.querySelector('.global-settings-footer');
    if (footer) enhance('SettingsActionBar', footer, { form });
    mountSettingsSearch(root);
}

function mountSettingsSearch(root) {
    const content = root.querySelector('.global-settings-content');
    const nav = root.querySelector('.settings-nav-list');
    if (!content || content.querySelector('.vcp-ui-settings-search')) return;

    const search = document.createElement('div');
    search.className = 'vcp-ui-settings-search';
    const icon = document.createElement('span');
    icon.className = 'vcp-ui-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '搜索设置项';
    input.setAttribute('aria-label', '搜索设置项');
    search.append(icon, input);
    content.prepend(search);
    injectedNodes.add(search);

    const navItems = [...root.querySelectorAll('.settings-nav-item')];

    input.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();
        navItems.forEach(item => {
            const section = root.querySelector(`#section-${item.dataset.section}`);
            const hit = !query
                || (section && section.textContent.toLowerCase().includes(query))
                || item.textContent.toLowerCase().includes(query);
            item.hidden = !hit;
        });
        // Reuse the original nav click handler so section switching keeps its
        // animation and state logic instead of being reimplemented here.
        if (query) {
            const firstVisible = navItems.find(item => !item.hidden);
            if (firstVisible) firstVisible.click();
        }
    });
}

function cleanupDisconnectedControllers() {
    [...controllers].forEach(controller => {
        if (controller.element.isConnected) return;
        controller.destroy();
        controllers.delete(controller);
    });
}

function refresh() {
    refreshQueued = false;
    cleanupDisconnectedControllers();
    if (isNextUi()) {
        document.querySelectorAll('#agentSettingsForm, #groupSettingsForm').forEach(enhanceForm);
    }
    if (isGlobalSettingsNextUi()) {
        const modal = document.getElementById('globalSettingsModal');
        const form = modal?.querySelector('#globalSettingsForm');
        if (modal && form) enhanceGlobalSettings(modal, form);
    }
}

function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(refresh);
}

function teardown() {
    [...controllers].reverse().forEach(controller => controller.destroy());
    controllers.clear();
    injectedNodes.forEach(node => node.remove());
    injectedNodes.clear();
}

function syncMode() {
    if (isNextUi() || isGlobalSettingsNextUi()) scheduleRefresh();
    else teardown();
}

observer = new window.MutationObserver(scheduleRefresh);
const settingsHost = document.getElementById('tabContentSettings');
if (settingsHost) observer.observe(settingsHost, { childList: true, subtree: true });
const modalContainer = document.getElementById('modal-container');
if (modalContainer) observer.observe(modalContainer, { childList: true, subtree: true });
window.addEventListener('ui-mode-changed', syncMode);
syncMode();

window.VCPUISettingsBridge = Object.freeze({
    refresh: scheduleRefresh,
    destroy() {
        observer?.disconnect();
        observer = null;
        window.removeEventListener('ui-mode-changed', syncMode);
        teardown();
    },
    get enhancedCount() {
        return controllers.size;
    }
});
