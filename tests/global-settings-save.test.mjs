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
    const dom = new JSDOM('<!doctype html><html data-vcp-ui-surface="main-chat"><body></body></html>', {
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
    let savedPayload;
    let normalizeArgumentCount;
    let closeCalls = 0;
    let updatedEvents = 0;
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
        normalize(profile, ...extra) {
            normalizeArgumentCount = extra.length;
            return profile;
        },
        commit: profile => profile,
    };
    dom.window.normalizeChatPresentationMode = () => 'bubble';

    const currentSettings = {};
    const modal = dom.window.document.getElementById('globalSettingsModal');
    modal.classList.add('active');
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
        detail: { modalId: 'globalSettingsModal', root: modal, active: true },
    }));
    dom.window.addEventListener('global-settings-updated', () => { updatedEvents += 1; });
    const deps = {
        refs: { globalSettings: { get: () => currentSettings } },
        getCroppedFile: () => null,
        setCroppedFile() {},
        uiHelperFunctions: {
            showToastNotification() {},
            closeModal() { closeCalls += 1; },
        },
        settingsManager: { completeVcpUrl: url => url },
    };
    const form = dom.window.document.getElementById('globalSettingsForm');
    dom.window.document.getElementById('vcpServerUrl').value = 'http://localhost:6005';

    try {
        const moduleUrl = `${pathToFileURL(path.join(root, 'modules/global-settings-manager.js')).href}?save-regression=${Date.now()}`;
        const { handleSaveGlobalSettings } = await import(moduleUrl);
        const event = { preventDefault() {}, currentTarget: form };
        const firstSave = handleSaveGlobalSettings(event, deps);
        await handleSaveGlobalSettings(event, deps);

        assert.equal(saveCalls, 1, 'an in-flight form cannot submit twice');
        assert.equal(normalizeArgumentCount, 0, 'appearance normalization has no retired mode argument');
        assert.equal(savedPayload.vcpServerUrl, 'http://localhost:6005');
        assert.equal(form.dataset.globalSettingsSaving, 'true');

        // Close and reopen the reusable modal before the old persistence
        // request settles. The old operation may finish durably, but must not
        // mutate or close the replacement surface.
        dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
            detail: { modalId: 'globalSettingsModal', root: modal, active: false },
        }));
        modal.classList.add('active');
        dom.window.document.dispatchEvent(new dom.window.CustomEvent('modal-visibility-changed', {
            detail: { modalId: 'globalSettingsModal', root: modal, active: true },
        }));

        resolveSave({ success: true });
        await firstSave;
        assert.equal(form.dataset.globalSettingsSaving, undefined, 'the submit lock is released after completion');
        assert.equal(closeCalls, 0, 'a stale save must not close the replacement settings modal');
        assert.equal(updatedEvents, 0, 'a stale save must not publish into the replacement settings surface');
        assert.deepEqual(currentSettings, {}, 'a stale save must not merge its snapshot into the replacement surface');
    } finally {
        for (const [name, value] of Object.entries(previousGlobals)) {
            if (value === undefined) delete globalThis[name];
            else globalThis[name] = value;
        }
        dom.window.close();
        source.window.close();
    }
});
