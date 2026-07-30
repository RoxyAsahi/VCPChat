import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body><main class="vcp-ui-scope" data-density="comfortable"></main></body></html>', {
    url: 'https://vcpchat.local/'
});

Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    Option: dom.window.Option,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    ResizeObserver: class {
        observe() {}
        disconnect() {}
    }
});

if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!dom.window.HTMLElement.prototype.scrollTo) {
    dom.window.HTMLElement.prototype.scrollTo = function scrollTo(options) {
        this.scrollTop = typeof options === 'number' ? options : options?.top || 0;
        this.dispatchEvent(new dom.window.Event('scroll'));
    };
}

await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/vcp-ui.js`).href}?contract-test=1`);

const { VCPUI } = window;
const scope = document.querySelector('.vcp-ui-scope');
assert.ok(VCPUI, 'VCPUI should be exposed on window');

const expected = ['button', 'iconbutton', 'input', 'textarea', 'select', 'range', 'checkbox', 'switch', 'field', 'settingssection', 'settingsactionbar', 'badge', 'alert', 'card', 'tabs', 'toolbar', 'list', 'listitem', 'tableframe', 'emptystate', 'divider', 'tooltip', 'skeleton', 'segmentedcontrol', 'pagination', 'scrollarea', 'modal', 'toast', 'confirmdialog', 'inputdialog'];
expected.forEach(name => assert.ok(VCPUI.components.includes(name), `missing public component ${name}`));
assert.equal(VCPUI.manifest.length, 29);
assert.equal(VCPUI.getComponentMeta('ListItem').name, 'List');
assert.equal(VCPUI.getComponentMeta('Button').status, 'stable');

const input = VCPUI.create('Input', { placeholder: 'Name' });
const iconButton = VCPUI.create('IconButton', { icon: 'add', label: 'Add' });
const cases = [
    VCPUI.create('Button', { label: 'Save' }),
    iconButton,
    input,
    VCPUI.create('Textarea', { value: 'Text' }),
    VCPUI.create('Select', { options: ['One', 'Two'], value: 'One' }),
    VCPUI.create('Range', { min: 0, max: 2, step: 0.1, value: 1, label: 'Speed' }),
    VCPUI.create('Checkbox', { label: 'Check' }),
    VCPUI.create('Switch', { label: 'Toggle' }),
    VCPUI.create('Field', { label: 'Name', control: input }),
    VCPUI.create('SettingsSection', { title: 'Advanced', summary: 'Collapsed summary', content: document.createTextNode('Settings content'), collapsed: true }),
    VCPUI.create('SettingsActionBar', { saveLabel: 'Save', dangerLabel: 'Delete' }),
    VCPUI.create('Badge', { label: 'Stable' }),
    VCPUI.create('Alert', { message: 'Notice' }),
    VCPUI.create('Card', { title: 'Card' }),
    VCPUI.create('Tabs', { items: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }] }),
    VCPUI.create('Toolbar', { start: [] }),
    VCPUI.create('List', { items: [{ label: 'Row' }] }),
    VCPUI.create('TableFrame', { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Row' }] }),
    VCPUI.create('EmptyState', { title: 'Empty' }),
    VCPUI.create('Divider', { label: 'Section' }),
    VCPUI.create('Tooltip', { trigger: iconButton, content: 'Add item' }),
    VCPUI.create('Skeleton', { lines: 2 }),
    VCPUI.create('SegmentedControl', { items: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }),
    VCPUI.create('Pagination', { page: 2, total: 60, pageSize: 10 }),
    VCPUI.create('ScrollArea', { content: document.createTextNode('Scrollable') })
];

cases.forEach(controller => {
    assert.ok(controller.element instanceof dom.window.Element);
    assert.equal(typeof controller.update, 'function');
    assert.equal(typeof controller.focus, 'function');
    assert.equal(typeof controller.destroy, 'function');
    scope.append(controller.element);
    controller.update({});
    controller.focus();
});

assert.equal(iconButton.element.getAttribute('aria-label'), 'Add');
const legacyRange = document.createElement('input');
legacyRange.type = 'range';
legacyRange.id = 'legacyRange';
scope.append(legacyRange);
const enhancedRange = VCPUI.enhance('Range', legacyRange, { label: 'Legacy speed', size: 'sm' });
assert.equal(enhancedRange.element, legacyRange);
assert.ok(legacyRange.classList.contains('vcp-ui-range'));
assert.equal(VCPUI.getController(legacyRange), enhancedRange);
enhancedRange.destroy();
assert.ok(legacyRange.isConnected, 'enhanced elements should remain in the DOM after destroy');
assert.equal(legacyRange.className, '');
legacyRange.remove();

const legacyInput = document.createElement('input');
legacyInput.type = 'text';
scope.append(legacyInput);
const enhancedInput = VCPUI.enhance('Input', legacyInput, { size: 'sm', invalid: true });
assert.ok(legacyInput.classList.contains('vcp-ui-native-input'));
assert.equal(legacyInput.getAttribute('aria-invalid'), 'true');
enhancedInput.destroy();
assert.ok(legacyInput.isConnected);
assert.equal(legacyInput.getAttribute('aria-invalid'), null);
legacyInput.remove();

const legacySection = document.createElement('section');
legacySection.className = 'agent-settings-section collapsed';
legacySection.innerHTML = '<div class="agent-settings-section-header"><button class="agent-settings-toggle-btn"></button></div><div class="agent-settings-section-content"></div>';
scope.append(legacySection);
const enhancedSection = VCPUI.enhance('SettingsSection', legacySection);
assert.equal(legacySection.dataset.state, 'collapsed');
assert.equal(legacySection.querySelector('button').getAttribute('aria-expanded'), 'false');
legacySection.classList.remove('collapsed');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(legacySection.dataset.state, 'expanded');
enhancedSection.destroy();
assert.ok(legacySection.isConnected);
legacySection.remove();

const settingsHost = document.createElement('div');
settingsHost.id = 'tabContentSettings';
settingsHost.innerHTML = `
    <form id="agentSettingsForm">
        <section class="agent-settings-section collapsed">
            <div class="agent-settings-section-header"><button type="button" class="agent-settings-toggle-btn"></button></div>
            <div class="agent-settings-section-content"></div>
        </section>
        <div class="group-settings-field-shell"><label for="bridgeInput">Name</label><input id="bridgeInput" type="text" required><small>Required</small></div>
        <select id="bridgeSelect"><option>One</option></select>
        <label class="switch"><input type="checkbox"><span class="slider"></span></label>
        <div class="form-actions"><button type="submit">Save</button><button type="button" class="danger-button">Delete</button></div>
    </form>`;
scope.append(settingsHost);
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/settings-bridge.js`).href}?contract-test=1`);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('bridgeInput').classList.contains('vcp-ui-native-input'));
assert.ok(document.getElementById('bridgeSelect').classList.contains('vcp-ui-native-select'));
assert.ok(settingsHost.querySelector('.switch').classList.contains('vcp-ui-native-switch'));
assert.ok(settingsHost.querySelector('.agent-settings-section').classList.contains('vcp-ui-settings-section'));
assert.ok(settingsHost.querySelector('.group-settings-field-shell').classList.contains('vcp-ui-settings-field'));
const bridgedActionBar = settingsHost.querySelector('.form-actions');
assert.ok(bridgedActionBar.classList.contains('vcp-ui-settings-action-bar'));
document.getElementById('bridgeInput').value = 'Changed';
document.getElementById('bridgeInput').dispatchEvent(new Event('input', { bubbles: true }));
assert.equal(bridgedActionBar.dataset.state, 'dirty');
document.getElementById('agentSettingsForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
assert.equal(bridgedActionBar.dataset.state, 'saving');
document.getElementById('agentSettingsForm').dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: true } }));
assert.equal(bridgedActionBar.dataset.state, 'clean');
bridgedActionBar.querySelector('.danger-button').click();
assert.equal(bridgedActionBar.dataset.state, 'deleting');
document.getElementById('agentSettingsForm').dispatchEvent(new CustomEvent('vcp-settings-delete-result', { detail: { success: false, cancelled: true } }));
assert.equal(bridgedActionBar.dataset.state, 'clean');

const dynamicGroupForm = document.createElement('form');
dynamicGroupForm.id = 'groupSettingsForm';
dynamicGroupForm.innerHTML = '<textarea id="dynamicGroupPrompt"></textarea>';
settingsHost.append(dynamicGroupForm);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(document.getElementById('dynamicGroupPrompt').classList.contains('vcp-ui-native-textarea'));

document.documentElement.dataset.uiMode = 'classic';
window.dispatchEvent(new CustomEvent('ui-mode-changed'));
assert.ok(!document.getElementById('bridgeInput').classList.contains('vcp-ui-native-input'));
window.VCPUISettingsBridge.destroy();
settingsHost.remove();
document.documentElement.dataset.uiMode = 'next';

const classicPresentationSettingsHost = document.createElement('div');
classicPresentationSettingsHost.id = 'tabContentSettings';
classicPresentationSettingsHost.dataset.settingsPresentation = 'classic';
classicPresentationSettingsHost.innerHTML = '<form id="agentSettingsForm"><input id="classicPresentationInput" type="text"></form>';
scope.append(classicPresentationSettingsHost);
await import(`${pathToFileURL(`${process.cwd()}/modules/ui-system/settings-bridge.js`).href}?classic-presentation-contract-test=1`);
await new Promise(resolve => setTimeout(resolve, 0));
assert.ok(!document.getElementById('classicPresentationInput').classList.contains('vcp-ui-native-input'));
assert.equal(window.VCPUISettingsBridge.enhancedCount, 0);
window.VCPUISettingsBridge.destroy();
classicPresentationSettingsHost.remove();

assert.equal(VCPUI.setDensity(scope, 'compact'), 'compact');
assert.equal(VCPUI.getDensity(scope), 'compact');
assert.equal(scope.dataset.density, 'compact');

const switchControl = cases.find(controller => controller.element.classList.contains('vcp-ui-switch'));
let switchChanges = 0;
switchControl.element.addEventListener('change', () => { switchChanges += 1; });
switchControl.element.click();
assert.equal(switchControl.element.getAttribute('aria-checked'), 'true');
assert.equal(switchChanges, 1);

const segmented = cases.find(controller => controller.element.classList.contains('vcp-ui-segmented'));
segmented.element.querySelector('[data-value="b"]').click();
assert.equal(segmented.element.querySelector('[aria-checked="true"]').dataset.value, 'b');

const toast = VCPUI.feedback.toast('Saved', { variant: 'success', duration: 0 });
assert.ok(document.querySelector('.vcp-ui-toast'));
toast.destroy();

const confirmPromise = VCPUI.feedback.confirm({ message: 'Continue?' });
await new Promise(resolve => setTimeout(resolve, 0));
const confirmButtons = [...document.querySelectorAll('.vcp-ui-modal footer .vcp-ui-button')];
confirmButtons.at(-1).click();
assert.equal(await confirmPromise, true);

VCPUI.feedback.setLoading(true, 'Loading');
VCPUI.feedback.setLoading(true, 'Loading');
assert.equal(VCPUI.feedback.setLoading(false), 1);
assert.equal(VCPUI.feedback.setLoading(false), 0);
VCPUI.feedback.cancelAll();
assert.equal(document.querySelector('.vcp-ui-feedback-host'), null);

cases.reverse().forEach(controller => controller.destroy());
assert.equal(scope.querySelectorAll('[class^="vcp-ui-"]').length, 0);

console.log(`UI system contract tests passed (${expected.length} public component names).`);
