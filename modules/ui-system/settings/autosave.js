// autosave — the legacy form autosave state machine (dirty/saving/error
// status button + debounced requestSubmit). Cross-registry flush orchestration
// (typed field/forum owners) stays in the bridge entry; this module owns only
// the legacy autosave registry and its lifecycle.
const autosaveStates = new Set();

export function mountSettingsAutosave(root, form, scope = null) {
    if (form.dataset.vcpAutosaveMounted === 'true') return;
    const statusHost = root.querySelector('.vcp-harness-settings-actions')
        || form.querySelector('.form-actions');
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
        try {
            form.requestSubmit();
        } catch {
            // A form without a submittable control throws synchronously; the
            // state machine must unwind or every later save stays wedged on
            // saving=true with the status frozen at 保存中….
            state.saving = false;
            state.failureOwner = 'legacy-autosave';
            setStatus('保存失败 · 重试', 'error');
        }
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
        // Forum fields carry the same suppression marker as typed settings
        // fields; otherwise typing there also drives this whole-form
        // autosave chain and both owners fight over one status bar.
        if (event.target.dataset.vcpTypedFieldOwner === 'true') return;
        if (event.target.dataset.vcpTypedForumFieldOwner === 'true') return;
        schedule();
    };
    const onResult = event => {
        // Typed settings/forum field owners own their own status writes; the
        // shared status node must not be clobbered by their results.
        if (event.detail?.owner === 'typed-settings-field-owner') return;
        if (event.detail?.owner === 'typed-forum-field-owner') return;
        state.saving = false;
        if (event.detail?.success) {
            delete state.failureOwner;
            delete form.dataset.vcpSettingsDirty;
            setStatus('已保存', 'saved');
            if (state.pending) schedule();
        } else {
            // Remember which owner failed so retry clicks can be routed.
            state.failureOwner = event.detail?.owner || 'legacy-autosave';
            setStatus('保存失败 · 重试', 'error');
        }
    };
    const onStatusClick = () => {
        if (state.failureOwner === 'typed-forum-field-owner') return;
        if (status.dataset.state === 'error') schedule();
    };
    const listen = (target, type, handler, label) => {
        if (scope?.listen) return scope.listen(target, type, handler, undefined, label);
        target.addEventListener(type, handler);
        return () => target.removeEventListener(type, handler);
    };
    const releaseInput = listen(form, 'input', onInput, 'settings-legacy-autosave-input');
    const releaseChange = listen(form, 'change', onInput, 'settings-legacy-autosave-change');
    const releaseResult = listen(form, 'vcp-settings-save-result', onResult, 'settings-legacy-autosave-result');
    const releaseStatus = listen(status, 'click', onStatusClick, 'settings-legacy-autosave-retry');
    state.cleanups.push(() => {
        if (state.timer) clearTimeout(state.timer);
        // Scope-owned listeners are released by the presentation owner. The
        // fallback disposer keeps this module safe when LifecycleScope is not
        // available during early bootstrap, and every release is idempotent.
        void releaseInput?.();
        void releaseChange?.();
        void releaseResult?.();
        void releaseStatus?.();
        status.remove();
        delete form.dataset.vcpAutosaveMounted;
    });
    form.dataset.vcpAutosaveMounted = 'true';
    autosaveStates.add(state);
}

export function flushLegacyAutosave() {
    autosaveStates.forEach(state => {
        if (!state.pending) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = null;
        if (!state.saving) {
            state.saving = true;
            state.pending = false;
            try {
                state.form.requestSubmit();
            } catch {
                state.saving = false;
                state.pending = true;
                state.form.dataset.vcpSettingsDirty = 'true';
            }
        }
    });
}

export function teardownLegacyAutosave() {
    [...autosaveStates].forEach(state => {
        state.cleanups.forEach(cleanup => cleanup());
        autosaveStates.delete(state);
    });
}
