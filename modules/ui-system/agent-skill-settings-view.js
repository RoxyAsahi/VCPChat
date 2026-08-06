function normalizeSkillPolicy(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        schemaVersion: 1,
        preset: ['all', 'custom'].includes(source.preset) ? source.preset : 'all',
        enabledSkillIds: [...new Set((source.enabledSkillIds || []).map(String).filter(Boolean))],
    };
}

function skillEnabled(policy, skill) {
    return skill.enabledByCodex !== false
        && (policy.preset === 'all' || policy.enabledSkillIds.includes(skill.id));
}

function skillToggle(context, checked, disabled, label, onChange) {
    const control = context.document.createElement('button');
    control.type = 'button';
    control.className = `agent-tool-switch${checked ? ' is-on' : ''}`;
    control.disabled = disabled;
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-checked', String(checked));
    control.setAttribute('aria-label', label);
    control.append(context.node('span', 'agent-tool-switch-thumb'));
    control.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!disabled) onChange(!checked);
    });
    return control;
}

function emptyState(context, iconName, title, detail) {
    const root = context.node('div', 'agent-skill-empty');
    root.append(context.node('span', 'vcp-ui-icon', iconName));
    const copy = context.node('div', '');
    copy.append(context.node('strong', '', title), context.node('span', '', detail));
    root.append(copy);
    return root;
}

function renderDetail(context, state) {
    const root = context.node('aside', 'agent-skill-detail');
    if (state.detailLoading) {
        root.append(emptyState(context, 'progress_activity', '正在读取技能', '正在加载 SKILL.md 预览。'));
        return root;
    }
    if (state.detailError) {
        root.append(emptyState(context, 'error', '技能读取失败', state.detailError));
        return root;
    }
    const detail = state.detail;
    if (!detail) {
        root.append(emptyState(context, 'school', '选择一个技能', '查看说明、来源和 SKILL.md 内容。'));
        return root;
    }
    const header = context.node('div', 'agent-skill-detail-head');
    const labels = context.node('div', '');
    labels.append(context.node('strong', '', detail.displayName || detail.name));
    labels.append(context.node('code', '', `$${detail.name}`));
    header.append(labels, context.node('span', 'agent-skill-scope', detail.sourceLabel || detail.scope));
    const description = context.node('p', 'agent-skill-detail-description',
        detail.description || detail.shortDescription || '这个技能没有提供说明。');
    const preview = context.document.createElement('pre');
    preview.className = 'agent-skill-preview';
    preview.textContent = detail.content || '';
    root.append(header, description, preview);
    if (detail.truncated) root.append(context.node('p', 'agent-skill-truncated', '内容较长，当前仅显示前 96 KB。'));
    return root;
}

export function renderAgentSkillSettings(context, state, policyValue, actions) {
    const policy = normalizeSkillPolicy(policyValue);
    const root = context.node('div', 'agent-skill-settings');
    const toolbar = context.node('div', 'agent-skill-toolbar');
    const searchWrap = context.node('label', 'agent-skill-search');
    searchWrap.append(context.node('span', 'vcp-ui-icon', 'search'));
    const search = context.document.createElement('input');
    search.type = 'search';
    search.placeholder = '搜索技能';
    search.value = state.query || '';
    search.setAttribute('aria-label', '搜索技能');
    search.addEventListener('input', () => actions.setQuery(search.value));
    searchWrap.append(search);
    const refresh = context.document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'agent-tool-schema-refresh';
    refresh.title = '重新扫描技能';
    refresh.setAttribute('aria-label', '重新扫描技能');
    refresh.append(context.node('span', 'vcp-ui-icon', 'refresh'));
    refresh.addEventListener('click', () => actions.refresh());
    toolbar.append(searchWrap, refresh);
    root.append(toolbar);

    if (state.loading) {
        root.append(emptyState(context, 'progress_activity', '正在发现技能', 'Codex 正在扫描当前工作目录和用户技能目录。'));
        return root;
    }
    if (state.error) {
        root.append(emptyState(context, 'error', '技能列表加载失败', state.error));
        return root;
    }
    const skills = Array.isArray(state.catalog?.skills) ? state.catalog.skills : [];
    const query = String(state.query || '').trim().toLowerCase();
    const filtered = skills.filter((skill) => !query || [skill.name, skill.displayName, skill.description]
        .some((value) => String(value || '').toLowerCase().includes(query)));
    if (!skills.length) {
        root.append(emptyState(context, 'school', '没有发现技能', '在 Codex 用户技能目录或当前项目中安装含 SKILL.md 的技能。'));
        return root;
    }

    const body = context.node('div', 'agent-skill-body');
    const list = context.node('div', 'agent-skill-list');
    if (!filtered.length) list.append(emptyState(context, 'search_off', '没有匹配结果', '换一个名称或说明关键词。'));
    for (const skill of filtered) {
        const checked = skillEnabled(policy, skill);
        const row = context.document.createElement('button');
        row.type = 'button';
        row.className = `agent-skill-row${state.selectedId === skill.id ? ' is-selected' : ''}`;
        const icon = context.node('span', 'vcp-ui-icon agent-skill-row-icon', 'school');
        const labels = context.node('div', 'agent-skill-row-labels');
        const title = context.node('div', 'agent-skill-row-title');
        title.append(context.node('strong', '', skill.displayName || skill.name),
            context.node('code', '', `$${skill.name}`));
        labels.append(title, context.node('span', '', skill.shortDescription || skill.description || '无说明'));
        const toggle = skillToggle(context, checked, skill.enabledByCodex === false,
            `${skill.displayName || skill.name} ${checked ? '已开启' : '已关闭'}`,
            (next) => actions.toggle(skill.id, next));
        row.append(icon, labels, toggle);
        row.addEventListener('click', () => actions.select(skill.id));
        list.append(row);
    }
    body.append(list, renderDetail(context, state));
    root.append(body);
    return root;
}

export { normalizeSkillPolicy };
