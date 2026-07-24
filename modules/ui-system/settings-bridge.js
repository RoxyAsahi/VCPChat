const controllers = new Set();
let observer = null;
let refreshQueued = false;

function isNextUi() {
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

function cleanupDisconnectedControllers() {
    [...controllers].forEach(controller => {
        if (controller.element.isConnected) return;
        controller.destroy();
        controllers.delete(controller);
    });
}

function refresh() {
    refreshQueued = false;
    if (!isNextUi()) return;
    cleanupDisconnectedControllers();
    document.querySelectorAll('#agentSettingsForm, #groupSettingsForm').forEach(enhanceForm);
}

function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(refresh);
}

function teardown() {
    [...controllers].reverse().forEach(controller => controller.destroy());
    controllers.clear();
}

function syncMode() {
    if (isNextUi()) scheduleRefresh();
    else teardown();
}

observer = new window.MutationObserver(scheduleRefresh);
const settingsHost = document.getElementById('tabContentSettings');
if (settingsHost) observer.observe(settingsHost, { childList: true, subtree: true });
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
