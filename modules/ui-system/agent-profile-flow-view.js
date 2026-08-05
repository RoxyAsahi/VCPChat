import { button, node } from './agent-workbench-dom.js';

export function createAgentProfileFlowView({ element, document, actions }) {
    let model = null;

    function field(label, control) {
        const wrap = node('label', 'agent-chat-topic-flow-field');
        wrap.append(node('span', 'agent-chat-topic-flow-label', label), control);
        return wrap;
    }

    function updateDraft(patch) {
        actions.updateDraft(patch);
    }

    function render() {
        element.replaceChildren();
        element.hidden = !model;
        if (!model) return;
        const backdrop = node('div', 'agent-chat-topic-flow-backdrop');
        const dialog = node('section', 'agent-chat-topic-flow-dialog');
        dialog.tabIndex = -1;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'agentChatTopicFlowTitle');
        dialog.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !model.saving) actions.close();
        });
        backdrop.addEventListener('click', () => { if (!model.saving) actions.close(); });

        const title = node('h2', 'agent-chat-topic-flow-title', '新建 Build Agent');
        title.id = 'agentChatTopicFlowTitle';
        const description = node('p', 'agent-chat-topic-flow-description',
            '创建独立于主聊天助手目录的 Build Agent。提示词会冻结到以后新建的 Session。');
        const form = node('form', 'agent-chat-topic-flow-form');
        const nameInput = document.createElement('input');
        nameInput.className = 'agent-chat-topic-flow-input';
        nameInput.value = model.name;
        nameInput.maxLength = 80;
        nameInput.required = true;
        nameInput.setAttribute('aria-label', 'Build Agent 名称');
        nameInput.addEventListener('input', () => updateDraft({ name: nameInput.value }));
        const promptInput = document.createElement('textarea');
        promptInput.className = 'agent-chat-topic-flow-input agent-chat-setting-prompt';
        promptInput.value = model.systemPrompt;
        promptInput.rows = 7;
        promptInput.required = true;
        promptInput.placeholder = '例如：{{Nova}}';
        promptInput.setAttribute('aria-label', 'Build Agent 提示词');
        promptInput.addEventListener('input', () => updateDraft({ systemPrompt: promptInput.value }));
        const modelInput = document.createElement('input');
        modelInput.className = 'agent-chat-topic-flow-input';
        modelInput.value = model.model;
        modelInput.setAttribute('aria-label', 'Build Agent 默认模型');
        modelInput.setAttribute('list', 'agentChatAgentFlowModels');
        modelInput.addEventListener('input', () => updateDraft({ model: modelInput.value }));
        const modelList = document.createElement('datalist');
        modelList.id = 'agentChatAgentFlowModels';
        for (const entry of model.modelCatalog) {
            const option = document.createElement('option');
            option.value = entry.id || entry.name || String(entry);
            modelList.append(option);
        }
        const workspaceInput = document.createElement('input');
        workspaceInput.className = 'agent-chat-topic-flow-input';
        workspaceInput.value = model.workspaceRoot;
        workspaceInput.placeholder = '留空使用 VCPChat 当前工作目录';
        workspaceInput.setAttribute('aria-label', 'Build Agent 默认工作目录');
        workspaceInput.addEventListener('input', () => updateDraft({ workspaceRoot: workspaceInput.value }));
        const permissionSelect = document.createElement('select');
        permissionSelect.className = 'agent-chat-topic-flow-input';
        permissionSelect.setAttribute('aria-label', 'Build Agent 默认审批模式');
        for (const [value, label] of [
            ['ask', '每次确认（推荐）'],
            ['always-approve', 'YOLO：本地自动允许'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            option.selected = value === model.permissionMode;
            permissionSelect.append(option);
        }
        permissionSelect.addEventListener('change', () => updateDraft({ permissionMode: permissionSelect.value }));
        const controls = node('div', 'agent-chat-topic-flow-actions');
        const cancel = button('取消', 'secondary');
        cancel.type = 'button';
        cancel.disabled = model.saving;
        cancel.addEventListener('click', actions.close);
        const submit = button(model.saving ? '正在创建…' : '创建助手', 'primary');
        submit.type = 'submit';
        submit.disabled = model.saving || !model.name.trim() || !model.systemPrompt.trim();
        controls.append(cancel, submit);
        form.append(
            field('名称', nameInput),
            field('提示词', promptInput),
            field('默认模型（可留空）', modelInput),
            modelList,
            field('默认工作目录（可留空）', workspaceInput),
            field('默认本地工具审批', permissionSelect),
            controls,
        );
        form.addEventListener('input', () => {
            submit.disabled = model.saving || !nameInput.value.trim() || !promptInput.value.trim();
        });
        form.addEventListener('submit', (event) => {
            event.preventDefault();
            actions.submit({
                name: nameInput.value.trim(),
                systemPrompt: promptInput.value.trim(),
                model: modelInput.value.trim() || undefined,
                workspaceRoot: workspaceInput.value.trim() || undefined,
                permissionMode: permissionSelect.value,
            });
        });
        dialog.append(title, description, form);
        element.append(backdrop, dialog);
        queueMicrotask(() => dialog.focus());
    }

    return {
        element,
        update(nextModel) {
            model = nextModel;
            render();
        },
        dispose() {
            model = null;
            element.replaceChildren();
        },
    };
}
