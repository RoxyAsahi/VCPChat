// settings-bridge — unified VCPUI enhancement bridge for settings surfaces.
//
// The sidebar settings forms (agent/group) and the global settings modal keep
// their original business DOM, form ids, defaults and IPC; this module only
// layers the VCPUI presentation on top of the canonical main-window shell.
//
// Global settings: the modal is rebuilt into one Harness SettingsRoot-style
// layout — native nav cells in the left rail, a header/options content column,
// the original form as the business source, and autosave status in the header.

const controllers = new Set();
const controllerReleases = new Map();
// Per-modal shell state is keyed by modal root so teardown can restore the
// exact original business nodes/classes after the canonical tree is removed.
// WeakMap cannot be iterated, so built roots are tracked separately.
const shellState = new WeakMap();
const shellRoots = new Set();
// Long enumerations use a scoped Harness-style presentation layer while the
// native select remains the sole form/business node.
const customSelectStates = new Set();
const customChoiceStates = new Set();
const autosaveStates = new Set();
const typedFieldStates = new Set();
const typedForumFieldStates = new Set();
const disclosureStates = new Set();
const selectObserverStates = new Map();
let harnessSelectOwnerMounted = false;
let harnessSelectOpenCount = 0;
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
    const inputGroup = document.createElement('div');
    inputGroup.className = 'network-path-input-group vcp-settings-row';
    inputGroup.dataset.vcpSettingsRow = 'true';
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'networkNotesPath';
    input.placeholder = '例如 \\NAS\\Shared\\Notes';
    input.value = path;
    const inputWrap = document.createElement('span');
    inputWrap.className = 'vcp-harness-input-wrap';
    inputWrap.dataset.settingPrimitive = 'input-wrap';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '删除';
    removeBtn.className = 'sidebar-button small-button danger-button';
    removeBtn.addEventListener('click', () => inputGroup.remove(), { once: true });
    inputWrap.appendChild(input);
    inputGroup.append(inputWrap, removeBtn);
    container.appendChild(inputGroup);
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
            ['userName', 'userName'],
            ['userNameTextColor', 'userNameTextColor'],
            ['userNameTextColorText', 'userNameTextColor'],
            ['userUseThemeColorsInChat', 'userUseThemeColorsInChat', 'checked'],
            ['continueWritingPrompt', 'continueWritingPrompt'],
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
            ['chatLayoutModeWide', 'enableWideChatLayout', 'checked'],
            ['chatLayoutModeNormal', 'enableWideChatLayout', 'checked-inverse'],
            ['enableUserChatBubbleUi', 'enableUserChatBubbleUi', 'checked'],
            ['showUserMetaInChatBubbleUi', 'showUserMetaInChatBubbleUi', 'checked'],
            ['chatBubbleMaxWidthWideDefault', 'chatBubbleMaxWidthWideDefault'],
            ['chatBubbleMaxWidthWideNotifications', 'chatBubbleMaxWidthWideNotifications'],
            ['chatBubbleMaxWidthWideNarrow', 'chatBubbleMaxWidthWideNarrow'],
            ['minChunkBufferSize', 'minChunkBufferSize'],
            ['smoothStreamIntervalMs', 'smoothStreamIntervalMs'],
            ['chatFontPreset', 'chatFontPreset'],
            ['chatFontCustom', 'chatFontCustom'],
            ['chatCodeFontPreset', 'chatCodeFontPreset'],
            ['chatCodeFontCustom', 'chatCodeFontCustom'],
            ['chatDiaryFontPreset', 'chatDiaryFontPreset'],
            ['chatDiaryFontCustom', 'chatDiaryFontCustom'],
            ['chatToolFontPreset', 'chatToolFontPreset'],
            ['chatToolFontCustom', 'chatToolFontCustom'],
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
        const paths = Array.isArray(settings.networkNotesPaths)
            ? settings.networkNotesPaths.map(path => String(path || '')).filter(Boolean)
            : [];
        const pathsContainer = form.querySelector('#networkNotesPathsContainer');
        if (pathsContainer) {
            const current = [...pathsContainer.querySelectorAll('input[name="networkNotesPath"]')].map(input => input.value);
            if (current.join('\u0000') !== paths.join('\u0000')) {
                pathsContainer.replaceChildren();
                const addPath = path => addTypedNetworkPathInput(root, path)
                    || window.uiHelperFunctions?.addNetworkPathInput?.(path);
                if (typeof addPath === 'function') {
                    (paths.length ? paths : ['']).forEach(path => addPath(path));
                }
            }
        }
    };
    const release = service.state.subscribe(apply);
    ensurePresentationScope()?.own(() => {
        release?.();
        delete root.dataset.vcpSettingsRevision;
        delete root.dataset.vcpSettingsSource;
    }, 'typed-settings-consumer', 'ui-presentation');
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
        ensurePresentationScope()?.own(release, 'typed-rust-assistant-consumer', 'ui-presentation');
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
        ensurePresentationScope()?.own(release, 'typed-forum-config-consumer', 'ui-presentation');
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
        ensurePresentationScope()?.own(release, 'typed-assistant-runtime-consumer', 'ui-presentation');
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

function mountHarnessSelectOwner() {
    if (harnessSelectOwnerMounted) return;
    const onPointerDown = event => customSelectStates.forEach(state => {
        if (state.open && !state.wrap.contains(event.target) && !state.popover.contains(event.target)) state.close?.();
    });
    const onEscape = event => {
        if (event.key !== 'Escape') return;
        customSelectStates.forEach(state => { if (state.open) { event.preventDefault(); state.close?.(); } });
    };
    const onReposition = () => customSelectStates.forEach(state => { if (state.open) state.position?.(); });
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onEscape, true);
    window.addEventListener('resize', onReposition);
    document.addEventListener('scroll', onReposition, true);
    window.__vcpHarnessSelectOwnerCleanup = () => {
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('keydown', onEscape, true);
        window.removeEventListener('resize', onReposition);
        document.removeEventListener('scroll', onReposition, true);
        harnessSelectOwnerMounted = false;
        delete window.__vcpHarnessSelectOwnerCleanup;
    };
    harnessSelectOwnerMounted = true;
}

function releaseHarnessSelectOwner() {
    if (harnessSelectOpenCount === 0) window.__vcpHarnessSelectOwnerCleanup?.();
}

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
    form.querySelectorAll('.agent-settings-section, .group-settings-section').forEach(section => {
        enhance('SettingsSection', section);
    });
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    form.querySelectorAll('select').forEach(select => enhance('Select', select, { kernel: 'native' }));
    form.querySelectorAll('input[type="range"]').forEach(range => enhance('Range', range));
    form.querySelectorAll('label.switch').forEach(control => enhance('Switch', control));
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
    mountHarnessInputWrappers(form);
    form.querySelectorAll('input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"])').forEach(input => {
        enhance('Input', input);
    });
    form.querySelectorAll('textarea').forEach(textarea => enhance('Textarea', textarea));
    // Short enumerations remain native/segmented controls. Long enumerations
    // get a Harness-style popover, but the native select is retained as the
    // one authoritative business node.
    mountHarnessSelects(form);
    mountTypedAppearanceSelects(root, form);
    mountTypedHomeTaglineInput(root, form);
    mountTypedRadiusChoice(root, form);
    mountTypedAppearanceRanges(root, form);
    mountTypedHomeVisualToggles(root, form);
    mountTypedAvatarColorPair(root, form);
    mountTypedForumInputs(root, form);
    mountTypedForumFieldOwner(root, form);
    form.querySelectorAll('input[type="range"]').forEach(range => { if (!['appearanceSidebarAvatarSize', 'appearanceSidebarRowHeight', 'appearanceCustomRadius'].includes(range.id)) enhance('Range', range); });
    form.querySelectorAll('label.switch').forEach(control => { if (!control.querySelector('#showHomeVisualBrand, #showHomeVisualTagline')) enhance('Switch', control); });
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
    const color = form?.querySelector?.('#userAvatarBorderColor');
    const text = form?.querySelector?.('#userAvatarBorderColorText');
    const api = window.VCPUIUX; if (!color || !text || !api?.mountColorPair) return;
    const scope = ensurePresentationScope(); if (!scope || color.dataset.vcpTypedPrimitiveMounted === 'true') return;
    const release = api.mountColorPair(color, text, scope);
    color.dataset.vcpTypedPrimitiveMounted = 'true';
    scope.own(() => { delete color.dataset.vcpTypedPrimitiveMounted; }, 'typed-avatar-color-marker', 'ui-primitive');
    if (release) scope.own(release, 'typed-avatar-color-pair', 'ui-primitive');
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
    const state = { form, timer: null, pending: false, inFlight: null, disposed: false };
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
                form.dataset.vcpSettingsDirty = 'true';
                status()?.setAttribute('data-state', 'error');
                if (status()) status().textContent = '保存失败 · 重试';
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: false, error: result?.error || '论坛配置保存失败', owner: 'typed-forum-field-owner' } }));
            } else {
                if (!state.pending) delete form.dataset.vcpSettingsDirty;
                status()?.setAttribute('data-state', 'saved');
                if (status()) status().textContent = '已保存';
                form.dispatchEvent(new CustomEvent('vcp-settings-save-result', { detail: { success: true, owner: 'typed-forum-field-owner' } }));
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
    controls.forEach(control => control.addEventListener('input', onInput));
    controls.forEach(control => control.addEventListener('change', onInput));
    controls.forEach(control => { control.dataset.vcpTypedForumFieldOwner = 'true'; });
    form.dataset.vcpTypedForumFieldOwnerMounted = 'true';
    typedForumFieldStates.add(state);
    ensurePresentationScope()?.own(() => {
        state.disposed = true;
        if (state.timer) clearTimeout(state.timer);
        controls.forEach(control => { control.removeEventListener('input', onInput); control.removeEventListener('change', onInput); delete control.dataset.vcpTypedForumFieldOwner; });
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
        const release = api.mountSelect(select, { label }, scope);
        select.dataset.vcpTypedPrimitiveMounted = 'true';
        scope.own(() => { delete select.dataset.vcpTypedPrimitiveMounted; }, `typed-${id}-marker`, 'ui-primitive');
        if (release) scope.own(release, `typed-${id}-select`, 'ui-primitive');
    });
}

function mountHarnessInputWrappers(form) {
    const selector = 'input:is(:not([type]), [type="text"], [type="url"], [type="password"], [type="number"], [type="email"], [type="search"], [type="tel"]), textarea';
    form.querySelectorAll(selector).forEach(control => {
        if (control.id === 'homeVisualTagline' || control.id === 'userAvatarBorderColorText' || control.id === 'adminUsername' || control.id === 'adminPassword') return;
        if (control.closest('.vcp-harness-input-wrap')) return;
        const wrap = document.createElement('span');
        wrap.className = 'vcp-harness-input-wrap';
        wrap.dataset.settingPrimitive = 'input-wrap';
        control.parentNode.insertBefore(wrap, control);
        wrap.append(control);
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

function removeLegacySubsectionHeadings(form) {
    form.querySelectorAll('.vcp-harness-editor-section-heading').forEach(heading => {
        const section = heading.closest('.settings-section');
        // The section h3 is the single canonical heading.  Subsection cards
        // must not introduce a second title/description stack.
        if (section?.querySelector(':scope > .settings-section-title')) heading.remove();
    });
}

/**
 * Establish one presentation owner for every persisted settings row. The
 * source row is replaced by a same-tag canonical row, so no legacy wrapper
 * remains in the live presentation tree. Business controls and their ids,
 * names, labels and child listeners are moved intact into the replacement.
 * This is intentionally idempotent because fields can be injected asynchronously.
 */
function mountCanonicalSettingsRows(form) {
    if (!form) return;
    const candidates = form.querySelectorAll(
        ':scope [data-vcp-settings-row], :scope [data-vcp-settings-control-row], :scope .vcp-settings-row, :scope .vcp-settings-control-row, :scope .settings-form-group, :scope .form-group-inline, :scope > .form-group, :scope .form-group'
    );
    candidates.forEach(row => {
        if (!(row instanceof HTMLElement) || row.closest('.vcp-harness-general-item')) return;
        if (!row.querySelector('input, select, textarea, button, [role="switch"]')) return;
        const keyNode = row.querySelector('[name], [id]');
        const key = keyNode?.getAttribute('name') || keyNode?.id || '';
        const item = document.createElement(row.tagName.toLowerCase());
        const preservedClasses = [...row.classList].filter(className => ![
            'settings-form-group', 'form-group-inline', 'vcp-settings-row', 'vcp-settings-control-row',
            'form-group'
        ].includes(className));
        item.className = ['vcp-harness-general-item', 'vcp-harness-general-row', ...preservedClasses].join(' ');
        for (const attribute of row.attributes) {
            if (attribute.name === 'class' || attribute.name === 'style') continue;
            item.setAttribute(attribute.name, attribute.value);
        }
        item.dataset.settingPrimitive = 'general-item';
        const appearanceOwner = row.closest('.appearance-settings-section, .appearance-sidebar-geometry-section, .appearance-home-tagline-setting');
        if (appearanceOwner) {
            item.dataset.settingPrimitive = 'appearance-row';
            item.classList.add('vcp-harness-appearance-row');
        }
        if (key) item.dataset.settingKey = key;
        item.dataset.canonicalRow = 'true';
        row.replaceWith(item);
        item.append(...[...row.childNodes]);
        row.remove();
        composeCanonicalRowSlots(item);
    });
    form.dataset.vcpCanonicalRowsMounted = 'true';
}

function composeCanonicalRowSlots(row) {
    if (!row || row.matches('label, fieldset') || row.querySelector(':scope > .vcp-harness-row-copy')) return;
    const children = [...row.children];
    const controls = children.filter(node => node.matches('input, select, textarea, button, .switch, .model-input-container, .vcp-harness-select-wrap, .vcp-harness-choice-wrap'));
    const titles = children.filter(node => node.matches('label, span, strong, h4, h5'));
    const helpers = children.filter(node => node.matches('small, p'));
    if (!controls.length || !titles.length) return;
    const copy = document.createElement('div');
    copy.className = 'vcp-harness-row-copy';
    copy.dataset.settingPrimitive = 'row-copy';
    [...titles, ...helpers].forEach(node => copy.append(node));
    const remaining = children.filter(node => !copy.contains(node) && !controls.includes(node));
    row.replaceChildren(copy, ...remaining, ...controls);
}

function mountSettingsAutosave(root, form) {
    if (form.dataset.vcpAutosaveMounted === 'true') return;
    const statusHost = root.querySelector('.vcp-harness-settings-actions');
    if (!statusHost) return;
    const state = { form, timer: null, saving: false, pending: false, cleanups: [] };
    const status = document.createElement('button');
    status.type = 'button';
    status.className = 'vcp-settings-autosave-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = '自动保存';
    statusHost.append(status);
    const setStatus = (value, mode = '') => {
        status.textContent = value;
        status.dataset.state = mode;
    };
    const submit = () => {
        state.timer = null;
        if (!state.pending || state.saving) return;
        state.pending = false;
        state.saving = true;
        setStatus('保存中…', 'saving');
        form.requestSubmit();
    };
    const schedule = () => {
        if (state.saving) { state.pending = true; return; }
        state.pending = true;
        form.dataset.vcpSettingsDirty = 'true';
        setStatus('未保存', 'dirty');
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(submit, 400);
    };
    const onInput = event => {
        if (!event.target?.matches?.('input, select, textarea')) return;
        if (event.target.dataset.vcpTypedFieldOwner === 'true') return;
        schedule();
    };
    const onResult = event => {
        if (event.detail?.owner === 'typed-settings-field-owner') return;
        state.saving = false;
        if (event.detail?.success) {
            delete form.dataset.vcpSettingsDirty;
            setStatus('已保存', 'saved');
            if (state.pending) schedule();
        } else setStatus('保存失败 · 重试', 'error');
    };
    const onStatusClick = () => { if (status.dataset.state === 'error') schedule(); };
    form.addEventListener('input', onInput);
    form.addEventListener('change', onInput);
    form.addEventListener('vcp-settings-save-result', onResult);
    status.addEventListener('click', onStatusClick);
    state.cleanups.push(() => {
        if (state.timer) clearTimeout(state.timer);
        form.removeEventListener('input', onInput);
        form.removeEventListener('change', onInput);
        form.removeEventListener('vcp-settings-save-result', onResult);
        status.removeEventListener('click', onStatusClick);
        status.remove();
        delete form.dataset.vcpAutosaveMounted;
    });
    form.dataset.vcpAutosaveMounted = 'true';
    autosaveStates.add(state);
}

// R2-02C: these controls have a single draft/save owner. They continue to
// use the canonical business nodes and persisted keys, but no longer enter
// the legacy form-submit/autosave chain.
const TYPED_FIELD_DEFINITIONS = Object.freeze({
    userAvatarBorderColor: { path: 'userAvatarBorderColor', kind: 'string' },
    userAvatarBorderColorText: { path: 'userAvatarBorderColor', kind: 'string' },
    showHomeVisualBrand: { path: 'showHomeVisualBrand', kind: 'boolean' },
    showHomeVisualTagline: { path: 'showHomeVisualTagline', kind: 'boolean' },
    homeVisualTagline: { path: 'homeVisualTagline', kind: 'string' },
    appearanceDensity: { path: 'appearanceProfile.density', kind: 'string' },
    appearanceRadius: { path: 'appearanceProfile.radius', kind: 'string' },
    appearanceTypography: { path: 'appearanceProfile.typography', kind: 'string' },
    appearanceFontScale: { path: 'appearanceProfile.fontScale', kind: 'string' },
    appearanceContentWidth: { path: 'appearanceProfile.contentWidth', kind: 'string' },
    appearanceSurface: { path: 'appearanceProfile.surface', kind: 'string' },
    appearanceSidebarRowHeight: { path: 'appearanceProfile.sidebarRowHeight', kind: 'number' },
    appearanceSidebarAvatarSize: { path: 'appearanceProfile.sidebarAvatarSize', kind: 'number' },
    appearanceSidebarRadius: { path: 'appearanceProfile.sidebarRadius', kind: 'string' },
    appearanceCustomRadius: { path: 'appearanceProfile.customRadius', kind: 'number' },
    'appearanceSidebarRadiusChoice-tuned': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'tuned' },
    'appearanceSidebarRadiusChoice-follow': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'follow' },
    'appearanceSidebarRadiusChoice-square': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'square' },
    'appearanceSidebarRadiusChoice-small': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'small' },
    'appearanceSidebarRadiusChoice-medium': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'medium' },
    'appearanceSidebarRadiusChoice-round': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'round' },
    'appearanceSidebarRadiusChoice-custom': { path: 'appearanceProfile.sidebarRadius', kind: 'choice', value: 'custom' },
});

function readTypedFieldPatch(control, service) {
    const definition = TYPED_FIELD_DEFINITIONS[control?.id];
    if (!definition) return null;
    const raw = control.type === 'checkbox' ? control.checked : control.value;
    const value = definition.kind === 'choice' ? definition.value : definition.kind === 'number' ? Number(raw) : definition.kind === 'boolean' ? Boolean(raw) : String(raw);
    if (definition.path.startsWith('appearanceProfile.')) {
        const current = service.state.get()?.appearanceProfile || {};
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
        set('appearanceSidebarRadius', appearance.sidebarRadius || 'tuned');
        set('appearanceCustomRadius', appearance.customRadius ?? 10);
        set('appearanceCustomRadiusValue', `${appearance.customRadius ?? 10}px`);
        const radius = appearance.sidebarRadius || 'tuned';
        Object.keys(TYPED_FIELD_DEFINITIONS).filter(id => id.startsWith('appearanceSidebarRadiusChoice-'))
            .forEach(id => check(id, id === `appearanceSidebarRadiusChoice-${radius}`));
        check('showHomeVisualBrand', settings.showHomeVisualBrand !== false);
        check('showHomeVisualTagline', settings.showHomeVisualTagline !== false);
        set('homeVisualTagline', settings.homeVisualTagline || '语义级打穿 AI、UI/UX、APP 与人类想象力的边界');
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
    const onInput = event => {
        const control = event.target;
        if (!TYPED_FIELD_DEFINITIONS[control?.id]) return;
        const patch = readTypedFieldPatch(control, service) || {};
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
        form.dataset.vcpSettingsDirty = 'true';
        status()?.setAttribute('data-state', 'dirty');
        if (status()) status().textContent = '未保存';
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
    autosaveStates.forEach(state => {
        if (!state.pending) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        if (!state.saving) {
            state.saving = true;
            state.pending = false;
            state.form.requestSubmit();
        }
    });
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

function teardownSettingsAutosave() {
    [...autosaveStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        autosaveStates.delete(state);
    });
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

function mountHarnessSelects(form) {
    const previousObserver = selectObserverStates.get(form);
    previousObserver?.disconnect();
    // A refresh can arrive after an async options update.  Reclassify the
    // existing projection before the per-select guard sees its wrapper;
    // otherwise a Choice that became a long Select (or vice versa) would be
    // treated as already mounted forever.
    const requiresReclassification = [...form.querySelectorAll('select')].some(select => {
        const isChoice = Boolean(select.closest('.vcp-harness-choice-wrap'));
        const isSelect = Boolean(select.closest('.vcp-harness-select-wrap'));
        const shouldChoice = !select.multiple && !select.disabled && select.options.length > 1 && select.options.length <= 4;
        return (isChoice && !shouldChoice) || (isSelect && shouldChoice);
    });
    if (requiresReclassification) teardownHarnessSelects();
    let ordinal = 0;
    form.querySelectorAll('select').forEach(select => {
        ordinal += 1;
        // The first TypeScript Light-DOM vertical slice owns this field;
        // never wrap it in the legacy Harness bridge during the same pass.
        if (['appearanceDensity', 'appearanceRadius', 'appearanceTypography', 'appearanceFontScale', 'appearanceContentWidth', 'appearanceSurface'].includes(select.id)) return;
        if (select.multiple || select.disabled || select.closest('.vcp-harness-select-wrap, .vcp-harness-choice-wrap')) return;
        if (select.options.length > 1 && select.options.length <= 4) { mountHarnessChoice(select); return; }
        if (select.options.length <= 1) return;
        const controlId = select.id || `vcp-select-${ordinal}`;
        const originalTabIndex = select.getAttribute('tabindex');
        const originalAriaHidden = select.getAttribute('aria-hidden');
        const wrap = document.createElement('div');
        wrap.className = 'vcp-harness-select-wrap';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vcp-harness-select-trigger';
        // The presentation projection owns a Harness Menu primitive; the
        // native select remains the sole business/serialization source.
        button.setAttribute('aria-haspopup', 'menu');
        button.id = `${controlId}-trigger`;
        const label = document.createElement('span');
        label.className = 'vcp-harness-select-label';
        const arrow = document.createElement('span');
        arrow.className = 'vcp-harness-select-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = '';
        button.append(label, arrow);
        const popover = document.createElement('div');
        popover.className = 'vcp-harness-menu-list vcp-harness-select-popover vcp-harness-menu-portal';
        // Harness Menu is a menu primitive; the native select remains the
        // serialization source while this portal owns menu semantics.
        popover.setAttribute('role', 'menu');
        popover.id = `${controlId}-menu`;
        popover.hidden = true;
        const state = { select, wrap, button, label, popover, open: false, portal: false, activeIndex: 0, cleanups: [], rebuildOptions: null };
        button.setAttribute('aria-controls', popover.id);
        const fieldLabel = select.id ? [...document.querySelectorAll('label[for]')].find(label => label.htmlFor === select.id) : null;
        const originalLabelId = fieldLabel?.id || null;
        if (fieldLabel) {
            if (!fieldLabel.id) fieldLabel.id = `${controlId}-label`;
            button.setAttribute('aria-labelledby', fieldLabel.id);
        }
        const sync = () => {
            const selected = select.options[select.selectedIndex];
            label.textContent = selected?.textContent?.trim() || '';
            button.setAttribute('aria-label', select.getAttribute('aria-label') || selected?.textContent?.trim() || '选择');
            state.activeIndex = Math.max(0, select.selectedIndex);
            [...popover.querySelectorAll('[role="menuitem"]')].forEach((option, index) => {
                const active = option.dataset.value === select.value;
                option.classList.toggle('is-selected', active);
                option.tabIndex = index === state.activeIndex ? 0 : -1;
            });
            button.setAttribute('aria-activedescendant', `${controlId}-option-${state.activeIndex}`);
        };
        const position = () => {
            if (!state.open) return;
            const rect = button.getBoundingClientRect();
            popover.style.position = 'fixed'; popover.style.left = `${rect.left}px`; popover.style.top = `${rect.bottom + 6}px`; popover.style.width = `${rect.width}px`;
        };
        const close = () => {
            const wasOpen = state.open;
            state.open = false;
            popover.hidden = true;
            button.setAttribute('aria-expanded', 'false');
            wrap.classList.remove('is-open');
            if (state.portal) { wrap.append(popover); state.portal = false; }
            popover.style.position = ''; popover.style.left = ''; popover.style.top = ''; popover.style.width = ''; popover.style.visibility = '';
            if (wasOpen) { harnessSelectOpenCount = Math.max(0, harnessSelectOpenCount - 1); releaseHarnessSelectOwner(); }
        };
        const open = () => {
            if (select.disabled) return;
            state.open = true;
            harnessSelectOpenCount += 1;
            mountHarnessSelectOwner();
            if (!state.portal) { document.body.append(popover); state.portal = true; }
            popover.hidden = false;
            popover.style.visibility = 'hidden';
            button.setAttribute('aria-expanded', 'true');
            wrap.classList.add('is-open');
            position();
            requestAnimationFrame(() => {
                if (!state.open) return;
                position();
                popover.style.visibility = 'visible';
                viewport.querySelector(`[role="menuitem"][data-index="${state.activeIndex}"]`)?.focus();
            });
        };
        select.parentNode.insertBefore(wrap, select);
        wrap.append(select, button, popover);
        select.classList.add('vcp-harness-select-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        button.setAttribute('aria-expanded', 'false');
        const viewport = document.createElement('div');
        viewport.className = 'vcp-harness-menu-viewport';
        popover.append(viewport);
        const rebuildOptions = () => {
            // Rebuild the projection atomically from the native select.  The
            // native node remains the sole business source; projection
            // buttons are disposable presentation artifacts.
            viewport.replaceChildren();
            const optionCleanups = [];
            [...select.options].forEach((option, optionIndex) => {
            const itemWrap = document.createElement('div');
            itemWrap.className = 'vcp-harness-menu-item-wrap';
            const item = document.createElement('button');
            item.type = 'button'; item.className = 'vcp-harness-menu-item vcp-harness-select-option'; item.dataset.value = option.value;
            item.id = `${controlId}-option-${optionIndex}`;
            item.dataset.index = String(optionIndex);
            item.setAttribute('role', 'menuitem');
            item.disabled = option.disabled;
            if (option.disabled) item.setAttribute('aria-disabled', 'true');
            const text = document.createElement('span'); text.className = 'vcp-harness-menu-item-label'; text.textContent = option.textContent.trim();
            const check = document.createElement('span'); check.className = 'vcp-harness-menu-check vcp-harness-select-check vcp-ui-icon'; check.textContent = 'check'; check.setAttribute('aria-hidden', 'true');
            item.append(text, check); itemWrap.append(item); viewport.append(itemWrap);
            const onClick = () => {
                if (option.disabled) return;
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                sync();
                close();
                button.focus();
            };
            item.addEventListener('click', onClick); optionCleanups.push(() => item.removeEventListener('click', onClick));
            });
            // Rebuilding the disposable projection must retract listeners from
            // detached option buttons before dropping their cleanup handles.
            // Filtering alone leaves the old buttons/listeners retained until
            // the whole Select owner is torn down.
            state.cleanups.filter(cleanup => cleanup.__vcpOptionCleanup).forEach(cleanup => cleanup());
            state.cleanups = state.cleanups.filter(cleanup => !cleanup.__vcpOptionCleanup);
            optionCleanups.forEach(cleanup => { cleanup.__vcpOptionCleanup = true; state.cleanups.push(cleanup); });
            sync();
        };
        state.rebuildOptions = rebuildOptions;
        rebuildOptions();
        const onButton = () => state.open ? close() : open();
        const onKey = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onButton(); return; }
            if (event.key === 'Escape' && state.open) { event.preventDefault(); close(); return; }
        };
        const onMenuKey = event => {
            if (!state.open) return;
            const items = [...viewport.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled);
            if (!items.length) return;
            const current = Math.max(0, items.findIndex(item => Number(item.dataset.index) === state.activeIndex));
            let next = current;
            if (event.key === 'ArrowDown') next = (current + 1) % items.length;
            else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = items.length - 1;
            else if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); return; }
            else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault(); items[current]?.click(); return;
            } else return;
            event.preventDefault();
            state.activeIndex = Number(items[next].dataset.index);
            items[next].focus();
            button.setAttribute('aria-activedescendant', items[next].id);
        };
        const onChange = sync;
        state.close = close;
        state.position = position;
        button.addEventListener('click', onButton); button.addEventListener('keydown', onKey); popover.addEventListener('keydown', onMenuKey); select.addEventListener('change', onChange); window.addEventListener('global-settings-updated', onChange);
        state.cleanups.push(() => { close(); button.removeEventListener('click', onButton); button.removeEventListener('keydown', onKey); popover.removeEventListener('keydown', onMenuKey); select.removeEventListener('change', onChange); window.removeEventListener('global-settings-updated', onChange); if (originalAriaHidden === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', originalAriaHidden); if (originalTabIndex === null) select.removeAttribute('tabindex'); else select.setAttribute('tabindex', originalTabIndex); if (fieldLabel && originalLabelId === null) fieldLabel.removeAttribute('id'); });
        sync(); customSelectStates.add(state);
    });
    if (window.MutationObserver && !selectObserverStates.has(form)) {
        const observer = new window.MutationObserver(mutations => {
            const relevant = mutations.some(record => {
                if (record.type === 'attributes') return record.target.matches?.('select, option');
                if (record.type !== 'childList') return false;
                if (record.target.matches?.('select')) return true;
                return [...record.addedNodes, ...record.removedNodes].some(node =>
                    node.nodeType === window.Node.ELEMENT_NODE &&
                    (node.matches?.('select, option') || node.querySelector?.('select, option'))
                );
            });
            if (!relevant) return;
            if (form.dataset.vcpSelectRebuilding === 'true') return;
            clearTimeout(form.__vcpSelectRebuildTimer);
            form.__vcpSelectRebuildTimer = setTimeout(() => {
                form.dataset.vcpSelectRebuilding = 'true';
                // Same classification: refresh only the affected projection.
                // If option count crosses the compact-choice threshold, do a
                // full transaction so no stale instance or portal survives.
                const changedSelects = [...form.querySelectorAll('select')];
                const requiresReclassification = changedSelects.some(select => {
                    const isChoice = Boolean(select.closest('.vcp-harness-choice-wrap'));
                    const shouldChoice = !select.multiple && !select.disabled && select.options.length > 1 && select.options.length <= 4;
                    return isChoice !== shouldChoice;
                });
                if (requiresReclassification) {
                    teardownHarnessSelects();
                    mountHarnessSelects(form);
                } else {
                    customSelectStates.forEach(state => {
                        if (state.select.form === form) state.rebuildOptions?.();
                    });
                    customChoiceStates.forEach(state => {
                        if (state.select.form === form) state.rebuildOptions?.();
                    });
                }
                form.dataset.vcpSelectRebuilding = 'false';
            }, 0);
        });
        observer.observe(form, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value', 'selected'] });
        selectObserverStates.set(form, observer);
    }
}

function mountHarnessChoice(select) {
    const wrap = document.createElement('div'); wrap.className = 'vcp-harness-choice-wrap';
    const track = document.createElement('div'); track.className = 'vcp-harness-choice-track'; track.setAttribute('role', 'radiogroup');
    const originalTabIndex = select.getAttribute('tabindex');
    const originalAriaHidden = select.getAttribute('aria-hidden');
    const state = { select, wrap, track, cleanups: [], rebuildOptions: null };
    const fieldLabel = select.id ? [...document.querySelectorAll('label[for]')].find(label => label.htmlFor === select.id) : null;
    const originalLabelId = fieldLabel?.id || null;
    if (fieldLabel) {
        if (!fieldLabel.id) fieldLabel.id = `${select.id}-label`;
        track.setAttribute('aria-labelledby', fieldLabel.id);
    }
    const sync = () => [...track.children].forEach(item => {
        const active = item.dataset.value === select.value;
        item.classList.toggle('is-selected', active); item.setAttribute('aria-checked', String(active));
        item.tabIndex = active ? 0 : -1;
    });
    select.parentNode.insertBefore(wrap, select); wrap.append(select, track); select.classList.add('vcp-harness-choice-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    const rebuildOptions = () => {
        const focusedValue = track.querySelector(':focus')?.dataset.value;
        track.replaceChildren();
        const optionCleanups = [];
        [...select.options].forEach(option => {
        const item = document.createElement('button'); item.type = 'button'; item.className = 'vcp-harness-choice-option'; item.dataset.value = option.value;
        item.setAttribute('role', 'radio'); item.textContent = option.textContent.trim();
        item.disabled = option.disabled; if (option.disabled) item.setAttribute('aria-disabled', 'true');
        const onClick = () => { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); sync(); item.focus(); };
        item.addEventListener('click', onClick); optionCleanups.push(() => item.removeEventListener('click', onClick)); track.append(item);
        });
        // Retract listeners from detached choice buttons before replacing the
        // cleanup handles; filtering without invoking them leaks each option
        // projection across SettingsRoot refreshes.
        state.cleanups.filter(cleanup => cleanup.__vcpOptionCleanup).forEach(cleanup => cleanup());
        state.cleanups = state.cleanups.filter(cleanup => !cleanup.__vcpOptionCleanup);
        optionCleanups.forEach(cleanup => { cleanup.__vcpOptionCleanup = true; state.cleanups.push(cleanup); });
        sync();
        if (focusedValue) [...track.children].find(item => item.dataset.value === focusedValue)?.focus();
    };
    state.rebuildOptions = rebuildOptions;
    rebuildOptions();
    const onKey = event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const available = [...select.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);
        if (!available.length) return;
        const current = Math.max(0, available.findIndex(({ index }) => index === select.selectedIndex));
        let next = current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = available.length - 1;
        else {
            const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
            next = (current + delta + available.length) % available.length;
        }
        next = available[next].index;
        select.selectedIndex = next; select.dispatchEvent(new Event('change', { bubbles: true })); sync();
        [...track.children].find(item => item.dataset.value === select.value)?.focus();
    };
    const onChange = sync; select.addEventListener('change', onChange); window.addEventListener('global-settings-updated', onChange); track.addEventListener('keydown', onKey);
    state.cleanups.push(() => { select.removeEventListener('change', onChange); window.removeEventListener('global-settings-updated', onChange); track.removeEventListener('keydown', onKey); if (originalAriaHidden === null) select.removeAttribute('aria-hidden'); else select.setAttribute('aria-hidden', originalAriaHidden); if (originalTabIndex === null) select.removeAttribute('tabindex'); else select.setAttribute('tabindex', originalTabIndex); if (fieldLabel && originalLabelId === null) fieldLabel.removeAttribute('id'); });
    sync(); customChoiceStates.add(state);
}

function teardownHarnessSelects() {
    selectObserverStates.forEach((observer, form) => {
        observer.disconnect();
        clearTimeout(form.__vcpSelectRebuildTimer);
        delete form.__vcpSelectRebuildTimer;
    });
    selectObserverStates.clear();
    window.__vcpHarnessSelectOwnerCleanup?.();
    harnessSelectOpenCount = 0;
    [...customSelectStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        state.select.classList.remove('vcp-harness-select-native');
        if (state.wrap.parentNode) state.wrap.parentNode.insertBefore(state.select, state.wrap);
        state.wrap.remove();
        customSelectStates.delete(state);
    });
    [...customChoiceStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        state.select.classList.remove('vcp-harness-choice-native');
        if (state.wrap.parentNode) state.wrap.parentNode.insertBefore(state.select, state.wrap);
        state.wrap.remove(); customChoiceStates.delete(state);
    });
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
    teardownSettingsAutosave();
    teardownHarnessDisclosures();
    teardownHarnessSelects();
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
