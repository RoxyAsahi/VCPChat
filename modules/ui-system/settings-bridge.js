// settings-bridge — unified VCPUI enhancement bridge for settings surfaces.
//
// The sidebar settings forms (agent/group) and the global settings modal keep
// their original business DOM, form ids, defaults and IPC; this module only
// layers the VCPUI presentation on top of the canonical main-window shell.
//
// Global settings: the modal is rebuilt into one Harness SettingsRoot-style
// layout — native nav cells in the left rail, a header/options content column,
// the original form as the business source, and autosave status in the header.

import { createSelectProjection } from './settings/select-projection.js';
import { mountSettingsAutosave, flushLegacyAutosave, teardownLegacyAutosave } from './settings/autosave.js';
import { mountCanonicalSettingsRows, removeLegacySubsectionHeadings } from './settings/canonical-rows.js';

const controllers = new Set();
const controllerReleases = new Map();
// Per-modal shell state is keyed by modal root so teardown can restore the
// exact original business nodes/classes after the canonical tree is removed.
// WeakMap cannot be iterated, so built roots are tracked separately.
const shellState = new WeakMap();
const shellRoots = new Set();
// Every non-typed select is projected by the real library Select primitive
// (window.VCPUIUX.mountSelect): the native select stays the sole business node
// while the primitive owns trigger/menu presentation.  Keyed by select so a
// dynamic option-list change can dispose and remount exactly one projection.
const typedFieldStates = new Set();
const typedForumFieldStates = new Set();
const disclosureStates = new Set();
const agentModelPickerReleases = new Map();
// Replaced inline SVGs inside the global form, keyed by container, so teardown
// restores the original upstream paths during teardown.
const iconReplacements = new Set();
let refreshQueued = false;
const LifecycleScope = window.VCPLifecycle?.LifecycleScope;
const bridgeScope = LifecycleScope ? new LifecycleScope('settings-bridge-controller') : null;
const settingsHost = document.getElementById('tabContentSettings');
let presentationScope = null;
let destroyed = false;
let destroyPromise = null;
let typedSettingsService = null;
let typedSettingsRegistry = null;
let typedRustAssistantService = null;
let typedForumConfigService = null;
let typedAssistantRuntimeService = null;
let typedSettingsState = Object.freeze({});
let typedSettingsExternalRelease = null;
let typedSettingsSaveChain = Promise.resolve();
let typedSettingsSaveGeneration = 0;
let typedSettingsDisposed = false;

function addTypedNetworkPathInput(root, path = '') {
    const container = root?.querySelector?.('#networkNotesPathsContainer');
    if (!container) return false;
    // Resolve the owner before binding any dynamic-row listener.  Rows can be
    // created after the Settings surface mounted; their controls must still
    // retract with the same presentation scope instead of leaving an ambient
    // listener on a detached row during a close/reopen cycle.
    const inputScope = ensurePresentationScope();
    const inputGroup = document.createElement('div');
    inputGroup.className = 'network-path-input-group vcp-settings-row';
    inputGroup.dataset.vcpSettingsRow = 'true';
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'networkNotesPath';
    input.placeholder = '例如 \\NAS\\Shared\\Notes';
    input.value = path;
    // Rows created after the typed field owner mounted belong to it; mark
    // them immediately so an input between the helper call and the next
    // delegation pass can never fall back onto the legacy chain.
    if (document.getElementById('globalSettingsForm')?.dataset.vcpTypedFieldOwnerMounted === 'true') {
        input.dataset.vcpTypedFieldOwner = 'true';
    }
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '删除';
    removeBtn.className = 'sidebar-button small-button danger-button';
    // A silent row removal previously skipped every dirty chain; announce it
    // so the owning owner recomputes the serialized list.
    const removeRow = () => {
        inputGroup.remove();
        container.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (inputScope) inputScope.listen(removeBtn, 'click', removeRow, { once: true });
    else removeBtn.addEventListener('click', removeRow, { once: true });
    inputGroup.append(input, removeBtn);
    container.appendChild(inputGroup);
    // Dynamic rows adopt the same real Input primitive as static fields; a
    // bare input keeps the native control contract when the runtime or the
    // presentation scope is unavailable.
    const inputApi = window.VCPUIUX;
    if (inputApi?.mountInput && inputScope) {
        try {
            inputApi.mountInput(input, {}, inputScope);
            input.closest('.vcp-uiux-input-wrap')?.classList.add('vcp-harness-input-fill');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount network path Input primitive:', error);
        }
    }
    return true;
}

function ensureTypedSettingsService() {
    if (typedSettingsService || !window.VCPUIUX?.createSettingsUiService) return typedSettingsService;
    const externalListeners = new Set();
    const publishExternal = settings => {
        if (typedSettingsDisposed) return;
        typedSettingsState = Object.freeze({ ...typedSettingsState, ...(settings || {}) });
        externalListeners.forEach(listener => listener(typedSettingsState));
    };
    const onExternalSettings = event => publishExternal(event.detail?.settings);
    window.addEventListener('global-settings-updated', onExternalSettings);
    typedSettingsExternalRelease = () => {
        window.removeEventListener('global-settings-updated', onExternalSettings);
        externalListeners.clear();
        typedSettingsExternalRelease = null;
    };
    typedSettingsService = window.VCPUIUX.createSettingsUiService({
        get: () => typedSettingsState,
        save: patch => {
            const generation = ++typedSettingsSaveGeneration;
            const run = async () => {
                const next = Object.freeze({ ...typedSettingsState, ...patch });
                const result = await window.chatAPI?.saveSettings?.(next);
                if (result?.success && generation === typedSettingsSaveGeneration) publishExternal(next);
                return result?.success ? { success: true } : { success: false, error: result?.error || '设置保存失败' };
            };
            const result = typedSettingsSaveChain.then(run, run);
            typedSettingsSaveChain = result.catch(() => {});
            return result;
        },
        cancelPendingSaves: () => {
            typedSettingsSaveGeneration += 1;
            // Do not let a timed-out IPC hold retry behind an unbounded chain.
            // The old request may still settle in the main process, but it has
            // lost publication rights and the next retry starts immediately.
            typedSettingsSaveChain = Promise.resolve();
        },
        subscribe: listener => {
            externalListeners.add(listener);
            return () => externalListeners.delete(listener);
        },
    });
    void window.chatAPI?.loadSettings?.().then(settings => publishExternal(settings)).catch(() => {});
    if (window.VCPUIUX?.createUiServiceRegistryFromScope && bridgeScope && window.VCPUIUX?.settingsUiDefinition) {
        typedSettingsRegistry = window.VCPUIUX.createUiServiceRegistryFromScope(bridgeScope);
        const definition = window.VCPUIUX.settingsUiDefinition;
        typedSettingsRegistry.install(definition, context => definition.provide({
            ...context,
            services: { ...context.services, settings: typedSettingsService },
        }));
    } else {
        // Compatibility fallback while the typed browser entry is unavailable.
        bridgeScope?.own(() => typedSettingsService?.dispose?.(), 'typed-settings-service', 'ui-service');
    }
    bridgeScope?.own(() => {
        typedSettingsDisposed = true;
        typedSettingsExternalRelease?.();
    }, 'typed-settings-events', 'ui-service');
    return typedSettingsService;
}

function mountTypedSettingsConsumer(root) {
    const fallbackService = ensureTypedSettingsService();
    const service = typedSettingsRegistry?.get('settings-ui') || fallbackService;
    if (!service || !root) return;
    const form = root.querySelector('#globalSettingsForm');
    const apply = (_value, snapshot) => {
        if (!form) return;
        root.dataset.vcpSettingsRevision = String(snapshot.revision);
        root.dataset.vcpSettingsSource = snapshot.source;
        // The typed service owns durable projection reads for migrated fields.
        // Never overwrite a user's dirty draft or an in-flight submission.
        if (form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
        const settings = snapshot.value || {};
        const projection = [
            // The retired userUseThemeColorsInChat row never wrote anything:
            // the persisted key has no control inside #globalSettingsForm (its
            // namesake checkbox lives in the per-agent agentSettingsForm), so
            // that lookup resolved to null on every projection pass.
            ['vcpServerUrl', 'vcpServerUrl'],
            ['vcpApiKey', 'vcpApiKey'],
            ['fileKey', 'fileKey'],
            ['vcpLogUrl', 'vcpLogUrl'],
            ['vcpLogKey', 'vcpLogKey'],
            ['topicSummaryModel', 'topicSummaryModel'],
            ['assistantAgent', 'assistantAgent'],
            ['voiceModeLocal', 'voiceMode', 'checked-value', 'local'],
            ['voiceModeNetwork', 'voiceMode', 'checked-value', 'network'],
            ['speechRecognizerBrowserPath', 'speechRecognizerBrowserPath'],
            ['speechRecognizerPagePath', 'speechRecognizerPagePath'],
            ['voiceLocalSovitsUrl', 'voiceLocalSettings.sovitsUrl'],
            ['voiceLocalSovitsKey', 'voiceLocalSettings.sovitsKey'],
            ['voiceNetworkProviderUrl', 'voiceNetworkSettings.providerUrl'],
            ['voiceNetworkProviderKey', 'voiceNetworkSettings.providerKey'],
            ['enableDistributedServer', 'enableDistributedServer', 'checked'],
            ['agentMusicControl', 'agentMusicControl', 'checked'],
            ['enableVcpToolInjection', 'enableVcpToolInjection', 'checked'],
            ['enableThoughtChainInjection', 'enableThoughtChainInjection', 'checked'],
            ['enableContextSanitizer', 'enableContextSanitizer', 'checked'],
            ['contextSanitizerDepth', 'contextSanitizerDepth'],
            ['enableAiMessageButtons', 'enableAiMessageButtons', 'checked'],
            ['flowlockContinueDelay', 'flowlockContinueDelay'],
            ['enableMiddleClickQuickAction', 'enableMiddleClickQuickAction', 'checked'],
            ['middleClickQuickAction', 'middleClickQuickAction'],
            ['enableMiddleClickAdvanced', 'enableMiddleClickAdvanced', 'checked'],
            ['middleClickAdvancedDelay', 'middleClickAdvancedDelay'],
            ['enableRegenerateConfirmation', 'enableRegenerateConfirmation', 'checked'],
            ['chatPresentationModeBubble', 'chatPresentationMode', 'checked-value', 'bubble'],
            ['chatPresentationModePanel', 'chatPresentationMode', 'checked-value', 'panel'],
            ['chatPresentationModeImmersive', 'chatPresentationMode', 'checked-value', 'immersive'],
            ['enableUserChatBubbleUi', 'enableUserChatBubbleUi', 'checked'],
            ['showUserMetaInChatBubbleUi', 'showUserMetaInChatBubbleUi', 'checked'],
            ['chatBubbleMaxWidthWideDefault', 'chatBubbleMaxWidthWideDefault'],
            ['chatBubbleMaxWidthWideNotifications', 'chatBubbleMaxWidthWideNotifications'],
            ['chatBubbleMaxWidthWideNarrow', 'chatBubbleMaxWidthWideNarrow'],
            ['minChunkBufferSize', 'minChunkBufferSize'],
            ['smoothStreamIntervalMs', 'smoothStreamIntervalMs'],
            ['enableSmoothStreaming', 'enableSmoothStreaming', 'checked'],
        ];
        projection.forEach(([id, path, mode, expected]) => {
            const control = form.querySelector(`#${id}`);
            if (!control) return;
            const value = path.split('.').reduce((current, key) => current?.[key], settings);
            if (value === undefined || value === null) return;
            if (mode === 'checked-value') control.checked = String(value) === expected;
            else if (mode === 'checked-inverse') control.checked = value !== true;
            else if (mode === 'checked' || control.type === 'checkbox') control.checked = Boolean(value);
            else if (mode === 'px-output') {
                control.value = `${value}px`;
                control.textContent = `${value}px`;
            }
            else control.value = String(value);
        });
        // Display defaults ported from the retired startup fallback
        // (handoff retirement batch): the typed state stores raw persisted
        // data, but these two voice controls keep their first-open display
        // defaults exactly as the fallback used to fill them.
        [['speechRecognizerPagePath', 'Voicechatmodules/recognizer.html'], ['voiceNetworkProviderUrl', 'https://api.siliconflow.cn']]
            .forEach(([id, displayDefault]) => {
                const control = form.querySelector(`#${id}`);
                if (control && !control.value) control.value = displayDefault;
            });
        if (Object.prototype.hasOwnProperty.call(settings, 'userAvatarUrl')) {
            const preview = form.querySelector('#userAvatarPreview');
            const wrapper = preview?.closest('.agent-avatar-wrapper');
            const avatarUrl = String(settings.userAvatarUrl || '');
            if (preview) {
                if (avatarUrl) {
                    preview.src = avatarUrl;
                    preview.style.display = 'block';
                    wrapper?.classList.remove('no-avatar');
                } else {
                    preview.src = '#';
                    preview.style.display = 'none';
                    wrapper?.classList.add('no-avatar');
                }
            }
        }
        const sanitizerContainer = form.querySelector('#contextSanitizerDepthContainer');
        const sanitizerEnabled = settings.enableContextSanitizer === true;
        if (sanitizerContainer) sanitizerContainer.style.display = sanitizerEnabled ? 'block' : 'none';
        const middleClickEnabled = settings.enableMiddleClickQuickAction === true;
        const quickActionContainer = form.querySelector('#middleClickQuickActionContainer');
        const advancedContainer = form.querySelector('#middleClickAdvancedContainer');
        const advancedSettings = form.querySelector('#middleClickAdvancedSettings');
        if (quickActionContainer) quickActionContainer.style.display = middleClickEnabled ? 'block' : 'none';
        if (advancedContainer) advancedContainer.style.display = middleClickEnabled ? 'block' : 'none';
        if (advancedSettings) advancedSettings.style.display = settings.enableMiddleClickAdvanced === true ? 'block' : 'none';
        const mode = settings.chatPresentationMode || 'bubble';
        const bubbleWidthSettings = form.querySelector('#chatBubbleWidthSettings');
        if (bubbleWidthSettings) bubbleWidthSettings.hidden = mode !== 'bubble';
        const bubbleMetaSettings = form.querySelector('#userChatBubbleMetaSettings');
        if (bubbleMetaSettings) bubbleMetaSettings.style.display = settings.enableUserChatBubbleUi === true ? 'flex' : 'none';
    };
    const release = service.state.subscribe(apply);
    const consumerScope = ensurePresentationScope();
    if (consumerScope) {
        consumerScope.own(() => {
            release?.();
            delete root.dataset.vcpSettingsRevision;
            delete root.dataset.vcpSettingsSource;
        }, 'typed-settings-consumer', 'ui-presentation');
    } else {
        // No presentation scope (destroyed bridge): the subscription would
        // fire apply() against a torn-down form forever, so retract it now.
        release?.();
    }
    const assistantSelect = form?.querySelector('#assistantAgent');
    if (assistantSelect && window.MutationObserver) {
        const observer = new MutationObserver(() => {
            const snapshot = service.state.getSnapshot();
            apply(snapshot.value, snapshot);
        });
        observer.observe(assistantSelect, { childList: true });
        ensurePresentationScope()?.own(() => observer.disconnect(), 'typed-assistant-options-consumer', 'ui-presentation');
    }
    const rustService = ensureRustAssistantUiService();
    if (rustService) {
        const applyRust = (_value, snapshot) => {
            if (form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
            const rust = snapshot.value || {};
            const check = (id, value) => { const control = form.querySelector(`#${id}`); if (control) control.checked = Boolean(value); };
            const set = (id, value) => { const control = form.querySelector(`#${id}`); if (control && value !== undefined && value !== null) control.value = String(value); };
            check('rustUseAssistant', rust.useRustAssistant === true);
            check('rustDebugMode', rust.debugMode === true);
            const thresholds = rust.runtimeThresholds || {};
            const custom = Object.entries({ minEventIntervalMs: 80, minDistance: 0, screenshotSuspendMs: 3000, clipboardConflictSuspendMs: 1000, clipboardCheckIntervalMs: 500 })
                .some(([key, fallback]) => Number(thresholds[key] ?? fallback) !== fallback);
            check('rustEnableCustomThresholds', custom);
            set('rustMinEventIntervalMs', thresholds.minEventIntervalMs);
            set('rustMinDistance', thresholds.minDistance);
            set('rustScreenshotSuspendMs', thresholds.screenshotSuspendMs);
            set('rustClipboardConflictSuspendMs', thresholds.clipboardConflictSuspendMs);
            set('rustClipboardCheckIntervalMs', thresholds.clipboardCheckIntervalMs);
            const panel = form.querySelector('#rustCustomThresholdsPanel');
            if (panel) panel.style.display = custom ? 'block' : 'none';
            set('rustWhitelistKeywords', Array.isArray(rust.whitelist) ? rust.whitelist.join('\n') : '');
            set('rustBlacklistKeywords', Array.isArray(rust.blacklist) ? rust.blacklist.join('\n') : '');
            set('rustScreenshotApps', Array.isArray(rust.screenshotApps) ? rust.screenshotApps.join('\n') : '');
            const ruleMode = Array.isArray(rust.whitelist) && rust.whitelist.length
                ? 'whitelist'
                : (Array.isArray(rust.blacklist) && rust.blacklist.length ? 'blacklist' : 'none');
            set('rustRuleMode', ruleMode);
            const guard = form.querySelector('#rustGuardRulesContainer');
            if (guard) guard.style.display = rust.useRustAssistant === true ? 'block' : 'none';
            const whitelistPanel = form.querySelector('#rustWhitelistPanel');
            const blacklistPanel = form.querySelector('#rustBlacklistPanel');
            if (whitelistPanel) whitelistPanel.style.display = ruleMode === 'whitelist' ? 'block' : 'none';
            if (blacklistPanel) blacklistPanel.style.display = ruleMode === 'blacklist' ? 'block' : 'none';
            const debugPanel = form.querySelector('#rustDebugPanel');
            if (debugPanel) debugPanel.style.display = rust.debugMode === true ? 'block' : 'none';
        };
        const release = rustService.state.subscribe(applyRust);
        const rustScope = ensurePresentationScope();
        if (rustScope) rustScope.own(release, 'typed-rust-assistant-consumer', 'ui-presentation');
        else release?.();
        void rustService.refresh.execute();
    }
    const forumService = ensureForumConfigUiService();
    if (forumService) {
        const applyForum = (_value, snapshot) => {
            if (form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
            const forum = snapshot.value || {};
            const username = form.querySelector('#adminUsername');
            const password = form.querySelector('#adminPassword');
            if (username && forum.username !== undefined) username.value = String(forum.username || '');
            if (password && forum.password !== undefined) password.value = String(forum.password || '');
        };
        const release = forumService.state.subscribe(applyForum);
        const forumScope = ensurePresentationScope();
        if (forumScope) forumScope.own(release, 'typed-forum-config-consumer', 'ui-presentation');
        else release?.();
        void forumService.refresh.execute();
    }
    const runtimeService = ensureAssistantRuntimeUiService();
    if (runtimeService) {
        const applyRuntime = (_value, snapshot) => {
            const runtime = snapshot.value || {};
            const modeText = runtime.mode === 'rust' ? 'Rust' : (runtime.mode === 'disabled' ? 'Disabled' : runtime.mode || 'Unknown');
            const desiredText = runtime.desiredMode === 'rust' ? 'Rust' : (runtime.desiredMode === 'disabled' ? 'Disabled' : runtime.desiredMode || 'Unknown');
            const setText = (id, value) => { const node = form.querySelector(`#${id}`); if (node) node.textContent = String(value ?? '无'); };
            setText('assistantRuntimeMode', modeText);
            setText('assistantRuntimeDesiredMode', desiredText);
            setText('assistantRuntimeActive', runtime.active === true ? '运行中' : '未运行');
            setText('assistantRuntimeDebugReason', runtime.debugReason || '无');
            setText('assistantRuntimeForwardedCount', runtime.integrationTrace?.forwardedCount ?? 0);
            setText('assistantRuntimeSidecarActive', runtime.sidecarActive === true ? '运行中' : '未运行');
            setText('assistantRuntimeProcessAlive', runtime.adapterProcessAlive === true ? '运行中' : '未运行');
            setText('assistantRuntimeProcessPid', runtime.adapterProcessPid || '无');
            setText('assistantRuntimeAutoFallbackCount', runtime.runtimeFallbackTrace?.autoFallbackCount ?? 0);
            setText('assistantRuntimeAutoFallbackReason', runtime.runtimeFallbackTrace?.lastAutoFallbackReason || '无');
            setText('assistantRuntimeReceivedCount', runtime.integrationTrace?.receivedSelectionCount ?? 0);
            setText('assistantRuntimeShowAttemptCount', runtime.integrationTrace?.showAttemptCount ?? 0);
            setText('assistantRuntimeShowError', runtime.integrationTrace?.lastShowError || '无');
        };
        const release = runtimeService.state.subscribe(applyRuntime);
        const runtimeScope = ensurePresentationScope();
        if (runtimeScope) runtimeScope.own(release, 'typed-assistant-runtime-consumer', 'ui-presentation');
        else release?.();
        void runtimeService.refresh.execute();
    }
}

function ensureRustAssistantUiService() {
    if (typedRustAssistantService || !typedSettingsRegistry || !window.VCPUIUX?.createRustAssistantUiService) return typedRustAssistantService;
    const chatAPI = window.chatAPI;
    if (!chatAPI?.getRustAssistantConfig || !chatAPI?.saveRustAssistantConfig) return null;
    const adapter = window.VCPUIUX.createRustAssistantUiService({
        get: () => chatAPI.getRustAssistantConfig(),
        save: patch => chatAPI.saveRustAssistantConfig(patch),
    });
    const definition = window.VCPUIUX.rustAssistantUiDefinition;
    typedRustAssistantService = typedSettingsRegistry.install(definition, context => definition.provide({
        ...context,
        services: { ...context.services, rustAssistantAdapter: adapter },
    }));
    return typedRustAssistantService;
}

function ensureForumConfigUiService() {
    if (typedForumConfigService || !typedSettingsRegistry || !window.VCPUIUX?.createForumConfigUiService) return typedForumConfigService;
    const chatAPI = window.chatAPI;
    if (!chatAPI?.loadForumConfig || !chatAPI?.saveForumConfig) return null;
    const adapter = window.VCPUIUX.createForumConfigUiService({
        get: () => chatAPI.loadForumConfig(),
        save: patch => chatAPI.saveForumConfig(patch),
    });
    const definition = window.VCPUIUX.forumConfigUiDefinition;
    typedForumConfigService = typedSettingsRegistry.install(definition, context => definition.provide({
        ...context,
        services: { ...context.services, forumConfigAdapter: adapter },
    }));
    return typedForumConfigService;
}

function ensureAssistantRuntimeUiService() {
    if (typedAssistantRuntimeService || !typedSettingsRegistry || !window.VCPUIUX?.createAssistantRuntimeUiService) return typedAssistantRuntimeService;
    const chatAPI = window.chatAPI;
    if (!chatAPI?.getAssistantRuntimeStatus) return null;
    const adapter = window.VCPUIUX.createAssistantRuntimeUiService({ get: () => chatAPI.getAssistantRuntimeStatus() });
    const definition = window.VCPUIUX.assistantRuntimeUiDefinition;
    typedAssistantRuntimeService = typedSettingsRegistry.install(definition, context => definition.provide({
        ...context,
        services: { ...context.services, assistantRuntimeAdapter: adapter },
    }));
    return typedAssistantRuntimeService;
}

function ensurePresentationScope() {
    if (destroyed) return null;
    if (!presentationScope) {
        presentationScope = bridgeScope?.child('settings-presentation') || null;
    }
    return presentationScope;
}

// The single Select projection over the generated primitive; the bridge
// injects the presentation scope so the module never reaches back up here.
const selectProjection = createSelectProjection({ ensurePresentationScope });

function shouldEnhanceSidebarSettings() {
    // Global settings has one presentation contract.  The data attribute is
    // retained only as bootstrap metadata; it never selects a second layout.
    return Boolean(settingsHost);
}

function hasGlobalSettingsSurface() {
    // Global settings has one canonical surface.  Keep this helper as a
    // compatibility seam for callers, but never branch its presentation mode.
    return Boolean(document.getElementById('globalSettingsModal'));
}

function syncGlobalSettingsHost() {
    const modal = document.getElementById('globalSettingsModal');
    const active = Boolean(modal?.classList.contains('active'));
    document.documentElement.classList.toggle('vcp-global-settings-host', active);
    // Keep the historical marker as a non-branching compatibility alias for
    // automation/tests; all styling is owned by the unified surface marker.
    modal?.classList.add('vcp-global-settings-surface');
    return modal;
}

function enhance(name, element, options = {}) {
    if (!element || window.VCPUI.getController(element)) return;
    try {
        const controller = window.VCPUI.enhance(name, element, options);
        controllers.add(controller);
        const scope = ensurePresentationScope();
        if (scope) {
            controllerReleases.set(controller, scope.own(() => controller.destroy(), `settings:${name}`, 'ui-registration'));
        }
    } catch (error) {
        console.warn(`[VCPUI SettingsBridge] Could not enhance ${name}:`, error);
    }
}

function enhanceForm(form) {
    mountTypedAgentIdentityInput(form);
    mountTypedAgentModelInput(form);
    mountTypedAgentTemperatureInput(form);
    mountTypedAgentNumericInputs(form);
    mountTypedAgentRegexInputs(form);
    mountTypedAgentStreamChoice(form);
    mountTypedAgentTtsSpeedRange(form);
    mountTypedAgentColorPairs(form);
    mountTypedAgentButtons(form);
    mountTypedAgentModelPicker(form);
    mountTypedAgentPromptModeButtons(form);
    selectProjection.mount(form);
    form.querySelectorAll('.agent-settings-section, .group-settings-section').forEach(section => {
        enhance('SettingsSection', section);
    });
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        if (['agentNameInput', 'agentModel', 'agentTemperature', 'agentContextTokenLimit', 'agentMaxOutputTokens', 'agentTopP', 'agentTopK', 'agentTtsRegexPrimary', 'agentTtsRegexSecondary'].includes(input.id)) return;
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => {
        if (!select.closest('.vcp-harness-select')) enhance('Select', select, { kernel: 'native' });
    });
    form.querySelectorAll('input[type="range"]').forEach(range => {
        if (!range.closest('.vcp-uiux-range')) enhance('Range', range);
    });
    mountHarnessSwitches(form);
    form.querySelectorAll('.agent-style-collapsible-container').forEach(disclosure => {
        disclosure.dataset.settingPrimitive = 'disclosure';
        disclosure.querySelector('.style-collapse-header')?.classList.add('vcp-harness-disclosure-row');
    });
    form.querySelectorAll('.agent-name-wrapper, .group-name-wrapper, .group-settings-field-shell, .style-control-item, .params-content > div:not(.form-group-inline)').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    form.querySelectorAll(':scope > .form-actions').forEach(actionBar => {
        enhance('SettingsActionBar', actionBar, { form });
    });
}

// The Agent inputs differ in business semantics (identity, free-form model,
// numeric limits and TTS regexes), but their presentation lifecycle is the
// same: a generated Input owns the Light-DOM wrap while the native input
// stays canonical.  Keep that small contract in one private helper instead
// of growing nine independent marker/restore paths.
function mountTypedAgentInput(form, { id, marker, ownerKey, placeholder = false, restoreClass = false }) {
    const input = form?.querySelector?.(`#${id}`);
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!input || !api?.mountInput || !scope || input.dataset[marker] === 'true') return;

    const originalClass = restoreClass ? input.className : null;
    const props = placeholder ? { placeholder: input.getAttribute('placeholder') || undefined } : {};
    try {
        api.mountInput(input, props, scope);
        input.dataset[marker] = 'true';
        scope.own(() => {
            delete input.dataset[marker];
            if (restoreClass && input.isConnected && input.className !== originalClass) input.className = originalClass;
        }, ownerKey, 'ui-presentation');
    } catch (error) {
        console.warn(`[VCPUI SettingsBridge] Could not mount typed ${id} Input:`, error);
    }
}

function mountTypedAgentRegexInputs(form) {
    ['agentTtsRegexPrimary', 'agentTtsRegexSecondary'].forEach(id => {
        mountTypedAgentInput(form, {
            id,
            marker: 'vcpTypedPrimitiveMounted',
            ownerKey: `typed-${id}-marker`,
        });
    });
}

// The model picker owns the model trigger's presentation and lifecycle. Keep
// that trigger out of the generic Button batch below so one node never has
// two presentation owners.
function mountTypedAgentButtons(form) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!api?.mountButton || !scope) return;
    const buttons = [
        ['#refreshTtsModelsBtn', 'outline', 'agent-tts-refresh'],
        ['#resetAvatarColorsBtn', 'outline', 'agent-reset-colors'],
        ['.form-actions button[type="submit"]', 'primary', 'agent-save'],
        ['#deleteAgentBtn', 'outline', 'agent-delete'],
    ];
    buttons.forEach(([selector, variant, key]) => {
        const button = form?.querySelector?.(selector);
        const marker = `vcpTyped${key.replace(/(^|-)(\w)/g, (_, __, value) => value.toUpperCase())}`;
        if (!button || button.dataset[marker] === 'true') return;
        try {
            const size = key.includes('refresh') ? 'sm' : 'md';
            api.mountButton(button, { variant, size }, scope);
            // Legacy action-bar rules still carry a 37px min-height. Once the
            // typed Button owns this node, that minimum becomes a geometry
            // override (md contract is 36px). Keep the correction owner-bound
            // and restore the exact declaration during teardown.
            const minHeight = size === 'sm' ? '28px' : '36px';
            const originalMinHeight = [button.style.getPropertyValue('min-height'), button.style.getPropertyPriority('min-height')];
            button.style.setProperty('min-height', minHeight, 'important');
            scope.own(() => {
                if (originalMinHeight[0]) button.style.setProperty('min-height', originalMinHeight[0], originalMinHeight[1]);
                else button.style.removeProperty('min-height');
                delete button.dataset[marker];
            }, `${key}-button-marker`, 'ui-presentation');
            button.dataset[marker] = 'true';
            // mountButton already binds its disposer to this scope. Registering
            // its returned release again would retain a duplicate lifecycle
            // resource and run teardown twice.
        } catch (error) {
            console.warn(`[VCPUI SettingsBridge] Could not mount typed Agent ${key} Button:`, error);
        }
    });
}

// The Agent model picker is the first production consumer of the Harness
// model-selection candidate.  The native #agentModel input remains the sole
// business/persistence node; this bridge only supplies model discovery and
// writes the same input/change events that the retired modal callback used.
// Hot/favorite sections and the explicit refresh action remain in the legacy
// modal for now and are intentionally recorded as a migration gap.
function mountTypedAgentModelPicker(form) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    const host = form?.querySelector?.('.model-input-container');
    const input = form?.querySelector?.('#agentModel');
    const trigger = form?.querySelector?.('#openModelSelectBtn');
    const electronAPI = window.chatAPI;
    if (!api?.mountAgentModelPicker || !scope || !host || !input || !trigger
        || trigger.dataset.vcpTypedAgentModelPicker === 'true') return;

    // Agent Settings can retain the previous section bank in the connected
    // DOM while replacing the active form. Treat the picker as a single
    // surface owner so a connected-but-hidden trigger cannot retain a child
    // scope across form generations.
    for (const [previousTrigger, release] of agentModelPickerReleases) {
        if (previousTrigger === trigger) continue;
        void release().catch(error => {
            console.error('[VCPUI SettingsBridge] Failed to release replaced Agent model picker:', error);
        });
    }

    const normalizeModels = payload => {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.data)) return payload.data;
        if (Array.isArray(payload?.models)) return payload.models;
        if (typeof payload?.id === 'string') return [payload];
        return [];
    };
    const modelOptions = async signal => {
        let models = await electronAPI?.getCachedModels?.();
        if (signal.aborted) return [];
        if (normalizeModels(models).length === 0 && electronAPI?.refreshModels) {
            await electronAPI.refreshModels();
            if (signal.aborted) return [];
            models = await electronAPI.getCachedModels?.();
        }
        if (signal.aborted) return [];
        let hotModelIds = [];
        let favoriteModelIds = [];
        try {
            [hotModelIds, favoriteModelIds] = await Promise.all([
                electronAPI?.getHotModels?.() ?? [],
                electronAPI?.getFavoriteModels?.() ?? [],
            ]);
        } catch {
            // Metadata is presentation-only; model selection remains usable.
        }
        if (signal.aborted) return [];
        const hotSet = new Set(Array.isArray(hotModelIds) ? hotModelIds : []);
        const favoriteSet = new Set(Array.isArray(favoriteModelIds) ? favoriteModelIds : []);
        return normalizeModels(models).map(model => {
            const id = typeof model === 'string' ? model : model?.id;
            if (!id) return null;
            const provider = typeof model === 'object' ? (model.provider || model.owned_by) : undefined;
            const label = typeof model === 'object' ? (model.name || id) : id;
            const metadata = [provider, hotSet.has(id) ? '热门' : undefined, favoriteSet.has(id) ? '收藏' : undefined]
                .filter(Boolean).join(' · ');
            return {
                id: String(id),
                label: String(label),
                provider: metadata || undefined,
                favorite: favoriteSet.has(id),
                active: String(id) === String(input.value || ''),
            };
        }).filter(Boolean);
    };
    // The directory remains a short-lived UI capability: this bridge is the
    // sole chatAPI boundary, while AgentModelPicker owns only the current
    // popup projection. Neither refresh nor a favorite mutation writes a
    // second model store or changes the canonical #agentModel input.
    const modelDirectory = {
        async refresh(signal) {
            if (!electronAPI?.refreshModels) throw new Error('当前环境不支持刷新模型列表');
            await electronAPI.refreshModels();
            if (signal.aborted) return;
        },
        async toggleFavorite(modelId, signal) {
            if (!electronAPI?.toggleFavoriteModel) throw new Error('当前环境不支持收藏模型');
            await electronAPI.toggleFavoriteModel(modelId);
            if (signal.aborted) return;
        },
        subscribeUpdated(listener) {
            if (!electronAPI?.onModelsUpdated) return undefined;
            return electronAPI.onModelsUpdated(() => listener());
        },
    };

    const originalTriggerInline = {};
    ['position', 'right', 'top', 'transform', 'width', 'min-width', 'max-width', 'height', 'padding',
        'border-radius', 'border', 'background', 'background-color', 'display', 'justify-content'].forEach(property => {
        originalTriggerInline[property] = [trigger.style.getPropertyValue(property), trigger.style.getPropertyPriority(property)];
    });
    let picker = null;
    const pickerScope = scope.child('agent-model-picker-production');
    try {
        picker = api.mountAgentModelPicker(host, {
            trigger,
            label: '选择模型',
            selectedId: input.value || undefined,
            options: modelOptions,
            directory: modelDirectory,
            onSelect: option => {
                if (input.disabled) return;
                input.value = option.id;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            },
        }, pickerScope);

        // The model-input container is positioned; keep the popup and trigger
        // in the same anchored strip while the native input keeps its width.
        picker.root.style.setProperty('position', 'absolute', 'important');
        picker.root.style.setProperty('right', '5px', 'important');
        picker.root.style.setProperty('top', '50%', 'important');
        picker.root.style.setProperty('transform', 'translateY(-50%)', 'important');
        picker.root.style.setProperty('z-index', '2', 'important');
        trigger.style.setProperty('position', 'static', 'important');
        trigger.style.setProperty('right', 'auto', 'important');
        trigger.style.setProperty('top', 'auto', 'important');
        trigger.style.setProperty('transform', 'none', 'important');
        trigger.style.setProperty('width', 'auto', 'important');
        trigger.style.setProperty('min-width', '0', 'important');
        trigger.style.setProperty('max-width', '220px', 'important');
        trigger.style.setProperty('height', '28px', 'important');
        trigger.style.setProperty('padding', '0 4px 0 8px', 'important');
        trigger.style.setProperty('border-radius', '24px', 'important');
        trigger.style.setProperty('border', '0', 'important');
        trigger.style.setProperty('background', 'transparent', 'important');
        trigger.style.setProperty('display', 'inline-flex', 'important');
        trigger.style.setProperty('justify-content', 'center', 'important');
        trigger.dataset.vcpTypedAgentModelPicker = 'true';

        pickerScope.listen(input, 'input', () => picker?.setSelected(input.value || undefined));
        pickerScope.listen(input, 'change', () => picker?.setSelected(input.value || undefined));
        pickerScope.listen(document, 'vcp-settings-surface-updated', event => {
            if (event.detail?.root === form || event.detail?.kind === 'agent') picker?.setSelected(input.value || undefined);
        });
        const release = scope.own(async () => {
            delete trigger.dataset.vcpTypedAgentModelPicker;
            for (const [property, [value, priority]] of Object.entries(originalTriggerInline)) {
                if (value) trigger.style.setProperty(property, value, priority);
                else trigger.style.removeProperty(property);
            }
            // `pickerScope` owns the primitive's child scope. Disposing the
            // controller first and then its parent created two synonymous
            // cleanup requests on every Settings surface swap; one parent
            // scope disposal reaches quiescence and preserves exact restore.
            await pickerScope.dispose('agent-model-picker-production-released');
            agentModelPickerReleases.delete(trigger);
        }, 'agent-model-picker-production', 'ui-primitive');
        agentModelPickerReleases.set(trigger, release);
    } catch (error) {
        void picker?.dispose?.();
        void pickerScope.dispose('agent-model-picker-production-failed');
        console.warn('[VCPUI SettingsBridge] Could not mount typed Agent model picker:', error);
    }
}

function mountTypedAgentPromptModeButtons(form) {
    const api = window.VCPUIUX;
    if (!api?.mountButton) return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    form?.querySelectorAll?.('.prompt-mode-button').forEach((button, index) => {
        if (!(button instanceof HTMLButtonElement) || button.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountButton(button, { variant: 'ghost', size: 'sm' }, scope);
        button.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete button.dataset.vcpTypedPrimitiveMounted; }, `typed-agent-prompt-mode-${index}-marker`, 'ui-primitive');
    });
}

// The agent editor keeps the native input as its canonical form/business node;
// only the visual wrapper is owned by the typed Harness candidate. This is a
// narrow migration slice and deliberately excludes chat-side assistant
// switching and the remaining agent fields.
function mountTypedAgentIdentityInput(form) {
    mountTypedAgentInput(form, {
        id: 'agentNameInput',
        marker: 'vcpTypedAgentIdentity',
        ownerKey: 'agent-name-input-marker',
        placeholder: true,
        restoreClass: true,
    });
}

// Agent model remains a free-form native value with a separate legacy model
// picker button/modal. Upgrade only the input presentation; the picker and
// persistence semantics stay owned by the existing Agent settings flow.
function mountTypedAgentModelInput(form) {
    mountTypedAgentInput(form, {
        id: 'agentModel',
        marker: 'vcpTypedAgentModel',
        ownerKey: 'agent-model-input-marker',
        placeholder: true,
    });
}

// Temperature remains a native number input because min/max/step and the
// settings manager's numeric parsing are part of the canonical business
// contract. Only its presentation is upgraded to the typed Harness Input.
function mountTypedAgentTemperatureInput(form) {
    mountTypedAgentInput(form, {
        id: 'agentTemperature',
        marker: 'vcpTypedAgentTemperature',
        ownerKey: 'agent-temperature-input-marker',
        restoreClass: true,
    });
}

// These fields are all canonical numeric settings. Keep their native number
// semantics and constraints while sharing the same typed Input presentation
// owner used by the identity/model/temperature slices.
function mountTypedAgentNumericInputs(form) {
    const fields = [
        ['agentContextTokenLimit', 'vcpTypedAgentContextLimit', 'agentContextTokenLimit-input-marker'],
        ['agentMaxOutputTokens', 'vcpTypedAgentMaxOutput', 'agentMaxOutputTokens-input-marker'],
        ['agentTopP', 'vcpTypedAgentTopP', 'agentTopP-input-marker'],
        ['agentTopK', 'vcpTypedAgentTopK', 'agentTopK-input-marker'],
    ];
    fields.forEach(([id, marker, ownerKey]) => {
        mountTypedAgentInput(form, { id, marker, ownerKey, restoreClass: true });
    });
}

// The stream output pair is a presentation-only Choice primitive over the
// existing native radio controls.  settingsManager remains the sole source
// of the persisted boolean and chatManager keeps its existing consumption.
function mountTypedAgentStreamChoice(form) {
    const group = form?.querySelector?.('#agentStreamOutputTrue')?.closest('.form-group-inline');
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!group || !api?.mountChoice || !scope || group.dataset.vcpTypedAgentStreamChoice === 'true') return;
    try {
        api.mountChoice(group, scope);
        group.dataset.vcpTypedAgentStreamChoice = 'true';
        scope.own(() => { delete group.dataset.vcpTypedAgentStreamChoice; }, 'agent-stream-choice-marker', 'ui-presentation');
    } catch (error) {
        console.warn('[VCPUI SettingsBridge] Could not mount typed Agent stream Choice:', error);
    }
}

// TTS speed is a stable native range with an existing output node.  The typed
// Range owns only the visual wrapper and output synchronization; settings
// manager remains responsible for reading/writing the persisted numeric value.
function mountTypedAgentTtsSpeedRange(form) {
    const input = form?.querySelector?.('#agentTtsSpeed');
    const output = form?.querySelector?.('#ttsSpeedValue');
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!input || !output || !api?.mountRange || !scope || input.dataset.vcpTypedAgentTtsSpeed === 'true') return;
    try {
        api.mountRange(input, { output, format: value => value }, scope);
        input.dataset.vcpTypedAgentTtsSpeed = 'true';
        scope.own(() => { delete input.dataset.vcpTypedAgentTtsSpeed; }, 'agent-tts-speed-range-marker', 'ui-presentation');
    } catch (error) {
        console.warn('[VCPUI SettingsBridge] Could not mount typed Agent TTS speed Range:', error);
    }
}

function mountTypedAgentColorPairs(form) {
    const api = window.VCPUIUX;
    if (!api?.mountColorPair) return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    [
        ['#agentAvatarBorderColor', '#agentAvatarBorderColorText', 'agent-avatar-border-color'],
        ['#agentNameTextColor', '#agentNameTextColorText', 'agent-name-text-color'],
    ].forEach(([colorSelector, textSelector, key]) => {
        const color = form?.querySelector?.(colorSelector);
        const text = form?.querySelector?.(textSelector);
        if (!color || !text || color.dataset.vcpTypedPrimitiveMounted === 'true') return;
        api.mountColorPair(color, text, scope);
        color.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete color.dataset.vcpTypedPrimitiveMounted; }, `typed-${key}-marker`, 'ui-primitive');
    });
}

// Lucide icon names for the global settings categories. Icons are always
// rendered through VCPUI (`.vcp-ui-icon` -> lucide-adapter); no inline SVG,
// emoji or text arrows on this surface.
const GLOBAL_CATEGORY_ICONS = Object.freeze({
    'user-identity': 'user',
    'server-connection': 'server',
    'appearance-settings': 'palette',
    'render-settings': 'activity',
    'selection-assistant': 'mouse-pointer-click',
    'voice-settings': 'mic',
    'advanced-features': 'layers',
    'quick-actions': 'zap',
});

// Global settings modal: control enhancement, autosave status, and the
// source-equivalent SettingsRoot shell.
function enhanceGlobalSettings(root, form) {
    mountCanonicalSettingsRows(form);
    removeLegacySubsectionHeadings(form);
    mountHarnessInputs(form);
    // The legacy VCPUI native-kernel Input/Textarea class enhancement is
    // retired here: the real library Input primitive above owns single-line
    // input presentation, and textareas keep the bare-control contract.
    // Short enumerations remain native/segmented controls. Long enumerations
    // get a Harness-style popover, but the native select is retained as the
    // one authoritative business node.
    mountTypedAppearanceSelects(root, form);
    selectProjection.mount(form);
    mountTypedHomeTaglineInput(root, form);
    mountTypedRadiusChoice(root, form);
    mountTypedAppearanceRanges(root, form);
    mountTypedHomeVisualToggles(root, form);
    mountTypedAvatarColorPair(root, form);
    mountTypedForumInputs(root, form);
    mountTypedForumFieldOwner(root, form);
    form.querySelectorAll('input[type="range"]').forEach(range => { if (!['appearanceSidebarAvatarSize', 'appearanceSidebarRowHeight', 'appearanceCustomRadius'].includes(range.id)) enhance('Range', range); });
    mountHarnessSwitches(form);
    form.querySelectorAll('.agent-style-collapsible-container').forEach(disclosure => {
        disclosure.dataset.settingPrimitive = 'disclosure';
        disclosure.querySelector('.style-collapse-header')?.classList.add('vcp-harness-disclosure-row');
    });
    mountHarnessDisclosures(form);
    form.querySelectorAll('.agent-name-wrapper').forEach(field => {
        if (field.querySelector('input:not([type="hidden"]), select, textarea')) enhance('Field', field);
    });
    mountSettingsShell(root);
    mountSettingsAutosave(root, form);
    mountTypedFieldOwner(root, form);
    normalizeFormIcons(root);
}

function mountTypedRadiusChoice(root, form) {
    const group = form?.querySelector?.('.appearance-radius-choice-grid');
    const api = window.VCPUIUX;
    if (!group || !api?.mountChoice || group.dataset.vcpTypedPrimitiveMounted === 'true') return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    const release = api.mountChoice(group, scope);
    group.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete group.dataset.vcpTypedPrimitiveMounted; }, 'typed-radius-choice-marker', 'ui-primitive');
    if (release) scope.own(release, 'typed-radius-choice', 'ui-primitive');
}

function mountTypedAppearanceRanges(root, form) {
    const api = window.VCPUIUX;
    if (!api?.mountRange) return;
    const scope = ensurePresentationScope(); if (!scope) return;
    [['appearanceSidebarAvatarSize', 'appearanceSidebarAvatarSizeValue'], ['appearanceSidebarRowHeight', 'appearanceSidebarRowHeightValue'], ['appearanceCustomRadius', 'appearanceCustomRadiusValue']].forEach(([id, outputId]) => {
        const input = form?.querySelector?.(`#${id}`); const output = form?.querySelector?.(`#${outputId}`);
        if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        const release = api.mountRange(input, { output, format: value => `${value}px` }, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
        if (release) scope.own(release, `typed-${id}-range`, 'ui-primitive');
    });
}

function mountTypedHomeVisualToggles(root, form) {
    const api = window.VCPUIUX; if (!api?.mountToggle) return;
    const scope = ensurePresentationScope(); if (!scope) return;
    ['showHomeVisualBrand', 'showHomeVisualTagline'].forEach(id => {
        const input = form?.querySelector?.(`#${id}`);
        if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        const release = api.mountToggle(input, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
        if (release) scope.own(release, `typed-${id}-toggle`, 'ui-primitive');
    });
}

function mountTypedAvatarColorPair(root, form) {
    const api = window.VCPUIUX; if (!api?.mountColorPair) return;
    const scope = ensurePresentationScope(); if (!scope) return;
    // The Agent form mounts the same two pairs; the global form must keep
    // parity so its hex text boxes and pickers stay two-way synced.
    [['#userAvatarBorderColor', '#userAvatarBorderColorText', 'avatar-border'],
     ['#userNameTextColor', '#userNameTextColorText', 'user-name-text']].forEach(([colorId, textId, name]) => {
        const color = form?.querySelector?.(colorId);
        const text = form?.querySelector?.(textId);
        if (!color || !text || color.dataset.vcpTypedPrimitiveMounted === 'true') return;
        try {
            const release = api.mountColorPair(color, text, scope);
            color.dataset.vcpTypedPrimitiveMounted = 'true';
            scope.own(() => { delete color.dataset.vcpTypedPrimitiveMounted; }, `typed-${name}-color-marker`, 'ui-primitive');
            if (release) scope.own(release, `typed-${name}-color-pair`, 'ui-primitive');
        } catch (error) {
            // A pairing contract violation (e.g. a wrap moved one input) must
            // not break the whole enhancement chain; the pair stays native.
            console.warn('[VCPUI SettingsBridge] Could not mount color pair primitive:', error);
        }
    });
}

function mountTypedHomeTaglineInput(root, form) {
    const input = form?.querySelector?.('#homeVisualTagline');
    const api = window.VCPUIUX;
    if (!input || !api?.mountInput || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    const release = api.mountInput(input, {}, scope);
    input.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, 'typed-home-tagline-marker', 'ui-primitive');
    if (release) scope.own(release, 'typed-home-tagline-input', 'ui-primitive');
}

// Forum credentials are presentation-only in this phase.  The existing
// ForumConfigUiService/global submit path remains the command owner until its
// dirty/autosave seam is migrated; this primitive only establishes the
// Harness Light-DOM geometry and scope-owned teardown contract.
function mountTypedForumInputs(root, form) {
    const api = window.VCPUIUX;
    if (!api?.mountInput) return;
    const scope = ensurePresentationScope();
    if (!scope) return;
    ['adminUsername', 'adminPassword'].forEach(id => {
        const input = form?.querySelector?.(`#${id}`);
        if (!input || input.dataset.vcpTypedPrimitiveMounted === 'true') return;
        const release = api.mountInput(input, {}, scope);
        input.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete input.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
        if (release) scope.own(release, `typed-${id}-input`, 'ui-primitive');
    });
}

function mountTypedForumFieldOwner(root, form) {
    if (!root || !form || form.dataset.vcpTypedForumFieldOwnerMounted === 'true') return;
    const service = typedSettingsRegistry?.get('forum-config-ui') || ensureForumConfigUiService();
    if (!service?.save?.execute) return;
    const controls = ['adminUsername', 'adminPassword'].map(id => form.querySelector(`#${id}`)).filter(Boolean);
    if (controls.length !== 2) return;
    const state = { form, timer: null, pending: false, inFlight: null, disposed: false, failed: false };
    const status = () => root.querySelector('.vcp-settings-autosave-status');
    const run = async () => {
        state.timer = null;
        if (state.disposed || !state.pending || state.inFlight) return;
        state.pending = false;
        const username = form.querySelector('#adminUsername')?.value?.trim() || '';
        const password = form.querySelector('#adminPassword')?.value || '';
        state.inFlight = service.save.execute({ username, password, rememberCredentials: true });
        status()?.setAttribute('data-state', 'saving');
        if (status()) status().textContent = '保存中…';
        try {
            const result = await state.inFlight;
            if (state.disposed) return;
            if (!result?.success) {
                state.failed = true;
                form.dataset.vcpSettingsDirty = 'true';
                status()?.setAttribute('data-state', 'error');
                if (status()) status().textContent = '保存失败 · 重试';
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: false, error: result?.error || '论坛配置保存失败', owner: 'typed-forum-field-owner' } }));
            } else {
                state.failed = false;
                if (!state.pending) delete form.dataset.vcpSettingsDirty;
                status()?.setAttribute('data-state', 'saved');
                if (status()) status().textContent = '已保存';
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: true, owner: 'typed-forum-field-owner' } }));
            }
        } catch (error) {
            if (!state.disposed) {
                state.failed = true;
                form.dataset.vcpSettingsDirty = 'true';
                status()?.setAttribute('data-state', 'error');
                if (status()) status().textContent = '保存失败 · 重试';
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: false, error: error?.message || String(error), owner: 'typed-forum-field-owner' } }));
            }
        } finally { state.inFlight = null; if (state.pending) schedule(); }
    };
    const schedule = () => {
        if (state.disposed) return;
        state.pending = true;
        form.dataset.vcpSettingsDirty = 'true';
        status()?.setAttribute('data-state', 'dirty');
        if (status()) status().textContent = '未保存';
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(run, 400);
    };
    const onInput = event => { if (controls.includes(event.target)) schedule(); };
    // Retry clicks belong to whichever owner produced the current error.
    // Routing them unconditionally turns a legacy autosave failure into a
    // spurious forum save instead of retrying the failed field.
    const ownsError = () => state.failed && status()?.dataset.state === 'error';
    const onStatusClick = () => { if (ownsError()) schedule(); };
    state.run = run;
    controls.forEach(control => control.addEventListener('input', onInput));
    controls.forEach(control => control.addEventListener('change', onInput));
    const statusNode = status();
    statusNode?.addEventListener('click', onStatusClick);
    controls.forEach(control => { control.dataset.vcpTypedForumFieldOwner = 'true'; });
    form.dataset.vcpTypedForumFieldOwnerMounted = 'true';
    typedForumFieldStates.add(state);
    ensurePresentationScope()?.own(() => {
        state.disposed = true;
        if (state.timer) clearTimeout(state.timer);
        controls.forEach(control => { control.removeEventListener('input', onInput); control.removeEventListener('change', onInput); delete control.dataset.vcpTypedForumFieldOwner; });
        statusNode?.removeEventListener('click', onStatusClick);
        typedForumFieldStates.delete(state);
        delete form.dataset.vcpTypedForumFieldOwnerMounted;
    }, 'typed-forum-field-owner', 'ui-presentation');
}

function mountTypedAppearanceSelects(root, form) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!scope || !api?.mountSelect) return;
    const fields = [
        ['appearanceDensity', '界面密度'],
        ['appearanceRadius', '圆角风格'],
        ['appearanceTypography', '界面字体'],
        ['appearanceFontScale', '界面字号'],
        ['appearanceContentWidth', '内容宽度'],
        ['appearanceSurface', '页面材质'],
    ];
    fields.forEach(([id, label]) => {
        const select = form?.querySelector?.(`#${id}`);
        if (!select || select.dataset.vcpTypedPrimitiveMounted === 'true') return;
        if (api.mountField && select.parentElement) {
            const fieldRelease = api.mountField(select.parentElement, { label, control: select }, scope);
            if (fieldRelease) scope.own(fieldRelease, `typed-${id}-field`, 'ui-primitive');
        }
        const release = api.mountSelect(select, { label, portal: true }, scope);
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
        if (release) scope.own(release, `typed-${id}-select`, 'ui-primitive');
    });
}

// Single-line text inputs are projected by the real library Input primitive
// (window.VCPUIUX.mountInput): the native input stays the sole business node
// while the primitive wrap owns the border/focus surface.  Textareas are
// deliberately excluded — the primitive wrap is a fixed 32px single-line
// frame, and the form's bare-control contract already gives textareas their
// multiline geometry (contract gap reported to thread A).  The typed mounts
// (home tagline, forum credentials, color pair) own their own controls.
let settingsKeySeed = 0;
function uniqueSettingsKey() {
    settingsKeySeed += 1;
    return `anon-${settingsKeySeed}`;
}

// Switch labels adopt the real library Toggle primitive per checkbox: the
// native input stays the authoritative node while the primitive wrap draws
// the track/knob and hides the retired local `.slider` span.  The typed home
// visual toggles keep their own mounts, and the legacy VCPUI native-kernel
// switch stays as the degraded presentation when the primitive runtime or
// the presentation scope is unavailable.
function mountHarnessSwitches(form) {
    if (!form) return;
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    form.querySelectorAll('label.switch').forEach(control => {
        if (control.querySelector('#showHomeVisualBrand, #showHomeVisualTagline')) return;
        const input = control.querySelector('input[type="checkbox"]');
        if (!input || input.dataset.vcpHarnessToggleMounted === 'true') return;
        if (!api?.mountToggle || !scope) {
            enhance('Switch', control);
            return;
        }
        try {
            const release = api.mountToggle(input, scope);
            if (!release) return;
            input.dataset.vcpHarnessToggleMounted = 'true';
            scope.own(() => { delete input.dataset.vcpHarnessToggleMounted; }, `harness-toggle-${input.id || control.querySelector('input[name]')?.name || uniqueSettingsKey()}`, 'ui-presentation');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount Harness Toggle primitive:', error);
        }
    });
}

function mountHarnessInputs(form) {
    const api = window.VCPUIUX;
    const scope = ensurePresentationScope();
    if (!api?.mountInput || !scope) return;
    const selector = 'input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])';
    form.querySelectorAll(selector).forEach(control => {
        if (control.dataset.vcpHarnessInputPrimitive === 'true') return;
        if (control.id === 'homeVisualTagline' || control.id === 'userAvatarBorderColorText' || control.id === 'userNameTextColorText' || control.id === 'adminUsername' || control.id === 'adminPassword') return;
        if (control.closest('.vcp-uiux-input-wrap')) return;
        try {
            const release = api.mountInput(control, {}, scope);
            if (!release) return;
            control.dataset.vcpHarnessInputPrimitive = 'true';
            control.closest('.vcp-uiux-input-wrap')?.classList.add('vcp-harness-input-fill');
            scope.own(() => { delete control.dataset.vcpHarnessInputPrimitive; }, `harness-input-${control.id || control.name || uniqueSettingsKey()}`, 'ui-presentation');
        } catch (error) {
            console.warn('[VCPUI SettingsBridge] Could not mount Harness Input primitive:', error);
        }
    });
}

function mountHarnessDisclosures(form) {
    form.querySelectorAll('.agent-style-collapsible-container').forEach(container => {
        // disclosureStates stores state records, not raw containers.  Using
        // Set.has(container) here silently missed the existing record and
        // re-bound click/keydown listeners on every Settings refresh.
        if ([...disclosureStates].some(state => state.container === container)) return;
        const header = container.querySelector('.style-collapse-header');
        const content = container.querySelector('.agent-style-controls');
        if (!header || !content) return;
        if (!content.id) content.id = `${container.id || 'settings-disclosure'}-content`;
        header.classList.add('vcp-harness-disclosure-row');
        header.setAttribute('role', 'button');
        header.tabIndex = header.tabIndex >= 0 ? header.tabIndex : 0;
        header.setAttribute('aria-controls', content.id);
        const sync = () => header.setAttribute('aria-expanded', String(!container.classList.contains('collapsed')));
        const toggle = event => {
            if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            container.classList.toggle('collapsed');
            sync();
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', toggle);
        const observer = window.MutationObserver ? new window.MutationObserver(sync) : null;
        observer?.observe(container, { attributes: true, attributeFilter: ['class'] });
        sync();
        disclosureStates.add({ container, header, observer, cleanup: () => {
            observer?.disconnect();
            header.removeEventListener('click', toggle);
            header.removeEventListener('keydown', toggle);
            header.removeAttribute('aria-controls');
            header.removeAttribute('aria-expanded');
            header.removeAttribute('role');
            header.removeAttribute('tabindex');
            disclosureStates.delete([...disclosureStates].find(state => state.container === container));
        }});
    });
}

// R2-02C: these controls have a single draft/save owner. They continue to
// use the canonical business nodes and persisted keys, but no longer enter
// the legacy form-submit/autosave chain.
const TYPED_FIELD_DEFINITIONS = Object.freeze({
    userAvatarBorderColor: { path: 'userAvatarBorderColor', kind: 'string' },
    userAvatarBorderColorText: { path: 'userAvatarBorderColor', kind: 'string' },
    // Name color mirrors the avatar pair: two controls, one persisted key.
    userNameTextColor: { path: 'userNameTextColor', kind: 'string', fallback: '#ffffff' },
    userNameTextColorText: { path: 'userNameTextColor', kind: 'string', fallback: '#ffffff' },
    userName: { path: 'userName', kind: 'string', trimValue: true, fallback: '用户' },
    continueWritingPrompt: { path: 'continueWritingPrompt', kind: 'string', trimValue: true, fallback: '请继续' },
    showHomeVisualBrand: { path: 'showHomeVisualBrand', kind: 'boolean' },
    showHomeVisualTagline: { path: 'showHomeVisualTagline', kind: 'boolean' },
    homeVisualTagline: { path: 'homeVisualTagline', kind: 'string' },
    // Wide layout is one boolean behind a radio pair; the Normal radio owns
    // the inverted value so both half-states flow through the same draft.
    chatLayoutModeWide: { path: 'enableWideChatLayout', kind: 'boolean' },
    chatLayoutModeNormal: { path: 'enableWideChatLayout', kind: 'inverse-boolean' },
    // Chat typography presets/customs: selects and text inputs keep their
    // canonical nodes; visual application stays with the settings snapshot
    // consumers (chat renderer semantics untouched).
    chatFontPreset: { path: 'chatFontPreset', kind: 'string' },
    chatFontCustom: { path: 'chatFontCustom', kind: 'string' },
    chatCodeFontPreset: { path: 'chatCodeFontPreset', kind: 'string' },
    chatCodeFontCustom: { path: 'chatCodeFontCustom', kind: 'string' },
    chatDiaryFontPreset: { path: 'chatDiaryFontPreset', kind: 'string' },
    chatDiaryFontCustom: { path: 'chatDiaryFontCustom', kind: 'string' },
    chatToolFontPreset: { path: 'chatToolFontPreset', kind: 'string' },
    chatToolFontCustom: { path: 'chatToolFontCustom', kind: 'string' },
    appearanceDensity: { path: 'appearanceProfile.density', kind: 'string' },
    appearanceRadius: { path: 'appearanceProfile.radius', kind: 'string' },
    appearanceTypography: { path: 'appearanceProfile.typography', kind: 'string' },
    appearanceFontScale: { path: 'appearanceProfile.fontScale', kind: 'string' },
    appearanceContentWidth: { path: 'appearanceProfile.contentWidth', kind: 'string' },
    appearanceSurface: { path: 'appearanceProfile.surface', kind: 'string' },
    appearanceSidebarRowHeight: { path: 'appearanceProfile.sidebarRowHeight', kind: 'number' },
    appearanceSidebarAvatarSize: { path: 'appearanceProfile.sidebarAvatarSize', kind: 'number' },
    appearanceCustomRadius: { path: 'appearanceProfile.customRadius', kind: 'number' },
    'appearanceSidebarRadiusChoice-tuned': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'tuned' },
    'appearanceSidebarRadiusChoice-follow': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'follow' },
    'appearanceSidebarRadiusChoice-square': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'square' },
    'appearanceSidebarRadiusChoice-small': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'small' },
    'appearanceSidebarRadiusChoice-medium': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'medium' },
    'appearanceSidebarRadiusChoice-round': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'round' },
    'appearanceSidebarRadiusChoice-custom': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'custom' },
});

function readTypedFieldPatch(control, service, pendingPatch) {
    const definition = TYPED_FIELD_DEFINITIONS[control?.id];
    if (!definition) return null;
    const raw = control.type === 'checkbox' || control.type === 'radio' ? control.checked : control.value;
    let value = definition.kind === 'choice' ? definition.value : definition.kind === 'number' ? Number(raw) : definition.kind === 'inverse-boolean' ? Boolean(raw) !== true : definition.kind === 'boolean' ? Boolean(raw) : String(raw);
    // Keep the legacy whole-form collect contract for fields whose persisted
    // semantics depend on it (trim + default fill), so the save command line
    // cannot diverge from what the legacy chain used to persist.
    if (definition.trimValue && typeof value === 'string') value = value.trim();
    if (definition.fallback !== undefined && typeof value === 'string' && !value) value = definition.fallback;
    if (definition.path.startsWith('appearanceProfile.')) {
        // Build the full-profile snapshot on top of the accumulated draft, not
        // bare service state: every later event in one debounce window would
        // otherwise revert earlier drafts of sibling appearance fields.
        const current = {
            ...(service.state.get()?.appearanceProfile || {}),
            ...(pendingPatch?.appearanceProfile || {}),
        };
        const key = definition.path.slice('appearanceProfile.'.length);
        return { appearanceProfile: { ...current, [key]: value } };
    }
    return { [definition.path]: value };
}

function mountTypedFieldOwner(root, form) {
    if (!root || !form || form.dataset.vcpTypedFieldOwnerMounted === 'true') return;
    const service = typedSettingsRegistry?.get('settings-ui') || ensureTypedSettingsService();
    if (!service?.save?.execute) return;
    const controls = Object.keys(TYPED_FIELD_DEFINITIONS)
        .map(id => form.querySelector(`#${id}`))
        .filter(Boolean);
    if (!controls.length) return;
    const state = { root, form, timer: null, pendingPatch: null, inFlight: null, disposed: false, cleanups: [], run: null };
    // Dynamic path rows cannot be expressed as one control per definition id:
    // every row shares the networkNotesPaths key.  The container becomes the
    // owned unit and delegation covers rows added after mount.
    const pathsContainer = form.querySelector('#networkNotesPathsContainer');
    const collectNetworkNotesPaths = () => [...pathsContainer.querySelectorAll('input[name="networkNotesPath"]')]
        .map(input => input.value.trim())
        .filter(Boolean);
    const project = snapshot => {
        if (state.disposed || form.dataset.vcpSettingsDirty === 'true' || form.dataset.globalSettingsSaving === 'true') return;
        const settings = snapshot?.value || {};
        const appearance = settings.appearanceProfile || {};
        const set = (id, value) => { const node = form.querySelector(`#${id}`); if (node && value !== undefined && value !== null) { const next = String(value); if (node.value !== next) { node.value = next; const EventCtor = node.ownerDocument.defaultView?.CustomEvent ?? CustomEvent; node.dispatchEvent(new EventCtor('vcp-uiux-sync')); } } };
        const check = (id, value) => { const node = form.querySelector(`#${id}`); if (node) node.checked = Boolean(value); };
        set('userAvatarBorderColor', settings.userAvatarBorderColor || '#3d5a80');
        set('userAvatarBorderColorText', settings.userAvatarBorderColor || '#3d5a80');
        set('appearanceDensity', appearance.density || 'comfortable');
        set('appearanceRadius', appearance.radius || 'small');
        set('appearanceTypography', appearance.typography || 'system');
        set('appearanceFontScale', appearance.fontScale || 'normal');
        set('appearanceContentWidth', appearance.contentWidth || 'full');
        set('appearanceSurface', appearance.surface || 'translucent');
        set('appearanceSidebarRowHeight', appearance.sidebarRowHeight ?? 46);
        set('appearanceSidebarRowHeightValue', `${appearance.sidebarRowHeight ?? 46}px`);
        set('appearanceSidebarAvatarSize', appearance.sidebarAvatarSize ?? 32);
        set('appearanceSidebarAvatarSizeValue', `${appearance.sidebarAvatarSize ?? 32}px`);
        set('appearanceCustomRadius', appearance.customRadius ?? 10);
        set('appearanceCustomRadiusValue', `${appearance.customRadius ?? 10}px`);
        const radius = appearance.sidebarRadius || 'tuned';
        Object.keys(TYPED_FIELD_DEFINITIONS).filter(id => id.startsWith('appearanceSidebarRadiusChoice-'))
            .forEach(id => check(id, id === `appearanceSidebarRadiusChoice-${radius}`));
        check('chatLayoutModeWide', settings.enableWideChatLayout === true);
        check('chatLayoutModeNormal', settings.enableWideChatLayout !== true);
        check('showHomeVisualBrand', settings.showHomeVisualBrand !== false);
        check('showHomeVisualTagline', settings.showHomeVisualTagline !== false);
        set('homeVisualTagline', settings.homeVisualTagline || '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
        // Name cluster owns its snapshot reads now; the color mirror keeps
        // both controls on one persisted key like the avatar pair.  The
        // legacy userUseThemeColorsInChat key has no control inside the
        // Settings form (the visible useThemeColorsInChat checkbox belongs
        // to the per-agent form), so there is nothing to project for it.
        set('userName', settings.userName);
        set('userNameTextColor', settings.userNameTextColor || '#ffffff');
        set('userNameTextColorText', settings.userNameTextColor || '#ffffff');
        set('continueWritingPrompt', settings.continueWritingPrompt);
        // Chat typography owns its fallbacks here now that the generic
        // snapshot projection no longer writes these nodes.
        set('chatFontPreset', settings.chatFontPreset || 'system');
        set('chatFontCustom', settings.chatFontCustom || '');
        set('chatCodeFontPreset', settings.chatCodeFontPreset || 'consolas');
        set('chatCodeFontCustom', settings.chatCodeFontCustom || '');
        set('chatDiaryFontPreset', settings.chatDiaryFontPreset || 'serif');
        set('chatDiaryFontCustom', settings.chatDiaryFontCustom || '');
        set('chatToolFontPreset', settings.chatToolFontPreset || 'system');
        set('chatToolFontCustom', settings.chatToolFontCustom || '');
        [['chatFontPreset', 'chatFontCustomRow'], ['chatCodeFontPreset', 'chatCodeFontCustomRow'], ['chatDiaryFontPreset', 'chatDiaryFontCustomRow'], ['chatToolFontPreset', 'chatToolFontCustomRow']].forEach(([selectId, rowId]) => {
            const select = form.querySelector(`#${selectId}`);
            const row = form.querySelector(`#${rowId}`);
            if (select && row) row.style.display = select.value === 'custom' ? 'block' : 'none';
        });
        // Network notes rows: the typed field owner is their single writer;
        // the generic consumer projection no longer rebuilds them.
        if (pathsContainer) {
            const paths = Array.isArray(settings.networkNotesPaths)
                ? settings.networkNotesPaths.map(path => String(path || '')).filter(Boolean)
                : [];
            const current = collectNetworkNotesPaths();
            if (current.join('\u0000') !== paths.join('\u0000')) {
                pathsContainer.replaceChildren();
                const addPath = path => addTypedNetworkPathInput(root, path)
                    || window.uiHelperFunctions?.addNetworkPathInput?.(path);
                if (typeof addPath === 'function') {
                    (paths.length ? paths : ['']).forEach(path => addPath(path));
                    pathsContainer.querySelectorAll('input[name="networkNotesPath"]').forEach(input => { input.dataset.vcpTypedFieldOwner = 'true'; });
                }
            }
        }
    };
    const status = () => root.querySelector('.vcp-settings-autosave-status');
    const publish = (success, error = '') => {
        form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success, error: error || undefined, owner: 'typed-settings-field-owner' } }));
    };
    const run = async () => {
        state.timer = null;
        if (state.disposed || !state.pendingPatch || state.inFlight) return;
        const patch = state.pendingPatch;
        state.pendingPatch = null;
        state.inFlight = service.save.execute(patch);
        status()?.setAttribute('data-state', 'saving');
        if (status()) status().textContent = '保存中…';
        try {
            const result = await state.inFlight;
            if (state.disposed) return;
            if (!result?.success) {
                form.dataset.vcpSettingsDirty = 'true';
                status()?.setAttribute('data-state', 'error');
                if (status()) status().textContent = '保存失败 · 重试';
                publish(false, result?.error || '设置保存失败');
                return;
            }
            if (!state.pendingPatch) delete form.dataset.vcpSettingsDirty;
            status()?.setAttribute('data-state', 'saved');
            if (status()) status().textContent = '已保存';
            publish(true);
            if (state.pendingPatch) schedule();
        } catch (error) {
            if (!state.disposed) {
                form.dataset.vcpSettingsDirty = 'true';
                status()?.setAttribute('data-state', 'error');
                if (status()) status().textContent = '保存失败 · 重试';
                publish(false, error?.message || String(error));
            }
        } finally {
            state.inFlight = null;
        }
    };
    const schedule = () => {
        if (state.disposed) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(run, 400);
    };
    state.run = run;
    const markDirty = () => {
        form.dataset.vcpSettingsDirty = 'true';
        status()?.setAttribute('data-state', 'dirty');
        if (status()) status().textContent = '未保存';
    };
    const onInput = event => {
        const control = event.target;
        if (!TYPED_FIELD_DEFINITIONS[control?.id]) return;
        const patch = readTypedFieldPatch(control, service, state.pendingPatch) || {};
        if (patch.appearanceProfile) {
            state.pendingPatch = {
                ...(state.pendingPatch || {}),
                appearanceProfile: {
                    ...(state.pendingPatch?.appearanceProfile || service.state.get()?.appearanceProfile || {}),
                    ...patch.appearanceProfile,
                },
            };
        } else {
            state.pendingPatch = { ...(state.pendingPatch || {}), ...patch };
        }
        markDirty();
        schedule();
    };
    controls.forEach(control => {
        control.dataset.vcpTypedFieldOwner = 'true';
        control.addEventListener('input', onInput);
        control.addEventListener('change', onInput);
        state.cleanups.push(() => {
            control.removeEventListener('input', onInput);
            control.removeEventListener('change', onInput);
            delete control.dataset.vcpTypedFieldOwner;
        });
    });
    if (pathsContainer) {
        const onRowsDirty = () => {
            // Row removal, row addition and typing all reduce to "recollect
            // the current list"; empty rows drop out like the legacy save.
            state.pendingPatch = { ...(state.pendingPatch || {}), networkNotesPaths: collectNetworkNotesPaths() };
            markDirty();
            schedule();
        };
        pathsContainer.addEventListener('input', onRowsDirty);
        pathsContainer.addEventListener('change', onRowsDirty);
        pathsContainer.querySelectorAll('input[name="networkNotesPath"]').forEach(input => { input.dataset.vcpTypedFieldOwner = 'true'; });
        state.cleanups.push(() => {
            pathsContainer.removeEventListener('input', onRowsDirty);
            pathsContainer.removeEventListener('change', onRowsDirty);
            pathsContainer.querySelectorAll('input[name="networkNotesPath"]').forEach(input => { delete input.dataset.vcpTypedFieldOwner; });
        });
    }
    const release = service.state.subscribe((_value, snapshot) => project(snapshot));
    state.cleanups.push(() => release?.());
    state.cleanups.push(() => {
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        state.pendingPatch = null;
        state.disposed = true;
        service.cancelPendingSaves?.();
        delete form.dataset.vcpTypedFieldOwnerMounted;
    });
    form.dataset.vcpTypedFieldOwnerMounted = 'true';
    typedFieldStates.add(state);
    ensurePresentationScope()?.own(() => {
        state.cleanups.forEach(cleanup => cleanup());
        typedFieldStates.delete(state);
    }, 'typed-settings-field-owner', 'ui-presentation');
}

function flushSettingsAutosave() {
    flushLegacyAutosave();
    typedFieldStates.forEach(state => {
        if (state.disposed || !state.pendingPatch || state.inFlight) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        // The field owner intentionally starts its own command and does not
        // route through form.requestSubmit(), which would re-enter legacy
        // presentation and close the modal.
        void state.run?.();
    });
    typedForumFieldStates.forEach(state => {
        if (state.disposed || !state.pending || state.inFlight) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        void state.run?.();
    });
}

function flushTypedForumFields() {
    typedForumFieldStates.forEach(state => {
        if (state.disposed || !state.pending || state.inFlight) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        void state.run?.();
    });
}

function teardownSettingsAutosave() {
    teardownLegacyAutosave();
    [...typedFieldStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        typedFieldStates.delete(state);
    });
    [...typedForumFieldStates].forEach(state => {
        state.disposed = true;
        if (state.timer) clearTimeout(state.timer);
        typedForumFieldStates.delete(state);
    });
}

function teardownHarnessDisclosures() {
    [...disclosureStates].forEach(state => state.cleanup());
}

// Replaces the handful of hand-inlined Lucide paths inside the global form
// with VCPUI icon nodes (rendered by lucide-adapter). Originals are kept for
// deterministic teardown and business-DOM restoration.
function normalizeFormIcons(root) {
    if (root.dataset.vcpSettingsIconsNormalized) return;
    const replaced = [];
    const replaceIcon = (container, lucideName) => {
        const svg = container?.querySelector('svg');
        if (!svg) return;
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = lucideName;
        svg.replaceWith(icon);
        // lucide-adapter replaces this temporary span with an SVG. Retaining
        // the span in the restoration record keeps an already-detached node
        // alive for the whole surface lifetime and, across repeated round-trips,
        // makes Chromium report a linear detached-node chain.
        // Restoration only needs the container and upstream SVG.
        replaced.push({ container, original: svg });
    };
    replaceIcon(root.querySelector('#resetUserAvatarColorsBtn'), 'refresh');
    replaceIcon(root.querySelector('.avatar-upload-overlay'), 'camera');
    replaceIcon(root.querySelector('#openTopicSummaryModelSelectBtn'), 'chevron-down');
    replaced.forEach(record => iconReplacements.add(record));
    if (replaced.length) root.dataset.vcpSettingsIconsNormalized = 'true';
}

function restoreFormIcons(root) {
    iconReplacements.forEach(({ container, original }) => {
        const current = container.querySelector('svg[data-vcp-icon], span.vcp-ui-icon');
        if (current) current.replaceWith(original);
        else if (!original.isConnected) container.prepend(original);
    });
    iconReplacements.clear();
    delete root.dataset.vcpSettingsIconsNormalized;
}

// SettingsShell build: assemble a live Harness SettingsRoot primitive tree.
// The original form sections remain the business source of truth; only the
// shell chrome (nav/header/options) is reconstructed here.
function mountSettingsShell(root) {
    if (root.querySelector('.vcp-harness-settings-panel')) return;
    mountTypedSettingsConsumer(root);
    const panel = root.querySelector('.vcp-settings-source-panel');
    const layout = root.querySelector('.vcp-settings-source-layout');
    const nav = root.querySelector('.vcp-settings-source-nav');
    const listHost = nav?.querySelector('.vcp-settings-source-list');
    const content = root.querySelector('.vcp-settings-source-content');
    const form = root.querySelector('#globalSettingsForm');
    const title = root.querySelector('.vcp-settings-source-title');
    const close = root.querySelector('.close-button');
    if (!panel || !layout || !nav || !content || !form || !title || !close) {
        return;
    }

    let meta = [];
    try {
        const sourceMeta = JSON.parse(nav.dataset.settingsSections || '[]');
        meta = sourceMeta.map(item => ({ ...item, icon: GLOBAL_CATEGORY_ICONS[item.value] || 'circle', selected: item.value === 'user-identity' }));
    } catch (error) {
        console.error('[VCPUI SettingsBridge] Invalid settings section metadata', error);
        return;
    }
    if (!meta.length) return;
    const initial = meta.find(item => item.selected)?.value || meta[0]?.value;
    if (!initial || !document.getElementById(`section-${initial}`)) {
        return;
    }


    const state = {
        panel,
        layout,
        nav,
        content,
        form,
        close,
        listHost: null,
        originalNavHost: listHost || null,
        title,
        header: null,
        options: null,
        sectionHost: null,
        sectionBank: null,
        sections: new Map(),
        navList: null,
        cleanups: [],
        meta,
        active: initial,
        query: '',
    };
    shellState.set(root, state);
    shellRoots.add(root);
    root.classList.add('vcp-harness-settings-root', 'vcp-global-settings-surface');
    panel.classList.add('vcp-harness-settings-panel');
    nav.classList.add('vcp-harness-settings-nav');
    content.classList.add('vcp-harness-settings-content');
    // Legacy presentation selectors must not participate in the live tree.
    // The classes are restored only when the bridge is torn down.
    nav.classList.remove('vcp-settings-source-nav');
    content.classList.remove('vcp-settings-source-content');
    panel.classList.remove('vcp-settings-source-panel');
    title.classList.remove('vcp-settings-source-title');

    // Harness owns the settings title in the nav rail, not as a second
    // content heading. Move the canonical node and restore its exact parent
    // and sibling on teardown.
    nav.prepend(title);
    title.classList.add('vcp-harness-settings-nav-title');
    title.id ||= 'vcpSettingsNavTitle';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', title.id);
    nav.setAttribute('aria-label', '全局设置');

    // Compose the Harness header/options primitives around the existing form;
    // the form remains the business owner, while the new nodes own chrome.
    const header = document.createElement('header');
    header.className = 'vcp-harness-settings-header';
    header.setAttribute('data-setting-primitive', 'header');
    const actions = document.createElement('div');
    actions.className = 'vcp-harness-settings-actions';
    const options = document.createElement('div');
    options.className = 'vcp-harness-settings-options';
    options.setAttribute('data-setting-primitive', 'options');
    state.header = header;
    state.options = options;
    options.append(...[...content.childNodes]);
    // Harness owns an icon-only 28px close primitive with an accessible text
    // seat. Replace the legacy text glyph once, while preserving the same
    // business button and close listener.
    if (!close.dataset.vcpHarnessClose) {
        const icon = document.createElement('span');
        icon.className = 'vcp-ui-icon vcp-harness-settings-close-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'x';
        const hiddenLabel = document.createElement('span');
        hiddenLabel.className = 'vcp-harness-settings-close-label';
        hiddenLabel.textContent = close.getAttribute('aria-label') || '关闭';
        close.replaceChildren(icon, hiddenLabel);
        close.classList.add('vcp-harness-settings-close');
        close.dataset.vcpHarnessClose = 'true';
    }
    actions.append(close);
    header.append(actions);
    content.replaceChildren(header, options);

    // Harness renders only the selected section into Options. Keep the
    // remaining business fields connected to the same form in a hidden bank
    // so legacy id/name queries, form serialization and IPC handlers remain
    // authoritative without leaving inactive settings in the visible tree.
    const sectionHost = document.createElement('div');
    sectionHost.className = 'vcp-harness-active-section';
    sectionHost.dataset.settingPrimitive = 'section';
    const sectionBank = document.createElement('div');
    sectionBank.className = 'vcp-harness-section-bank';
    sectionBank.hidden = true;
    sectionBank.setAttribute('aria-hidden', 'true');
    state.sectionHost = sectionHost;
    state.sectionBank = sectionBank;
    [...form.children].filter(child => child.matches('.settings-section')).forEach(section => {
        const value = section.id.replace(/^section-/, '');
        state.sections.set(value, section);
        section.classList.remove('active');
        sectionBank.append(section);
    });
    form.prepend(sectionHost, sectionBank);
    const initialSection = state.sections.get(initial);
    if (initialSection) {
        sectionHost.append(initialSection);
        initialSection.classList.add('active');
    }
    const canonicalNav = document.createElement('div');
    canonicalNav.className = 'vcp-harness-settings-nav-list';
    canonicalNav.setAttribute('aria-label', '全局设置分类');
    state.navList = canonicalNav;
    state.listHost = canonicalNav;
    listHost?.replaceWith(canonicalNav);
    nav.replaceChildren(title, canonicalNav);
    // The legacy grid wrapper no longer owns live layout.  Keep it detached so
    // business nodes can be restored atomically by teardown.
    panel.replaceChildren(nav, content);

    const rows = state.meta.map(item => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'vcp-harness-settings-nav-cell';
        row.dataset.section = item.value;
        row.dataset.vcpCanonicalNav = 'true';
        row.id = `vcpSettingsTab-${item.value}`;
        const icon = document.createElement('span');
        icon.className = 'vcp-harness-settings-nav-icon vcp-ui-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = item.icon;
        const copy = document.createElement('span');
        copy.className = 'vcp-harness-settings-nav-copy';
        const label = document.createElement('strong');
        label.textContent = item.label;
        copy.append(label);
        row.append(icon, copy);
        row.addEventListener('click', () => activateSection(item.value));
        row.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const current = rows.indexOf(row);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
            rows[next]?.focus();
            if (rows[next]) activateSection(rows[next].dataset.section);
        });
        state.listHost.append(row);
        return row;
    });
    const renderList = () => {
        state.listHost.setAttribute('aria-label', '全局设置分类');
        rows.forEach(row => {
            const value = row.dataset.section;
            const item = state.meta.find(candidate => candidate.value === value);
            if (!item) return;
            const selected = item.value === state.active;
            row.classList.toggle('is-active', selected);
            row.classList.toggle('active', selected);
            row.dataset.state = selected ? 'selected' : 'idle';
            row.tabIndex = selected ? 0 : -1;
        });
        state.meta.forEach(item => {
            const section = state.sections.get(item.value) || root.querySelector(`#section-${item.value}`);
            if (!section) return;
            // The active section is derived from the same state as the nav.
            // Re-assert it on every render so stale classes from a reused
            // modal or a bootstrap refresh cannot leave the two columns out
            // of sync.
            section.classList.toggle('active', item.value === state.active);
            section.removeAttribute('role');
            section.removeAttribute('aria-labelledby');
            section.removeAttribute('aria-hidden');
        });
    };

    const activateSection = (value) => {
        if (!state.meta.some(item => item.value === value)) return;
        state.active = value;
        const next = state.sections.get(value);
        if (next && state.sectionHost && next.parentNode !== state.sectionHost) {
            const current = state.sectionHost.querySelector('.settings-section');
            if (current) state.sectionBank.append(current);
            state.sectionHost.append(next);
        }
        renderList();
    };

    renderList();
}

function cleanupDisconnectedControllers() {
    [...controllers].forEach(controller => {
        if (controller.element.isConnected) return;
        const release = controllerReleases.get(controller);
        if (release) void release();
        else controller.destroy();
        controllerReleases.delete(controller);
        controllers.delete(controller);
    });
    for (const [trigger, release] of agentModelPickerReleases) {
        if (trigger.isConnected) continue;
        void release().catch(error => {
            console.error('[VCPUI SettingsBridge] Failed to release disconnected Agent model picker:', error);
        });
    }
}

function refresh() {
    refreshQueued = false;
    if (destroyed) return;
    ensurePresentationScope();
    cleanupDisconnectedControllers();
    const globalSettingsModal = syncGlobalSettingsHost();
    if (shouldEnhanceSidebarSettings()) {
        document.querySelectorAll('#agentSettingsForm, #groupSettingsForm').forEach(enhanceForm);
    }
    if (hasGlobalSettingsSurface()) {
        const form = globalSettingsModal?.querySelector('#globalSettingsForm');
        if (globalSettingsModal && form) enhanceGlobalSettings(globalSettingsModal, form);
    }
}

function scheduleRefresh() {
    if (destroyed || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(refresh);
}

function teardown() {
    const scope = presentationScope;
    presentationScope = null;
    // Retract enhanced controller identity synchronously before a rapid
    // A rapid surface round-trip can schedule another refresh.  The Scope
    // disposal below still owns error isolation and all non-controller
    // resources, but must not leave stale VCPUI proxies visible to the next
    // presentation generation.
    [...controllers].reverse().forEach(controller => {
        const release = controllerReleases.get(controller);
        if (release) {
            void release().catch(error => {
                console.error('[VCPUI SettingsBridge] Failed to release controller:', error);
            });
        } else controller.destroy();
    });
    if (scope) {
        void scope.dispose('settings-presentation-teardown').catch(error => {
            console.error('[VCPUI SettingsBridge] Failed to dispose presentation:', error);
        });
    }
    controllers.clear();
    controllerReleases.clear();
    for (const release of agentModelPickerReleases.values()) void release();
    agentModelPickerReleases.clear();
    teardownSettingsAutosave();
    teardownHarnessDisclosures();
    selectProjection.teardown();
    [...shellRoots].forEach(root => {
        const state = shellState.get(root);
        if (!state) return;
        state.cleanups?.forEach(cleanup => cleanup());
        state.cleanups = [];
        // The unified Surface is canonical for the renderer lifetime. Teardown
        // releases listeners/controllers but does not resurrect retired DOM.
        shellState.delete(root);
    });
    shellRoots.clear();
    document.querySelectorAll('#globalSettingsModal[data-vcp-settings-icons-normalized]').forEach(restoreFormIcons);
    document.getElementById('globalSettingsModal')?.classList.remove('vcp-global-settings-surface');
    document.documentElement.classList.remove('vcp-global-settings-host');
}

const handleModalVisibility = event => {
    if (event.detail?.modalId === 'globalSettingsModal') {
        if (event.detail?.active === false) flushSettingsAutosave();
        scheduleRefresh();
    }
};
const handleSurfaceUpdated = () => scheduleRefresh();
if (bridgeScope) bridgeScope.listen(document, 'modal-visibility-changed', handleModalVisibility, undefined, 'settings-modal-visibility');
else document.addEventListener('modal-visibility-changed', handleModalVisibility);
if (bridgeScope) {
    bridgeScope.listen(document, 'modal-ready', handleModalVisibility, undefined, 'settings-modal-ready');
    bridgeScope.listen(document, 'vcp-settings-surface-updated', handleSurfaceUpdated, undefined, 'settings-surface-updated');
} else {
    document.addEventListener('modal-ready', handleModalVisibility);
    document.addEventListener('vcp-settings-surface-updated', handleSurfaceUpdated);
}
scheduleRefresh();

window.VCPUISettingsBridge = Object.freeze({
    refresh: scheduleRefresh,
    flush: flushSettingsAutosave,
    flushForum: flushTypedForumFields,
    addNetworkPathInput(path = '') {
        if (destroyed) return false;
        const root = document.getElementById('globalSettingsModal');
        return addTypedNetworkPathInput(root, path)
            || window.uiHelperFunctions?.addNetworkPathInput?.(path)
            || false;
    },
    getTypedService() {
        return ensureTypedSettingsService();
    },
    getRustAssistantService() {
        ensureTypedSettingsService();
        return ensureRustAssistantUiService();
    },
    getForumConfigService() {
        ensureTypedSettingsService();
        return ensureForumConfigUiService();
    },
    getAssistantRuntimeService() {
        ensureTypedSettingsService();
        return ensureAssistantRuntimeUiService();
    },
    destroy() {
        if (destroyPromise) return destroyPromise;
        destroyed = true;
        typedSettingsDisposed = true;
        if (!bridgeScope) {
            typedSettingsService?.dispose?.();
            typedSettingsExternalRelease?.();
            document.removeEventListener('modal-visibility-changed', handleModalVisibility);
            document.removeEventListener('modal-ready', handleModalVisibility);
            document.removeEventListener('vcp-settings-surface-updated', handleSurfaceUpdated);
        }
        teardown();
        destroyPromise = bridgeScope?.dispose('settings-bridge-destroyed') || Promise.resolve();
        return destroyPromise;
    },
    get enhancedCount() {
        return controllers.size;
    }
});
