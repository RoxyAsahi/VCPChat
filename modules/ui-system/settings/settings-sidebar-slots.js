// Dynamic settings slots. Schema owns ordinary controls; these slots own the
// two pieces of settings UI whose shape changes at runtime.

const DEFAULT_DIRECTOR_TEMPLATE = `【角色】
写清人物的身份、年龄、性格底色、外形气质与说话习惯。

【场景】
交代此刻发生了什么、和谁说话、情绪处在什么位置。

【指导】
像导演一样下达演绎要领：
- 语速与顿挫：
- 气息与虚实：
- 停顿与重音：
- 共鸣位置：
- 音色质感：
- 情绪起伏：`;

const normalizedPrompts = prompts => Array.isArray(prompts)
    ? prompts.map(prompt => String(prompt ?? '').trim()).filter(Boolean)
    : [];

class MimoDirectorSlot {
    constructor({ form, scope, manager = globalThis.window?.settingsManager, notify } = {}) {
        this.form = form;
        this.scope = scope;
        this.manager = manager;
        this.notify = notify || ((message, kind) => globalThis.window?.uiHelperFunctions?.showToastNotification?.(message, kind));
        this.host = null;
        this.input = null;
        this.list = null;
        this.prompts = [];
        this.release = null;
        this.rowScopes = new Set();
    }

    mount() {
        const host = this.form?.querySelector?.('.tts-director-settings');
        if (!host || !this.scope) return null;
        this.host = host;
        this.input = host.querySelector('#agentTtsDirectorPromptInput');
        this.list = host.querySelector('#agentTtsDirectorPromptsContainer');
        const add = host.querySelector('#addAgentTtsDirectorPromptBtn');
        const fill = host.querySelector('#fillAgentTtsDirectorTemplateBtn');
        if (!this.input || !this.list || !add || !fill) return null;

        host.dataset.vcpSettingsSlot = 'mimo-director';
        this.prompts = normalizedPrompts(this.manager?.getTtsDirectorPrompts?.());
        this.render();
        this.scope.listen(add, 'mousedown', event => event.preventDefault(), undefined, 'mimo-director-add-guard');
        this.scope.listen(add, 'click', () => this.add(), undefined, 'mimo-director-add');
        this.scope.listen(fill, 'click', () => this.fillTemplate(), undefined, 'mimo-director-template');
        this.scope.listen(this.input, 'keydown', event => {
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            this.add();
        }, undefined, 'mimo-director-submit');
        this.bindEditor(this.input, () => this.renderDraftState());
        this.release = this.scope.own(() => {
            if (this.host?.dataset.vcpSettingsSlot === 'mimo-director') delete this.host.dataset.vcpSettingsSlot;
            this.host = null;
            this.input = null;
            this.list = null;
            this.rowScopes.forEach(rowScope => void rowScope.dispose('mimo-director-slot-released'));
            this.rowScopes.clear();
        }, 'mimo-director-slot', 'ui-slot');
        return this;
    }

    setPrompts(prompts) {
        this.prompts = normalizedPrompts(prompts);
        this.render();
    }

    getPrompts() {
        return [...this.prompts];
    }

    clearDraft() {
        if (!this.input) return;
        this.input.value = '';
        this.setEditing(false);
        this.resize(this.input, false);
    }

    add() {
        const prompt = this.input?.value?.trim() || '';
        if (!prompt) {
            this.notify('请先填写自然语言导演提示词。', 'warning');
            this.input?.focus();
            return;
        }
        this.prompts.push(prompt);
        this.manager?.setTtsDirectorPrompts?.(this.prompts);
        this.input.value = '';
        this.render();
        this.input.focus();
    }

    fillTemplate() {
        if (!this.input) return;
        const template = this.manager?.getTtsDirectorTemplate?.() || DEFAULT_DIRECTOR_TEMPLATE;
        const existing = this.input.value.trim();
        this.input.value = existing ? `${existing}\n\n${template}` : template;
        this.input.focus();
        this.resize(this.input, true);
    }

    remove(index) {
        this.prompts.splice(index, 1);
        this.manager?.setTtsDirectorPrompts?.(this.prompts);
        this.render();
    }

    bindEditor(editor, onInput) {
        if (!editor) return;
        this.scope.listen(editor, 'focus', () => {
            this.setEditing(true, editor);
            this.resize(editor, true);
        }, undefined, 'mimo-director-focus');
        this.scope.listen(editor, 'input', () => {
            onInput?.(editor.value);
            this.resize(editor, true);
        }, undefined, 'mimo-director-input');
        this.scope.listen(editor, 'blur', () => {
            this.setEditing(false, editor);
            this.resize(editor, false);
        }, undefined, 'mimo-director-blur');
    }

    bindRowEditor(editor, index, rowScope) {
        const listen = (target, type, handler, label) => rowScope.listen(target, type, handler, undefined, label);
        listen(editor, 'focus', () => {
            this.setEditing(true, editor);
            this.resize(editor, true);
        }, `mimo-director-row-${index}-focus`);
        listen(editor, 'input', () => {
            const trimmed = String(editor.value || '').trim();
            if (trimmed) this.prompts[index] = trimmed;
            this.manager?.setTtsDirectorPrompts?.(this.prompts);
            this.resize(editor, true);
        }, `mimo-director-row-${index}-input`);
        listen(editor, 'blur', () => {
            this.setEditing(false, editor);
            this.resize(editor, false);
            if (editor.value.trim()) return;
            this.remove(index);
        }, `mimo-director-row-${index}-blur`);
    }

    renderDraftState() {
        const manager = this.manager;
        manager?.setTtsDirectorPrompts?.(this.prompts);
    }

    render() {
        if (!this.list) return;
        const doc = this.list.ownerDocument || document;
        this.rowScopes.forEach(rowScope => void rowScope.dispose('mimo-director-rerender'));
        this.rowScopes.clear();
        this.list.replaceChildren();
        this.prompts.forEach((prompt, index) => {
            const rowScope = this.scope.child(`mimo-director-row-${index}`);
            this.rowScopes.add(rowScope);
            const row = doc.createElement('div');
            row.className = 'tts-director-item';
            const editor = doc.createElement('textarea');
            editor.className = 'tts-director-editor';
            editor.rows = 1;
            editor.value = prompt;
            editor.setAttribute('aria-label', `导演提示词 ${index + 1}`);
            this.bindRowEditor(editor, index, rowScope);
            const remove = doc.createElement('button');
            remove.type = 'button';
            remove.className = 'small-button tts-director-action-button';
            remove.textContent = '−';
            remove.title = '删除该导演提示词';
            remove.setAttribute('aria-label', `删除导演提示词 ${index + 1}`);
            rowScope.listen(remove, 'mousedown', event => event.preventDefault(), undefined, `mimo-director-row-${index}-guard`);
            rowScope.listen(remove, 'click', () => this.remove(index), undefined, `mimo-director-row-${index}-remove`);
            row.append(editor, remove);
            this.list.append(row);
        });
    }

    setEditing(editing, editor = this.input) {
        editor?.classList.toggle('is-editing', Boolean(editing));
        editor?.closest('.tts-director-item, .tts-director-composer')?.classList.toggle('is-editing', Boolean(editing));
    }

    resize(editor, expanded) {
        if (!editor) return;
        if (!expanded) {
            editor.style.height = '';
            editor.rows = 1;
            return;
        }
        editor.rows = 3;
        editor.style.height = 'auto';
        editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 84), 240)}px`;
    }
}

class SequentialSpeakerSlot {
    constructor({ form, scope, renderer = globalThis.window?.GroupRenderer } = {}) {
        this.form = form;
        this.scope = scope;
        this.renderer = renderer;
        this.host = null;
    }

    mount() {
        const host = this.form?.querySelector?.('#sequentialSpeakerOrderList');
        if (!host || !this.scope) return null;
        this.host = host;
        const container = host.closest('#sequentialOrderContainer');
        const root = container || host;
        root.dataset.vcpSettingsSlot = 'sequential-speaker';
        const externalRelease = this.renderer?.bindSequentialSpeakerSlot?.({ host, form: this.form });
        this.scope.own(() => {
            externalRelease?.();
            if (root.dataset.vcpSettingsSlot === 'sequential-speaker') delete root.dataset.vcpSettingsSlot;
            this.host = null;
        }, 'sequential-speaker-slot', 'ui-slot');
        return this;
    }
}

export { DEFAULT_DIRECTOR_TEMPLATE, MimoDirectorSlot, SequentialSpeakerSlot };
