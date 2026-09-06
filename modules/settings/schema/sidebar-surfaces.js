// Settings sidebar schema and renderer.
//
// The settings managers own business state and persistence. This module owns
// the DOM contract: every field has a descriptor, every view is rendered from
// a descriptor, and dynamic business modules receive stable ids/slots.

const SVG_TOGGLE = '<svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>';

const field = (id, type, label, options = {}) => Object.freeze({
    id,
    type,
    label,
    ...options,
});

const agentFields = Object.freeze([
    field('agentNameInput', 'text', 'Agent 名称', { name: 'name', required: true, tooltip: '列表和聊天中显示的助手名称。', validation: { required: true } }),
    field('agentModel', 'text', 'Agent 模型', { name: 'model', placeholder: '例如 gemini-2.5-flash-preview-05-20', tooltip: '留空时使用服务端默认模型。' }),
    field('agentTemperature', 'number', 'Temperature (0-2)', { name: 'temperature', min: 0, max: 2, step: 0.1, validation: { min: 0, max: 2 } }),
    field('agentContextTokenLimit', 'number', '上下文Token上限', { name: 'contextTokenLimit', min: 0, step: 100, validation: { min: 0 } }),
    field('agentMaxOutputTokens', 'number', '最大输出Token上限', { name: 'maxOutputTokens', min: 0, step: 50, validation: { min: 0 } }),
    field('agentTopP', 'number', 'Top P (0-2)', { name: 'top_p', min: 0, max: 2, step: 0.05, validation: { min: 0, max: 2 } }),
    field('agentTopK', 'number', 'Top K (0-64)', { name: 'top_k', min: 0, max: 64, step: 1, validation: { min: 0, max: 64 } }),
    field('agentTtsVoicePrimary', 'select', '主语言音色 / MiMo 模式', { name: 'ttsVoicePrimary', options: [['', '不使用语音']], tooltip: '主语言的音色或网络语音模式。' }),
    field('agentTtsRegexPrimary', 'text', '主语言正则 (留空则匹配全部)', { name: 'ttsRegexPrimary', placeholder: '例如 [^\\[\\]]+', tooltip: '用于匹配需要使用主语言音色的文本。' }),
    field('agentTtsVoiceSecondary', 'select', '副语言音色 / MiMo 模式', { name: 'ttsVoiceSecondary', options: [['', '不使用']], tooltip: '可选的副语言音色。' }),
    field('agentTtsRegexSecondary', 'text', '副语言正则', { name: 'ttsRegexSecondary', placeholder: '例如 \\[(.*?)\\]', tooltip: '用于匹配需要使用副语言音色的文本。' }),
    field('agentTtsSpeed', 'range', '语速', { name: 'ttsSpeed', min: 0.5, max: 2, step: 0.1, value: 1, validation: { min: 0.5, max: 2 } }),
    field('agentCustomCss', 'textarea', '列表项自定义CSS', { name: 'customCss', rows: 3, tooltip: '应用于助手列表项容器。' }),
    field('agentCardCss', 'textarea', '名片样式CSS', { name: 'cardCss', rows: 3, tooltip: '应用于设置页中的头像和名称区域。' }),
    field('agentChatCss', 'textarea', '会话样式CSS', { name: 'chatCss', rows: 4, tooltip: '应用于聊天中的助手头像和名称。' }),
]);

const groupFields = Object.freeze([
    field('groupNameInput', 'text', '群组名称', { required: true, tooltip: '列表和聊天中显示的群组名称。', validation: { required: true } }),
    field('groupChatMode', 'select', '群聊模式', { options: [['sequential', '顺序发言'], ['naturerandom', '自然随机'], ['invite_only', '邀请发言']], tooltip: '决定群组如何选择下一位发言者。' }),
    field('tagMatchMode', 'select', 'Tag 触发模式', { options: [['strict', '严格模式'], ['natural', '自然模式']], tooltip: '自然随机模式下的 Tag 匹配方式。', dependsOn: { field: 'groupChatMode', equals: 'naturerandom' } }),
    field('groupUnifiedModelInput', 'text', '群组统一模型', { placeholder: '选择群组统一模型', tooltip: '启用统一模型后，群组成员共享此模型。', dependsOn: { field: 'groupUseUnifiedModel', equals: true } }),
    field('groupPrompt', 'textarea', 'GroupPrompt', { rows: 4, tooltip: '注入群聊上下文的系统提示词。' }),
    field('invitePrompt', 'textarea', 'InvitePrompt', { rows: 4, tooltip: '邀请某个成员发言时使用的提示词。' }),
]);

export const settingsSidebarSchema = Object.freeze({
    version: 1,
    agent: Object.freeze({
        sections: Object.freeze(['identity', 'prompt', 'model', 'params', 'tts']),
        fields: agentFields,
    }),
    group: Object.freeze({
        sections: Object.freeze(['identity', 'mode', 'model', 'prompt']),
        fields: groupFields,
    }),
});

function setAttributes(node, attributes = {}) {
    Object.entries(attributes).forEach(([name, value]) => {
        if (value === undefined || value === null || value === false) return;
        node.setAttribute(name, value === true ? '' : String(value));
    });
    return node;
}

function el(doc, tag, attributes = {}, ...children) {
    const node = setAttributes(doc.createElement(tag), attributes);
    children.flat(Infinity).forEach(child => {
        if (child === null || child === undefined || child === false) return;
        node.append(child.nodeType ? child : doc.createTextNode(String(child)));
    });
    return node;
}

function buildCameraIcon(doc) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    setAttributes(svg, {
        class: 'avatar-upload-icon',
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'aria-hidden': 'true',
    });
    svg.append(
        el(doc, 'path', { d: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z' }),
        el(doc, 'circle', { cx: '12', cy: '13', r: '4' }),
    );
    return svg;
}

function labelFor(doc, spec) {
    return el(doc, 'label', { for: spec.id }, spec.label);
}

function renderControl(doc, spec) {
    const attributes = { id: spec.id, name: spec.name, type: spec.type, placeholder: spec.placeholder,
        required: spec.required, min: spec.min, max: spec.max, step: spec.step, rows: spec.rows };
    if (spec.type === 'select') {
        const select = el(doc, 'select', { id: spec.id, name: spec.name });
        (spec.options || []).forEach(([value, text]) => select.append(el(doc, 'option', { value }, text)));
        return select;
    }
    if (spec.type === 'textarea') return el(doc, 'textarea', attributes);
    return el(doc, 'input', attributes);
}

function renderField(doc, spec, className = 'settings-schema-field') {
    const row = el(doc, 'div', { class: className, 'data-schema-field': spec.id });
    const control = renderControl(doc, spec);
    if (spec.tooltip) {
        control.title = spec.tooltip;
        row.dataset.schemaTooltip = spec.tooltip;
    }
    if (spec.validation) row.dataset.schemaValidation = JSON.stringify(spec.validation);
    if (spec.dependsOn) row.dataset.schemaDependsOn = JSON.stringify(spec.dependsOn);
    row.append(labelFor(doc, spec), control);
    return row;
}

function renderSection(doc, { kind, key, title, summaryId, content }) {
    const prefix = kind === 'agent' ? 'agent' : 'group';
    const section = el(doc, 'section', {
        class: `${prefix}-settings-collapsible-container ${prefix}-settings-section collapsed`,
        'data-section-key': key,
        'data-schema-section': key,
    });
    const header = el(doc, 'div', {
        class: `${prefix}-settings-section-header`,
        id: `${kind === 'agent' ? '' : 'group'}${key[0].toUpperCase()}${key.slice(1)}ToggleHeader`,
        role: 'button',
        tabindex: '0',
        'aria-expanded': 'false',
    });
    const summary = el(doc, 'div', { class: `${prefix}-settings-section-summary`, id: summaryId });
    const toggle = el(doc, 'button', {
        type: 'button',
        class: `${prefix}-settings-toggle-btn`,
        id: `${kind === 'agent' ? '' : 'group'}${key[0].toUpperCase()}${key.slice(1)}ToggleBtn`,
        'aria-label': `展开或收起${title}`,
        'aria-expanded': 'false',
    });
    toggle.innerHTML = SVG_TOGGLE;
    const titleChildren = [el(doc, 'span', { class: `${prefix}-settings-section-title` }, title)];
    if (kind === 'agent' && key === 'prompt') {
        const helpBadge = el(doc, 'button', {
            type: 'button',
            class: 'vcp-settings-info-badge',
            'aria-label': '提示说明',
            'data-tooltip': '三个模块独立编辑后，注意保存以生效。支持文本、模块与预制三种模式切换。',
            title: '三个模块独立编辑后，注意保存以生效。支持文本、模块与预制三种模式切换。',
        }, '?');
        helpBadge.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
        });
        titleChildren.push(helpBadge);
    }
    const titleRow = el(doc, 'div', { class: `${prefix}-settings-section-title-row` }, titleChildren);
    header.append(titleRow, summary, toggle);
    const contentNode = el(doc, 'div', { class: `${prefix}-settings-section-content`, id: `${kind === 'agent' ? '' : 'group'}${key[0].toUpperCase()}${key.slice(1)}Content` });
    contentNode.append(content(doc));
    section.append(header, contentNode);
    return section;
}

function renderAgentIdentity(doc) {
    const avatar = el(doc, 'div', { class: 'agent-avatar-wrapper' },
        el(doc, 'img', { id: 'agentAvatarPreview', src: 'assets/default_avatar.png', alt: '头像预览', class: 'agent-avatar-display', width: 76, height: 76 }),
        el(doc, 'label', { for: 'agentAvatarInput', class: 'avatar-upload-overlay', 'aria-label': '更换头像' }, buildCameraIcon(doc)),
        el(doc, 'input', { id: 'agentAvatarInput', name: 'avatar', type: 'file', accept: 'image/png, image/jpeg, image/gif', hidden: true }));
    const identityMain = el(doc, 'div', { class: 'agent-identity-main' }, avatar, renderField(doc, agentFields[0], 'agent-name-wrapper'));
    const style = el(doc, 'div', { class: 'agent-style-collapsible-container collapsed', 'data-schema-section': 'style' });
    const styleHeader = el(doc, 'div', { class: 'style-collapse-header', id: 'styleCollapseHeader', role: 'button', tabindex: '0' },
        el(doc, 'span', { class: 'style-collapse-icon' }, '>'), el(doc, 'span', { class: 'style-collapse-title' }, '自定义样式设置'));
    const controls = el(doc, 'div', { class: 'agent-style-controls' });
    [['disableCustomColors', '助手页面中使用主题默认颜色'], ['useThemeColorsInChat', '会话界面中使用主题默认颜色']].forEach(([id, text]) => {
        const checkbox = el(doc, 'input', { id, type: 'checkbox', name: id });
        controls.append(el(doc, 'div', { class: 'style-control-item full-width' },
            el(doc, 'div', { class: 'form-group-inline style-toggle-row' },
                el(doc, 'label', { for: id }, text),
                el(doc, 'label', { class: 'switch', for: id, 'aria-label': text }, checkbox, el(doc, 'span', { class: 'slider round' })))));
    });
    const colorPair = (id, text, value, name) => el(doc, 'div', { class: 'style-control-item' },
        el(doc, 'label', { for: id }, text), el(doc, 'div', { class: 'color-input-group' },
            el(doc, 'input', { id, type: 'color', name, value }),
            el(doc, 'input', { id: `${id}Text`, type: 'text', placeholder: value, 'aria-label': `${text}十六进制值`, maxlength: 7 })));
    controls.append(colorPair('agentAvatarBorderColor', '头像外框颜色:', '#3d5a80', 'avatarBorderColor'), colorPair('agentNameTextColor', '名称文字颜色:', '#ffffff', 'nameTextColor'));
    controls.append(el(doc, 'div', { class: 'style-control-item full-width' }, el(doc, 'button', { type: 'button', id: 'resetAvatarColorsBtn', class: 'reset-colors-btn' }, '重置为头像默认颜色')));
    const customCss = renderField(doc, agentFields[12]);
    customCss.append(el(doc, 'small', { class: 'settings-schema-hint' }, '提示：此 CSS 将应用于助手列表项容器。'));
    const cardCss = renderField(doc, agentFields[13]);
    cardCss.append(el(doc, 'small', { class: 'settings-schema-hint' }, '提示：此 CSS 将应用于设置页面中的 Agent 名片区域。'));
    const chatCss = renderField(doc, agentFields[14]);
    chatCss.append(el(doc, 'small', { class: 'settings-schema-hint' }, '提示：此 CSS 将应用于聊天中的 Agent 头像和名称。'));
    controls.append(customCss, cardCss, chatCss);
    style.append(styleHeader, controls);
    return el(doc, 'div', { class: 'agent-identity-container' }, identityMain, style);
}

function renderAgentParams(doc) {
    const content = el(doc, 'div', { class: 'params-content', id: 'paramsContent' });
    agentFields.slice(2, 7).forEach(spec => content.append(renderField(doc, spec)));
    const stream = el(doc, 'div', { class: 'form-group-inline agent-stream-mode-group' },
        el(doc, 'span', { class: 'agent-stream-mode-title' }, '输出模式:'),
        el(doc, 'label', { class: 'agent-stream-mode-option', for: 'agentStreamOutputTrue' }, el(doc, 'input', { id: 'agentStreamOutputTrue', type: 'radio', name: 'streamOutput', value: 'true', checked: true }), '流式'),
        el(doc, 'label', { class: 'agent-stream-mode-option', for: 'agentStreamOutputFalse' }, el(doc, 'input', { id: 'agentStreamOutputFalse', type: 'radio', name: 'streamOutput', value: 'false' }), '非流式'));
    content.append(stream);
    return el(doc, 'div', { class: 'agent-settings-card-shell' }, content);
}

function renderAgentTts(doc) {
    const content = el(doc, 'div', { class: 'params-content', id: 'ttsContent' });
    const selectRow = (spec, button) => el(doc, 'div', { 'data-schema-field': spec.id }, labelFor(doc, spec), el(doc, 'div', { class: 'model-input-container' }, renderControl(doc, spec), button));
    const refresh = el(doc, 'button', { type: 'button', id: 'refreshTtsModelsBtn', class: 'small-button', title: '刷新模型列表', 'aria-label': '刷新模型列表' },
        el(doc, 'span', { class: 'vcp-ui-icon', 'aria-hidden': 'true' }, 'refresh'));
    content.append(selectRow(agentFields[7], refresh), renderField(doc, agentFields[8]), selectRow(agentFields[9]), renderField(doc, agentFields[10]));
    const speed = renderField(doc, agentFields[11]);
    const speedInput = speed.querySelector('input');
    speedInput?.setAttribute('value', '1.0');
    const speedControl = el(doc, 'div', { class: 'slider-container' });
    speedControl.append(speedInput);
    speedControl.append(el(doc, 'span', { id: 'ttsSpeedValue' }, '1.0'));
    speed.append(speedControl, el(doc, 'small', { class: 'settings-schema-hint', 'data-vcp-style': '4' }, '本地 SoVITS 使用该语速；网络模式按模型原生节奏合成，可用下方自然语言提示词描述语速。'));
    content.append(speed);
    const composer = el(doc, 'div', { class: 'settings-form-group tts-director-settings' },
        el(doc, 'div', { class: 'tts-director-heading' },
            el(doc, 'label', { for: 'agentTtsDirectorPromptInput' }, 'MiMo 导演提示词:'),
            el(doc, 'button', { type: 'button', id: 'fillAgentTtsDirectorTemplateBtn', class: 'tts-director-template-button', title: '填入角色、场景和指导模板' }, '导演模板')),
        el(doc, 'div', { class: 'tts-director-composer' },
            el(doc, 'textarea', { id: 'agentTtsDirectorPromptInput', class: 'tts-director-editor tts-director-editor-new', rows: 1, placeholder: '描述角色、场景与演绎指导 (Ctrl+Enter 添加)' }),
            el(doc, 'button', { type: 'button', id: 'addAgentTtsDirectorPromptBtn', class: 'small-button tts-director-action-button', title: '添加导演提示词', 'aria-label': '添加导演提示词' }, '+')),
        el(doc, 'div', { id: 'agentTtsDirectorPromptsContainer', class: 'tts-director-prompts-container' }),
        el(doc, 'small', { class: 'tts-director-help' }, '适用于网络模式；本地 SoVITS 会忽略这些提示词。Ctrl+Enter 添加，右侧 − 删除。'));
    content.append(composer);
    return el(doc, 'div', { class: 'agent-settings-card-shell' }, content);
}

export function renderAgentSettingsSurface(host, doc = host?.ownerDocument || document) {
    if (!host || !doc) return null;
    host.replaceChildren();
    host.dataset.settingsView = 'agent';
    host.classList.add('settings-sidebar-surface-view', 'vcp-settings-schema-surface');
    const title = el(doc, 'h3', { id: 'agentSettingsContainerTitle' }, '助手设置: ', el(doc, 'span', { id: 'selectedAgentNameForSettings' }));
    const form = el(doc, 'form', { id: 'agentSettingsForm', novalidate: true });
    form.append(el(doc, 'input', { type: 'hidden', id: 'editingAgentId', name: 'agentId' }));
    form.append(renderSection(doc, { kind: 'agent', key: 'identity', title: '基础信息', summaryId: 'identitySummary', content: renderAgentIdentity }));
    form.append(renderSection(doc, { kind: 'agent', key: 'prompt', title: '系统提示词', summaryId: 'promptSummary', content: d => el(d, 'div', { class: 'agent-settings-card-shell agent-settings-prompt-shell' }, el(d, 'div', { class: 'prompt-section-note' }, '三个模块独立编辑后，注意保存以生效'), el(d, 'div', { id: 'systemPromptContainer', class: 'system-prompt-container' })) }));
    form.append(renderSection(doc, { kind: 'agent', key: 'model', title: '模型设置', summaryId: 'modelSummary', content: d => el(d, 'div', { class: 'agent-settings-card-shell agent-settings-model-shell' }, el(d, 'div', { class: 'model-input-container' }, renderControl(d, agentFields[1]), el(d, 'button', { type: 'button', id: 'openModelSelectBtn', class: 'small-button', title: '选择模型', 'aria-label': '选择模型' }, '选择'))) }));
    form.append(renderSection(doc, { kind: 'agent', key: 'params', title: '模型参数配置', summaryId: 'paramsSummary', content: renderAgentParams }));
    form.append(renderSection(doc, { kind: 'agent', key: 'tts', title: '语音设置 (本地 SoVITS / 网络 MiMo)', summaryId: 'ttsSummary', content: renderAgentTts }));
    form.append(el(doc, 'div', { class: 'form-actions' }, el(doc, 'button', { type: 'submit' }, '保存Agent设置'), el(doc, 'div', { class: 'delete-button-container' }, el(doc, 'button', { type: 'button', id: 'deleteAgentBtn', class: 'danger-button' }, '删除此Agent'))));
    host.append(title, form);
    return form;
}

function renderGroupSectionContent(doc, key) {
    if (key === 'identity') {
        return el(doc, 'div', { class: 'group-settings-identity-shell' },
            el(doc, 'div', { class: 'agent-identity-main group-identity-main' },
                el(doc, 'div', { class: 'agent-avatar-wrapper group-avatar-wrapper' }, el(doc, 'img', { id: 'groupAvatarPreview', src: 'assets/default_group_avatar.png', alt: '群组头像预览', class: 'agent-avatar-display group-avatar-display', width: 76, height: 76 }), el(doc, 'label', { for: 'groupAvatarInput', class: 'avatar-upload-overlay', 'aria-label': '更换群组头像' }, buildCameraIcon(doc)), el(doc, 'input', { id: 'groupAvatarInput', type: 'file', accept: 'image/*', hidden: true })),
                renderField(doc, groupFields[0], 'agent-name-wrapper group-name-wrapper')),
            el(doc, 'div', { class: 'group-settings-field-shell' }, el(doc, 'label', { for: 'groupMembersList' }, '群组成员'), el(doc, 'div', { id: 'groupMembersList', class: 'group-members-list-container' })));
    }
    if (key === 'mode') {
        const mode = renderField(doc, groupFields[1], 'group-settings-field-shell');
        const tags = renderField(doc, groupFields[2], 'group-settings-field-shell');
        tags.append(el(doc, 'div', { class: 'group-settings-helper-text' }, '自然模式会区分 Tag 来源，尽量避免 Agent 因引用自身历史发言而重复触发。'), el(doc, 'div', { class: 'group-settings-field-shell group-member-tags-shell' }, el(doc, 'label', { class: 'group-settings-field-label', for: 'memberTagsInputs' }, '成员 Tags'), el(doc, 'div', { id: 'memberTagsInputs' })));
        return el(doc, 'div', { class: 'group-settings-card-shell' }, mode, el(doc, 'div', { id: 'sequentialOrderContainer', class: 'group-settings-field-shell', hidden: true }, el(doc, 'label', { class: 'group-settings-field-label', for: 'sequentialSpeakerOrderList' }, '顺序发言次序'), el(doc, 'div', { class: 'group-settings-helper-text' }, '拖拽成员调整发言顺序。新加入且尚未排序的成员会自动追加到末尾。'), el(doc, 'div', { id: 'sequentialSpeakerOrderList', class: 'sequential-speaker-order-list', role: 'list', 'aria-label': '顺序发言次序' })), el(doc, 'div', { id: 'memberTagsContainer', class: 'group-settings-field-shell', hidden: true }, tags));
    }
    if (key === 'model') {
        return el(doc, 'div', { class: 'group-settings-card-shell group-settings-model-shell' }, el(doc, 'div', { class: 'group-settings-switch-row' }, el(doc, 'label', { for: 'groupUseUnifiedModel' }, '启用群组统一模型'), el(doc, 'label', { class: 'switch', for: 'groupUseUnifiedModel', 'aria-label': '启用群组统一模型' }, el(doc, 'input', { id: 'groupUseUnifiedModel', type: 'checkbox' }), el(doc, 'span', { class: 'slider round' }))), el(doc, 'div', { id: 'groupUnifiedModelContainer', class: 'group-settings-field-shell', hidden: true, 'data-schema-field': groupFields[3].id }, el(doc, 'div', { class: 'model-input-container' }, renderControl(doc, groupFields[3]), el(doc, 'button', { type: 'button', id: 'openGroupModelSelectBtn', title: '选择模型', 'aria-label': '打开模型选择器' }, '选择'))));
    }
    const groupPrompt = renderField(doc, groupFields[4]);
    groupPrompt.querySelector('textarea')?.setAttribute('placeholder', '例如：这里是用户家的聊天空间，成员应保持协作与角色分工。');
    const invitePrompt = renderField(doc, groupFields[5]);
    invitePrompt.querySelector('textarea')?.setAttribute('placeholder', '例如：现在轮到 {{VCPChatAgentName}} 发言了。');
    invitePrompt.append(el(doc, 'small', { class: 'group-settings-helper-text' }, '可使用 {{VCPChatAgentName}} 作为被邀请发言的 Agent 名称占位符。'));
    return el(doc, 'div', { class: 'group-settings-card-shell group-settings-prompt-shell' }, groupPrompt, invitePrompt);
}

export function renderGroupSettingsSurface(host, doc = host?.ownerDocument || document) {
    if (!host || !doc) return null;
    host.replaceChildren();
    host.dataset.settingsView = 'group';
    host.classList.add('settings-sidebar-surface-view', 'vcp-settings-schema-surface');
    const form = el(doc, 'form', { id: 'groupSettingsForm' });
    form.append(el(doc, 'input', { type: 'hidden', id: 'editingGroupId' }));
    [['identity', '基础信息', 'groupIdentitySummary'], ['mode', '群聊模式', 'groupModeSummary'], ['model', '模型设置', 'groupModelSummary'], ['prompt', '系统提示词', 'groupPromptSummary']].forEach(([key, title, summaryId]) => form.append(renderSection(doc, { kind: 'group', key, title, summaryId, content: d => renderGroupSectionContent(d, key) })));
    form.append(el(doc, 'div', { class: 'form-actions' }, el(doc, 'button', { type: 'submit' }, '保存群组设置'), el(doc, 'div', { class: 'delete-button-container' }, el(doc, 'button', { type: 'button', id: 'deleteGroupBtn', class: 'danger-button' }, '删除此群组'))));
    host.append(form);
    return form;
}

export function renderGroupSettingsMarkup(doc = globalThis.document) {
    const host = doc.createElement('div');
    renderGroupSettingsSurface(host, doc);
    return host.innerHTML;
}

export function getSchemaField(kind, id) {
    return settingsSidebarSchema[kind]?.fields.find(entry => entry.id === id) || null;
}

if (globalThis.window) {
    globalThis.window.VCPSettingsSchema = Object.freeze({
        settingsSidebarSchema,
        renderAgentSettingsSurface,
        renderGroupSettingsSurface,
        renderGroupSettingsMarkup,
        getSchemaField,
    });
}
