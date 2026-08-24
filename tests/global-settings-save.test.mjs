import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

test('global settings saves the server URL once with canonical presentation', async () => {
    const root = process.cwd();
    const mainHtml = fs.readFileSync(path.join(root, 'main.html'), 'utf8');
    const source = new JSDOM(mainHtml, { url: 'https://vcpchat.local/' });
    const dom = new JSDOM('<!doctype html><html data-ui-mode="next"><body></body></html>', {
        url: 'https://vcpchat.local/',
    });
    const template = source.window.document.getElementById('globalSettingsModalTemplate');
    dom.window.document.body.appendChild(dom.window.document.importNode(template.content, true));

    const previousGlobals = {};
    for (const name of ['window', 'document', 'CustomEvent']) {
        previousGlobals[name] = globalThis[name];
    }
    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        CustomEvent: dom.window.CustomEvent,
    });

    let resolveSave;
    let saveCalls = 0;
    let croppedFile = null;
    let savedPayload;
    let normalizeMode;
    const savePromise = new Promise(resolve => { resolveSave = resolve; });
    dom.window.chatAPI = {
        saveSettings(payload) {
            saveCalls += 1;
            savedPayload = payload;
            return savePromise;
        },
        async saveRustAssistantConfig() { return { success: true }; },
        connectVCPLog() {},
        disconnectVCPLog() {},
    };
    dom.window.VCPAppearance = {
        normalize(profile, mode) {
            normalizeMode = mode;
            return profile;
        },
        commit: profile => profile,
    };
    dom.window.normalizeChatPresentationMode = () => 'bubble';

    let currentSettings = {};
    const deps = {
        refs: { globalSettings: { get: () => currentSettings, set: value => { currentSettings = value; } } },
        getCroppedFile: () => croppedFile,
        setCroppedFile() {},
        uiHelperFunctions: { showToastNotification() {}, closeModal() {} },
        settingsManager: { completeVcpUrl: url => url },
        normalizeChatPresentationMode: () => 'bubble',
        applyChatPresentationMode: async () => ({ success: true, mode: 'bubble' }),
        applyChatBubbleLayoutSettings() {},
    };
    const form = dom.window.document.getElementById('globalSettingsForm');
    const saveResults = [];
    form.addEventListener('vcp-settings-save-result', event => saveResults.push(event.detail));
    dom.window.document.getElementById('vcpServerUrl').value = 'http://localhost:6005';

    try {
        const moduleUrl = `${pathToFileURL(path.join(root, 'modules/global-settings-manager.js')).href}?save-regression=${Date.now()}`;
        const { handleSaveGlobalSettings } = await import(moduleUrl);
        const event = { preventDefault() {}, currentTarget: form };
        const firstSave = handleSaveGlobalSettings(event, deps);
        await handleSaveGlobalSettings(event, deps);

        assert.equal(saveCalls, 1, 'an in-flight form cannot submit twice');
        assert.equal(normalizeMode, 'next', 'appearance normalization uses the canonical mode');
        assert.equal(savedPayload.vcpServerUrl, 'http://localhost:6005');
        assert.equal(form.dataset.globalSettingsSaving, 'true');

        resolveSave({ success: true });
        await firstSave;
        assert.equal(form.dataset.globalSettingsSaving, undefined, 'the submit lock is released after completion');

        let typedCalls = 0;
        let typedPayload;
        let typedRustCalls = 0;
        let typedRustPayload;
        let rustShouldFail = false;
        let typedForumCalls = 0;
        let typedForumPayload;
        let forumShouldFail = false;
        let forumShouldThrow = false;
        let typedShouldHang = false;
        let typedCancelled = false;
        dom.window.VCPUISettingsBridge = {
            getTypedService: () => ({
                save: {
                    execute: async payload => {
                        typedCalls += 1;
                        typedPayload = payload;
                        if (typedShouldHang) return new Promise(() => {});
                        return { success: true };
                    },
                },
                cancelPendingSaves: () => { typedCancelled = true; },
            }),
            getRustAssistantService: () => ({
                save: {
                    execute: async payload => {
                        typedRustCalls += 1;
                        typedRustPayload = payload;
                        return rustShouldFail ? { success: false, error: 'rust-denied' } : { success: true };
                    },
                },
            }),
            getForumConfigService: () => ({
                save: {
                    execute: async payload => {
                        typedForumCalls += 1;
                        typedForumPayload = payload;
                        if (forumShouldThrow) throw new Error('forum-ipc-down');
                        return forumShouldFail ? { success: false, error: 'forum-denied' } : { success: true };
                    },
                },
            }),
        };
        dom.window.chatAPI.saveSettings = () => {
            throw new Error('legacy save path should not run when typed service is available');
        };
        dom.window.document.getElementById('adminUsername').value = 'forum-admin';
        dom.window.document.getElementById('adminPassword').value = 'forum-password';
        await handleSaveGlobalSettings(event, deps);
        assert.equal(typedCalls, 1, 'global Settings form delegates persistence to typed service command');
        assert.equal(typedPayload.vcpServerUrl, 'http://localhost:6005');
        assert.equal(saveCalls, 1, 'typed service command avoids a second legacy IPC save');
        assert.equal(typedRustCalls, 1, 'Rust settings save delegates to the typed Rust service command');
        assert.equal(typedRustPayload?.debugMode, false);
        assert.equal(typedForumCalls, 1, 'forum settings save delegates to the typed Forum service command');
        assert.equal(typedForumPayload?.username, 'forum-admin');

        typedShouldHang = true;
        deps.saveTimeoutMs = 5;
        await assert.rejects(
            handleSaveGlobalSettings(event, deps),
            /保存设置超时/,
            'a typed save timeout must become a recoverable terminal state'
        );
        assert.equal(typedCancelled, true, 'typed timeout invalidates pending publication rights');
        assert.equal(saveResults.at(-1)?.success, false, 'typed timeout publishes a retryable terminal state');
        typedShouldHang = false;
        delete deps.saveTimeoutMs;

        croppedFile = { name: 'avatar.png', type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) };
        dom.window.chatAPI.saveUserAvatar = async () => ({ success: false, error: 'avatar-denied' });
        await handleSaveGlobalSettings(event, deps);
        assert.equal(saveResults.at(-1)?.success, false, 'avatar command failure publishes a retryable terminal state');
        assert.match(saveResults.at(-1)?.error || '', /avatar-denied/, 'avatar command error reaches the SettingsRoot retry UI');
        assert.equal(typedCalls, 2, 'avatar failure stops the transaction before a second global settings persistence');
        croppedFile = null;
        delete dom.window.chatAPI.saveUserAvatar;

        rustShouldFail = true;
        await handleSaveGlobalSettings(event, deps);
        assert.equal(saveResults.at(-1)?.success, false, 'Rust command failure publishes a retryable terminal state');
        assert.match(saveResults.at(-1)?.error || '', /rust-denied/, 'Rust command error reaches the SettingsRoot retry UI');

        rustShouldFail = false;
        forumShouldFail = true;
        await handleSaveGlobalSettings(event, deps);
        assert.equal(saveResults.at(-1)?.success, false, 'Forum command failure publishes a retryable terminal state');
        assert.match(saveResults.at(-1)?.error || '', /forum-denied/, 'Forum command error reaches the SettingsRoot retry UI');

        forumShouldFail = false;
        forumShouldThrow = true;
        await handleSaveGlobalSettings(event, deps);
        assert.equal(saveResults.at(-1)?.success, false, 'Forum command exceptions publish a retryable terminal state');
        assert.match(saveResults.at(-1)?.error || '', /forum-ipc-down/, 'Forum command exception reaches the SettingsRoot retry UI');

        forumShouldThrow = false;
        dom.window.document.getElementById('adminUsername').value = '';
        dom.window.document.getElementById('adminPassword').value = '';
        delete dom.window.VCPUISettingsBridge;
        let resolveLate;
        dom.window.chatAPI.saveSettings = () => new Promise(resolve => { resolveLate = resolve; });
        deps.saveTimeoutMs = 5;
        await assert.rejects(
            handleSaveGlobalSettings(event, deps),
            /保存设置超时/,
            'a permanently pending save must become a recoverable terminal state'
        );
        assert.equal(form.dataset.globalSettingsSaving, undefined, 'timeout must release the submit lock');
        assert.equal(saveResults.length, 8, 'each save attempt publishes exactly one terminal event');
        assert.equal(saveResults.at(-1)?.success, false, 'timeout publishes a failure terminal state to autosave');
        assert.match(saveResults.at(-1)?.error || '', /保存设置超时/, 'timeout error is available to retry UI');
        resolveLate({ success: true });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(saveResults.length, 8, 'late IPC success cannot resurrect a timed-out UI save');
    } finally {
        for (const [name, value] of Object.entries(previousGlobals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
        dom.window.close();
        source.window.close();
    }
});
