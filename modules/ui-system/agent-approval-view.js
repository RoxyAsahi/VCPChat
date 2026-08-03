import { button, cssEscape, node } from './agent-workbench-dom.js';

export function createAgentApprovalView({ document, blockPresentation, registry, actions }) {
    function interactionCard(interaction) {
        const payload = interaction.payload || {};
        const card = node('section', 'agent-chat-toolbox-ws-card agent-chat-interaction-card');
        card.dataset.interactionSource = String(interaction.source || 'unknown');
        card.dataset.interactionState = String(interaction.state || 'pending');
        card.dataset.interactionId = String(interaction.requestId || '');
        const labels = {
            'user-input': 'Codex 需要你的输入',
            permission: 'Codex 请求额外权限',
            'mcp-elicitation': 'MCP 请求用户交互',
        };
        card.append(node('strong', 'agent-chat-toolbox-ws-title', labels[interaction.kind]
            || `受限交互 · ${interaction.kind || 'unknown'}`));
        card.append(node('p', 'agent-chat-toolbox-ws-detail', [payload.header, payload.message, payload.reason]
            .filter(Boolean).join(' · ') || `${interaction.source || 'unknown'} / ${interaction.requestId || 'unknown'}`));
        if (interaction.expiresAtMs) {
            registry.set(interaction.requestId, { deadline: interaction.expiresAtMs, expired: false });
            card.dataset.approvalId = interaction.requestId;
            card.append(node('p', 'agent-chat-approval-countdown', '超时后安全取消'));
            actions.ensureTicker();
        }

        if (interaction.kind === 'user-input') {
            const form = node('form', 'agent-chat-interaction-form');
            for (const question of (payload.questions || []).slice(0, 16)) {
                const fieldset = node('fieldset', 'agent-chat-interaction-fieldset');
                fieldset.dataset.questionId = String(question.id || '');
                fieldset.append(node('legend', '', question.header || question.question || '需要输入'));
                if (question.question && question.question !== question.header) fieldset.append(node('p', 'agent-chat-muted', question.question));
                const options = Array.isArray(question.options) ? question.options : [];
                for (const [index, option] of options.entries()) {
                    const label = node('label', 'agent-chat-interaction-option');
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = `question:${question.id}`;
                    input.value = String(option.label || '');
                    if (index === 0) input.required = !question.isOther;
                    label.append(input, node('span', '', option.label || '选项'));
                    if (option.description) label.append(node('small', '', option.description));
                    fieldset.append(label);
                }
                if (!options.length || question.isOther) {
                    const input = document.createElement(options.length || question.isSecret ? 'input' : 'textarea');
                    input.name = `other:${question.id}`;
                    if (input.tagName === 'INPUT') input.type = question.isSecret ? 'password' : 'text';
                    if (input.tagName === 'TEXTAREA') input.rows = 3;
                    input.autocomplete = question.isSecret ? 'off' : 'on';
                    input.placeholder = options.length ? '其他答案' : '输入回答';
                    fieldset.append(input);
                }
                form.append(fieldset);
            }
            const controls = node('div', 'agent-chat-approval-actions');
            const cancel = button('取消', 'secondary');
            cancel.type = 'button';
            cancel.addEventListener('click', () => actions.respondInteraction(interaction, { answers: {} }));
            const submit = button('提交回答', 'primary');
            submit.type = 'submit';
            controls.append(cancel, submit);
            form.append(controls);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const answers = {};
                for (const question of (payload.questions || []).slice(0, 16)) {
                    const selected = form.querySelector(`input[name="question:${cssEscape(question.id)}"]:checked`)?.value;
                    const other = form.querySelector(`[name="other:${cssEscape(question.id)}"]`)?.value?.trim();
                    const answer = other || selected;
                    if (answer) answers[question.id] = { answers: [answer] };
                }
                actions.respondInteraction(interaction, { answers });
            });
            card.append(form);
            return card;
        }

        if (interaction.kind === 'permission') {
            card.append(node('p', 'agent-chat-approval-binding-value', `工作目录：${payload.cwd || '未知'}`));
            card.append(node('pre', 'agent-chat-approval-args', JSON.stringify(payload.permissions || {}, null, 2).slice(0, 16_384)));
            const scope = document.createElement('select');
            scope.setAttribute('aria-label', '授权范围');
            for (const [value, label] of [['turn', '仅当前 Turn'], ['session', '当前 Session']]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                scope.append(option);
            }
            const controls = node('div', 'agent-chat-approval-actions');
            const deny = button('拒绝', 'danger');
            const accept = button('按请求授权', 'secondary');
            deny.addEventListener('click', () => actions.respondInteraction(interaction, { decision: 'decline' }));
            accept.addEventListener('click', () => actions.respondInteraction(interaction, { decision: 'accept', scope: scope.value }));
            controls.append(scope, deny, accept);
            card.append(controls);
            return card;
        }

        if (interaction.kind === 'mcp-elicitation') {
            const mode = payload.mode || 'form';
            const schema = payload.requestedSchema || {};
            if (mode === 'url') {
                const url = String(payload.url || '');
                card.append(node('p', 'agent-chat-toolbox-ws-detail', url));
                const open = button('在系统浏览器打开', 'secondary');
                open.disabled = !/^https?:\/\//i.test(url);
                open.addEventListener('click', () => actions.openExternal(url));
                card.append(open);
            }
            const form = node('form', 'agent-chat-interaction-form');
            if (mode !== 'url') {
                const properties = Object.entries(schema.properties || {}).slice(0, 64);
                for (const [key, definition] of properties) {
                    const field = node('label', 'agent-chat-interaction-field');
                    field.append(node('span', '', definition.title || key));
                    let input;
                    if (Array.isArray(definition.enum)) {
                        input = document.createElement('select');
                        for (const value of definition.enum) {
                            const option = document.createElement('option');
                            option.value = value;
                            option.textContent = value;
                            input.append(option);
                        }
                    } else {
                        input = document.createElement('input');
                        input.type = definition.format === 'password' ? 'password'
                            : definition.type === 'boolean' ? 'checkbox'
                                : ['number', 'integer'].includes(definition.type) ? 'number' : 'text';
                    }
                    input.name = key;
                    if ((schema.required || []).includes(key)) input.required = true;
                    field.append(input);
                    form.append(field);
                }
                if (!properties.length) {
                    const field = node('label', 'agent-chat-interaction-field');
                    field.append(node('span', '', '结构化响应（JSON）'));
                    const raw = document.createElement('textarea');
                    raw.name = '__json';
                    raw.rows = 6;
                    raw.placeholder = '{}';
                    field.append(raw);
                    form.append(field);
                }
            }
            const controls = node('div', 'agent-chat-approval-actions');
            for (const [label, className, response] of [
                ['取消', 'danger', { action: 'cancel' }],
                ['拒绝', 'secondary', { action: 'decline' }],
            ]) {
                const control = button(label, className);
                control.type = 'button';
                control.addEventListener('click', () => actions.respondInteraction(interaction, response));
                controls.append(control);
            }
            const accept = button('接受', 'primary');
            accept.type = 'submit';
            controls.append(accept);
            form.append(controls);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                const content = {};
                for (const control of form.elements) {
                    if (!control.name) continue;
                    if (control.name === '__json') {
                        try { Object.assign(content, JSON.parse(control.value || '{}')); }
                        catch { actions.notifyInvalidJson(); return; }
                        continue;
                    }
                    content[control.name] = control.type === 'checkbox' ? control.checked
                        : control.type === 'number' ? Number(control.value) : control.value;
                }
                actions.respondInteraction(interaction, { action: 'accept', content });
            });
            card.append(form);
            return card;
        }
        card.append(node('p', 'agent-chat-muted', '该交互类型没有可用响应控件，保持 fail-closed。'));
        return card;
    }

    function build({ localApprovals, backendApprovals, interactions, existingInteractions }) {
        const content = node('div', 'agent-chat-approval-view');
        const pending = localApprovals.length + backendApprovals.length + interactions.length;
        if (!pending) {
            content.append(node('div', 'agent-chat-activity-empty', '没有待确认的审批。'));
            return content;
        }
        for (const approval of localApprovals) {
            content.append(blockPresentation.createApproval(approval, {
                onDecision: (item, decision) => {
                    registry.delete(item.approvalId);
                    actions.respondApproval(item, decision);
                },
                registry,
                ensureTicker: actions.ensureTicker,
            }));
        }
        for (const observation of backendApprovals) {
            content.append(blockPresentation.createToolboxObservation(observation));
        }
        for (const interaction of interactions) {
            content.append(existingInteractions.get(String(interaction.requestId)) || interactionCard(interaction));
        }
        return content;
    }

    return { build, dispose() {} };
}
