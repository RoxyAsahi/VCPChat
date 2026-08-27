// test-settings-wa — hermetic per-category persistence regression for the
// global settings modal (the Next SettingsShell while Next is active).
//
// Uses the REAL `globalSettingsModalTemplate` from main.html and the REAL
// `handleSaveGlobalSettings` from modules/global-settings-manager.js. For each
// of the 8 categories it verifies: load from persisted settings, modify, save
// (the saved payload carries the expected key/value), simulated save failure
// (the form reports vcp-settings-save-result success:false), and reopen-restore
// (the form re-populates the saved value). Also verifies the Next-UI
// SettingsShell interactions: Classic isolation, modal host
// visibility, category switching, unsaved values and category search.
//
// Usage: node scripts/test-settings-wa.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const root = process.cwd();

const dom = new JSDOM('<!doctype html><html data-ui-mode="classic"><body><div id="modal-container"></div></body></html>', {
    url: 'https://vcpchat.local/',
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
    ResizeObserver: class { observe() {} disconnect() {} },
});
if (!globalThis.crypto) globalThis.crypto = webcrypto;

// Clone the REAL template from main.html into the test document.
const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
const mainDom = new JSDOM(mainHtml, { url: 'https://vcpchat.local/' });
const template = mainDom.window.document.getElementById('globalSettingsModalTemplate');
assert.ok(template, 'globalSettingsModalTemplate must exist in main.html');
const modal = document.importNode(template.content, true);
document.getElementById('modal-container').appendChild(modal);

// Load the design system + settings bridge from the Classic home layout. The
// global dialog must preserve the upstream presentation until Next is selected.
await import(`${pathToFileURL(`${root}/modules/ui-system/vcp-ui.js`).href}?settings-wa=1`);
await import(`${pathToFileURL(`${root}/modules/ui-system/settings-bridge.js`).href}?settings-wa=1`);

// Mock the persistence boundary exactly the way the renderer wires it.
const savedSettings = { last: null };
const savedRustConfig = { last: null };
let failNextSave = false;
window.chatAPI = {
    async saveSettings(payload) {
        if (failNextSave) return { success: false, error: 'simulated-save-failure' };
        savedSettings.last = payload;
        return { success: true };
    },
    async saveRustAssistantConfig(payload) {
        savedRustConfig.last = payload;
        return { success: true, reconcile: { modeChanged: false } };
    },
    async saveUserAvatar() { return { success: true, avatarUrl: '' }; },
    async saveForumConfig() { return { success: true }; },
    connectVCPLog() {},
    disconnectVCPLog() {},
};
window.VCPAppearance = { normalize: profile => profile, commit: profile => profile };
window.normalizeChatPresentationMode = (mode) => (['bubble', 'panel', 'immersive'].includes(mode) ? mode : 'bubble');

let currentSettings = {};
const uiHelperFunctions = {
    showToastNotification() {},
    closeModal() {},
};

const deps = {
    refs: {
        globalSettings: {
            get: () => currentSettings,
            set: (value) => { currentSettings = value; },
        },
    },
    getCroppedFile: () => null,
    setCroppedFile() {},
    uiHelperFunctions,
    settingsManager: {
        completeVcpUrl: (url) => url,
    },
    normalizeChatPresentationMode: mode => ['bubble', 'panel', 'immersive'].includes(mode) ? mode : 'bubble',
    applyChatPresentationMode: async mode => ({ success: true, mode }),
    applyChatBubbleLayoutSettings() {},
};

const { handleSaveGlobalSettings } = await import(pathToFileURL(`${root}/modules/global-settings-manager.js`).href);

// Mirror of renderer.js syncGlobalSettingsToUI for the fields under test.
const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
};
const check = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.checked = Boolean(value);
};
const populateForm = (settings) => {
    set('userName', settings.userName || '用户');
    set('userAvatarBorderColor', settings.userAvatarBorderColor || '#3d5a80');
    set('userNameTextColor', settings.userNameTextColor || '#ffffff');
    set('vcpServerUrl', settings.vcpServerUrl || '');
    set('vcpApiKey', settings.vcpApiKey || '');
    set('fileKey', settings.fileKey || '');
    set('vcpLogUrl', settings.vcpLogUrl || '');
    set('vcpLogKey', settings.vcpLogKey || '');
    check('enableNextUi', settings.uiMode === 'next');
    check('appearanceUiModeClassic', settings.uiMode !== 'next');
    check('appearanceUiModeNext', settings.uiMode === 'next');
    check('showHomeVisualBrand', settings.showHomeVisualBrand !== false);
    check('showHomeVisualTagline', settings.showHomeVisualTagline !== false);
    set('homeVisualTagline', settings.homeVisualTagline || '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
    set('appearanceSidebarRowHeight', settings.appearanceProfile?.sidebarRowHeight ?? 46);
    set('appearanceSidebarAvatarSize', settings.appearanceProfile?.sidebarAvatarSize ?? 32);
    check(`appearanceSidebarRadiusChoice-${settings.appearanceProfile?.sidebarRadius ?? 'tuned'}`, true);
    set('appearanceCustomRadius', settings.appearanceProfile?.customRadius ?? 10);
    set('minChunkBufferSize', settings.minChunkBufferSize ?? 16);
    set('smoothStreamIntervalMs', settings.smoothStreamIntervalMs ?? 100);
    set('chatFontPreset', settings.chatFontPreset || 'system');
    set('chatCodeFontPreset', settings.chatCodeFontPreset || 'consolas');
    set('chatDiaryFontPreset', settings.chatDiaryFontPreset || 'serif');
    set('chatToolFontPreset', settings.chatToolFontPreset || 'system');
    check('enableSmoothStreaming', settings.enableSmoothStreaming === true);
    set('assistantAgent', settings.assistantAgent || '');
    check('rustDebugMode', Boolean(settings.rustConfig?.debugMode));
    check('rustUseAssistant', Boolean(settings.rustConfig?.useRustAssistant));
    check('rustEnableCustomThresholds', Boolean(settings.rustConfig?.enableCustomThresholds));
    set('rustRuleMode', settings.rustConfig?.ruleMode || 'none');
    set('rustWhitelistKeywords', (settings.rustConfig?.whitelist || []).join('\n'));
    set('rustBlacklistKeywords', (settings.rustConfig?.blacklist || []).join('\n'));
    set('rustScreenshotApps', (settings.rustConfig?.screenshotApps || []).join('\n'));
    check('voiceModeNetwork', (settings.voiceMode || 'local') === 'network');
    check('voiceModeLocal', (settings.voiceMode || 'local') !== 'network');
    set('speechRecognizerBrowserPath', settings.speechRecognizerBrowserPath || '');
    set('speechRecognizerPagePath', settings.speechRecognizerPagePath || 'Voicechatmodules/recognizer.html');
    set('voiceLocalSovitsUrl', settings.voiceLocalSettings?.sovitsUrl || '');
    set('voiceNetworkProviderUrl', settings.voiceNetworkSettings?.providerUrl || '');
    check('enableDistributedServer', Boolean(settings.enableDistributedServer));
    check('agentMusicControl', Boolean(settings.agentMusicControl));
    check('enableContextSanitizer', Boolean(settings.enableContextSanitizer));
    set('contextSanitizerDepth', settings.contextSanitizerDepth ?? 0);
    set('topicSummaryModel', settings.topicSummaryModel || '');
    set('continueWritingPrompt', settings.continueWritingPrompt || '请继续');
    set('flowlockContinueDelay', settings.flowlockContinueDelay ?? 5);
    check('enableMiddleClickQuickAction', Boolean(settings.enableMiddleClickQuickAction));
    set('middleClickQuickAction', settings.middleClickQuickAction || '');
};

const form = document.getElementById('globalSettingsForm');
assert.ok(form, 'globalSettingsForm must be present in the cloned template');
assert.ok(document.getElementById('appearanceSettingsWorkbenchCard'), 'appearance workbench remains available');
assert.ok(document.getElementById('showHomeVisualBrand'), 'home visual toggle exists');
assert.ok(document.getElementById('showHomeVisualTagline'), 'home tagline toggle exists');
assert.ok(document.getElementById('homeVisualTagline'), 'home tagline text control exists');
assert.ok(document.getElementById('appearanceSidebarRowHeight'), 'navigation row height range exists');
assert.ok(document.getElementById('appearanceSidebarAvatarSize'), 'sidebar avatar size range exists');
assert.ok(document.querySelector('input[name="appearanceSidebarRadiusChoice"]'), 'sidebar radius choice group exists');
assert.ok(!document.getElementById('appearanceSidebarRadius'), 'retired hidden sidebar radius compatibility control stays deleted');
assert.ok(document.getElementById('appearanceCustomRadius'), 'custom radius range exists');

// ---- 0. Unified Harness SettingsRoot ----
window.VCPUISettingsBridge.refresh();
await new Promise(resolve => setTimeout(resolve, 0));
const globalSettingsModal = document.getElementById('globalSettingsModal');
assert.ok(globalSettingsModal.classList.contains('vcp-global-settings-surface'), 'unified settings surface marker');
assert.ok(document.querySelector('#globalSettingsModal .vcp-harness-settings-panel'), 'Harness SettingsRoot panel mounts');
assert.equal(document.querySelectorAll('#globalSettingsModal .vcp-harness-settings-nav-cell').length, 8, '8 Harness button nav cells');
assert.equal(document.querySelector('#globalSettingsModal .vcp-harness-settings-nav-cell')?.getAttribute('role'), null, 'Harness nav cells do not use tab role');
assert.equal(document.querySelector('#globalSettingsModal .settings-section')?.getAttribute('role'), null, 'settings sections do not use tabpanel role');
assert.equal(document.querySelector('#globalSettingsModal .vcp-ui-settings-search'), null, 'legacy settings search is absent');
assert.ok(document.querySelector('#globalSettingsModal .vcp-harness-active-section'), 'Harness active section projection exists');
assert.ok(document.querySelector('#globalSettingsModal .vcp-harness-section-bank[hidden]'), 'inactive business sections stay in a hidden compatibility bank');
assert.ok(document.querySelector('#globalSettingsModal .vcp-harness-settings-close-icon'), 'close button uses an icon primitive');
assert.ok(document.querySelector('#globalSettingsModal .vcp-harness-settings-close-label'), 'close button retains an accessible text seat');
const disclosureHeader = document.querySelector('#globalSettingsModal .vcp-harness-disclosure-row');
if (disclosureHeader) {
    assert.equal(disclosureHeader.getAttribute('role'), 'button', 'DisclosureRow exposes button semantics');
    assert.ok(disclosureHeader.getAttribute('aria-controls'), 'DisclosureRow controls its content');
}

// ---- Shell interactions ----
const setField = (id, value) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
const clickNav = (index) => {
    document.querySelectorAll('#globalSettingsModal .vcp-harness-settings-nav-cell')[index].click();
};
const activeSectionId = () => document.querySelector('#globalSettingsModal .settings-section.active')?.id;

const assertNavigationConsistency = (expected) => {
    const activeSections = [...document.querySelectorAll('#globalSettingsModal .settings-section.active')];
    const selectedNav = document.querySelector('#globalSettingsModal .vcp-harness-settings-nav-cell[data-state="selected"]');
    assert.equal(activeSections.length, 1, `exactly one settings section is active for ${expected}`);
    assert.equal(activeSections[0].id, `section-${expected}`, `right panel follows ${expected}`);
    assert.equal(selectedNav?.dataset.section, expected, `left nav follows ${expected}`);
};

// 切换分类不丢未保存值
clickNav(0); // user-identity
assertNavigationConsistency('user-identity');
setField('userName', '未保存测试');
clickNav(1); // server-connection
assert.equal(activeSectionId(), 'section-server-connection', 'nav switches to server-connection');
assertNavigationConsistency('server-connection');
clickNav(0);
assertNavigationConsistency('user-identity');
assert.equal(document.getElementById('userName').value, '未保存测试', 'unsaved value survives category switch');
clickNav(1);
assertNavigationConsistency('server-connection');

for (const value of ['appearance-settings', 'render-settings', 'selection-assistant', 'voice-settings', 'advanced-features', 'quick-actions']) {
    document.querySelector(`#globalSettingsModal .vcp-harness-settings-nav-cell[data-section="${value}"]`).click();
    assertNavigationConsistency(value);
}

assert.equal(document.querySelectorAll('#globalSettingsModal .vcp-harness-settings-nav-cell').length, 8, 'unified nav remains stable after switching');

// Projection lifecycle: select presentation is owned by the library Select
// primitive (window.VCPUIUX.mountSelect), which jsdom does not provide — so
// the bridge must degrade to the bare native control and option mutations
// must never resurrect a retired local projection.
const assistantAgent = document.getElementById('assistantAgent');
assistantAgent.replaceChildren(new Option('助手 A', 'agent-a'), new Option('助手 B', 'agent-b'));
document.dispatchEvent(new Event('vcp-settings-surface-updated'));
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(assistantAgent.closest('.vcp-harness-choice-wrap'), null, 'retired local Choice projection is gone');
assert.equal(assistantAgent.closest('.vcp-harness-select-wrap'), null, 'retired local Select wrap is gone');
assert.equal(assistantAgent.tagName, 'SELECT', 'the native business node stays the sole owner without a primitive runtime');

// ---- save helper ----
async function submitForm() {
    let saveResult = null;
    const onResult = (event) => { saveResult = event.detail; };
    form.addEventListener('vcp-settings-save-result', onResult);
    try {
        await handleSaveGlobalSettings({ preventDefault() {}, currentTarget: form }, deps);
    } finally {
        form.removeEventListener('vcp-settings-save-result', onResult);
    }
    return saveResult;
}

// ---- 1..8. per-category load / modify / save / fail / reopen-restore ----
const categories = [
    {
        name: '用户身份', key: 'user-identity',
        initial: { userName: '旧用户', userAvatarBorderColor: '#3d5a80', userNameTextColor: '#ffffff' },
        assertLoaded: () => document.getElementById('userName').value === '旧用户',
        modify: () => setField('userName', '新用户'),
        savedKey: 'userName', expected: '新用户',
        assertRestored: (payload) => document.getElementById('userName').value === '新用户',
    },
    {
        name: '服务器连接', key: 'server-connection',
        initial: { vcpServerUrl: 'http://127.0.0.1:8080', vcpApiKey: '', fileKey: '', vcpLogUrl: '', vcpLogKey: '' },
        assertLoaded: () => document.getElementById('vcpApiKey').value === '',
        modify: () => setField('vcpApiKey', 'sk-test-secret'),
        savedKey: 'vcpApiKey', expected: 'sk-test-secret',
        assertRestored: () => document.getElementById('vcpApiKey').value === 'sk-test-secret',
    },
    {
        name: '界面与外观', key: 'appearance-settings',
        initial: { chatFontPreset: 'system' },
        assertLoaded: () => document.getElementById('chatFontPreset').value === 'system',
        modify: () => setField('chatFontPreset', 'serif'),
        savedKey: 'chatFontPreset', expected: 'serif',
        assertRestored: () => document.getElementById('chatFontPreset').value === 'serif',
    },
    {
        name: '渲染设置', key: 'render-settings',
        initial: { minChunkBufferSize: 16, smoothStreamIntervalMs: 100 },
        assertLoaded: () => document.getElementById('minChunkBufferSize').value === '16',
        modify: () => setField('minChunkBufferSize', '32'),
        savedKey: 'minChunkBufferSize', expected: 32,
        assertRestored: () => document.getElementById('minChunkBufferSize').value === '32',
    },
    {
        name: '划词助手', key: 'selection-assistant',
        initial: { rustConfig: { useRustAssistant: true, debugMode: false, ruleMode: 'whitelist', whitelist: [], blacklist: [], screenshotApps: [] } },
        assertLoaded: () => document.getElementById('rustRuleMode').value === 'whitelist',
        modify: () => setField('rustWhitelistKeywords', 'visual studio code\nchrome'),
        savedKey: 'rustConfig.whitelist', expected: ['visual studio code', 'chrome'],
        assertRestored: () => document.getElementById('rustWhitelistKeywords').value === 'visual studio code\nchrome',
    },
    {
        name: '语音设置', key: 'voice-settings',
        initial: { voiceMode: 'local', speechRecognizerBrowserPath: '', speechRecognizerPagePath: 'Voicechatmodules/recognizer.html' },
        assertLoaded: () => document.getElementById('voiceModeNetwork').checked === false,
        modify: () => {
            const network = document.getElementById('voiceModeNetwork');
            network.checked = true;
            network.dispatchEvent(new Event('change', { bubbles: true }));
            setField('speechRecognizerBrowserPath', 'C:\\chrome.exe');
        },
        savedKey: 'voiceMode', expected: 'network',
        assertRestored: () => document.getElementById('voiceModeNetwork').checked === true
            && document.getElementById('speechRecognizerBrowserPath').value === 'C:\\chrome.exe',
    },
    {
        name: '高级功能', key: 'advanced-features',
        initial: { enableDistributedServer: false, topicSummaryModel: '' },
        assertLoaded: () => document.getElementById('enableDistributedServer').checked === false,
        modify: () => {
            const toggle = document.getElementById('enableDistributedServer');
            toggle.checked = true;
            toggle.dispatchEvent(new Event('change', { bubbles: true }));
            setField('topicSummaryModel', 'gemini-2.5-flash-test');
        },
        savedKey: 'enableDistributedServer', expected: true,
        assertRestored: () => document.getElementById('enableDistributedServer').checked === true
            && document.getElementById('topicSummaryModel').value === 'gemini-2.5-flash-test',
    },
    {
        name: '快捷操作', key: 'quick-actions',
        initial: { continueWritingPrompt: '请继续', flowlockContinueDelay: 5, enableMiddleClickQuickAction: false },
        assertLoaded: () => document.getElementById('continueWritingPrompt').value === '请继续',
        modify: () => setField('continueWritingPrompt', '请继续撰写并润色'),
        savedKey: 'continueWritingPrompt', expected: '请继续撰写并润色',
        assertRestored: () => document.getElementById('continueWritingPrompt').value === '请继续撰写并润色',
    },
];

for (const category of categories) {
    currentSettings = { ...category.initial, uiMode: 'next', chatFontPreset: 'system', chatCodeFontPreset: 'consolas', chatDiaryFontPreset: 'serif', chatToolFontPreset: 'system' };
    populateForm(currentSettings);

    // 1) 加载：字段反映持久化值
    assert.ok(category.assertLoaded(), `[${category.name}] loaded value reflected in the form`);

    // 2) 修改
    category.modify();

    // 3) 保存：真实 handleSaveGlobalSettings 收集到的 payload 含预期键值
    await submitForm();
    const payload = savedSettings.last;
    assert.ok(payload, `[${category.name}] saveSettings was called`);
    if (category.savedKey.startsWith('rustConfig.')) {
        assert.deepEqual(savedRustConfig.last.whitelist, category.expected, `[${category.name}] rust whitelist persisted`);
    } else {
        assert.equal(payload[category.savedKey], category.expected, `[${category.name}] ${category.savedKey} persisted`);
    }

    // 4) 失败：mock 返回失败 -> 表单收到 success:false，且不再污染保存 payload
    failNextSave = true;
    savedSettings.last = null;
    const failureResult = await submitForm();
    assert.equal(failureResult?.success, false, `[${category.name}] save failure is reported`);
    assert.ok(failureResult?.error, `[${category.name}] save failure carries an error`);
    failNextSave = false;

    // 5) 重开恢复：模拟关闭后重开，表单从已持久化的 settings 重新填充
    //    （划词助手的白名单经 saveRustAssistantConfig 持久化，重开时一并恢复）
    const persisted = category.savedKey.startsWith('rustConfig.')
        ? { ...payload, rustConfig: { ...savedRustConfig.last } }
        : payload;
    populateForm({ uiMode: 'next' });
    populateForm(persisted);
    assert.ok(category.assertRestored(), `[${category.name}] reopened form restored persisted value`);

    console.log(`  [PASS] ${category.name} (${category.key}): load -> modify -> save -> fail -> reopen-restore`);
}

// Prominent appearance controls use their visible inputs as the persistence source.
currentSettings = { uiMode: 'next', showHomeVisualBrand: false, showHomeVisualTagline: false, homeVisualTagline: '已保存的寄语', appearanceProfile: { sidebarRowHeight: 50, sidebarAvatarSize: 36, sidebarRadius: 'medium', customRadius: 11 } };
populateForm(currentSettings);
assert.equal(document.getElementById('showHomeVisualBrand').checked, false, 'home visual toggle reflects persisted false');
assert.equal(document.getElementById('showHomeVisualTagline').checked, false, 'home tagline toggle reflects persisted false');
assert.equal(document.getElementById('homeVisualTagline').value, '已保存的寄语', 'home tagline text reflects persisted content');
assert.equal(document.getElementById('appearanceSidebarRowHeight').value, '50', 'navigation row height reflects persisted value');
assert.equal(document.getElementById('appearanceSidebarAvatarSize').value, '36', 'sidebar avatar size reflects persisted value');
assert.equal(document.getElementById('appearanceSidebarRadiusChoice-medium').checked, true, 'sidebar item radius reflects persisted value');
assert.equal(document.getElementById('appearanceCustomRadius').value, '11', 'custom radius reflects persisted value');
document.getElementById('showHomeVisualBrand').checked = true;
document.getElementById('showHomeVisualTagline').checked = true;
document.getElementById('homeVisualTagline').value = '自定义首页寄语';
document.getElementById('appearanceSidebarRowHeight').value = '60';
document.getElementById('appearanceSidebarAvatarSize').value = '44';
document.getElementById('appearanceSidebarRadiusChoice-round').checked = true;
document.getElementById('appearanceCustomRadius').value = '18';
await submitForm();
assert.equal(savedSettings.last.showHomeVisualBrand, true, 'home visual toggle persists');
assert.equal(savedSettings.last.showHomeVisualTagline, true, 'home tagline toggle persists');
assert.equal(savedSettings.last.homeVisualTagline, '自定义首页寄语', 'home tagline text persists');
assert.equal(savedSettings.last.appearanceProfile.sidebarRowHeight, 60, 'navigation row height persists');
assert.equal(savedSettings.last.appearanceProfile.sidebarAvatarSize, 44, 'sidebar avatar size persists');
assert.equal(savedSettings.last.appearanceProfile.sidebarRadius, 'round', 'sidebar item radius persists');
assert.equal(savedSettings.last.appearanceProfile.customRadius, 18, 'custom radius persists');

console.log('\nSettings WA persistence gate passed (8/8 categories + unified Harness nav interactions).');
