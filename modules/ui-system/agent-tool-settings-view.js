const CODEX_READONLY = new Set(['codex:view-image', 'codex:plan']);

function unique(values) {
    return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizePolicy(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        schemaVersion: 1,
        preset: ['full', 'readonly', 'custom'].includes(source.preset) ? source.preset : 'full',
        enabledCodexCapabilities: unique(source.enabledCodexCapabilities),
        enabledVcpTools: unique(source.enabledVcpTools),
    };
}

function readOnlyCommand(command) {
    const value = String(command || '').trim();
    return /^(list|read|search|find|get|query|inspect|view|stat|status|info|describe|lookup|check)/i.test(value)
        && !/(write|edit|append|apply|delete|remove|move|rename|copy|create|download|upload|execute|run|control|send|set|update)/i.test(value);
}

function enabled(policy, id, command = '') {
    if (policy.preset === 'full') return true;
    if (policy.preset === 'readonly') return id.startsWith('codex:') ? CODEX_READONLY.has(id) : readOnlyCommand(command);
    const source = id.startsWith('codex:') ? policy.enabledCodexCapabilities : policy.enabledVcpTools;
    return source.includes(id);
}

function materializeCustom(policy, catalog) {
    if (policy.preset === 'custom') return normalizePolicy(policy);
    const native = (catalog.native || []).filter((item) => enabled(policy, item.id)).map((item) => item.id);
    const vcp = (catalog.plugins || []).flatMap((plugin) => plugin.commands || [])
        .filter((command) => enabled(policy, command.id, command.command)).map((command) => command.id);
    return { schemaVersion: 1, preset: 'custom', enabledCodexCapabilities: native, enabledVcpTools: vcp };
}

function icon(context, name, className = '') {
    return context.node('span', `vcp-ui-icon ${className}`.trim(), name);
}

function toggle(context, checked, label, onChange) {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = `agent-tool-switch${checked ? ' is-on' : ''}`;
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-checked', String(checked));
    control.setAttribute('aria-label', label);
    control.append(context.node('span', 'agent-tool-switch-thumb'));
    control.addEventListener('click', (event) => {
        event.stopPropagation();
        onChange(!checked);
    });
    return control;
}

function toolRow(context, item, checked, onChange, compact = false) {
    const row = context.node('div', `agent-tool-row${compact ? ' is-compact' : ''}`);
    const copy = context.node('div', 'agent-tool-row-copy');
    if (!compact) copy.append(icon(context, item.icon || 'extension', 'agent-tool-row-icon'));
    const labels = context.node('div', 'agent-tool-row-labels');
    labels.append(context.node('strong', '', item.title || item.command || item.id));
    if (item.description) labels.append(context.node('span', '', item.description));
    copy.append(labels);
    row.append(copy, toggle(context, checked, `${item.title || item.command} ${checked ? '已开启' : '已关闭'}`, onChange));
    return row;
}

function pluginGroup(context, plugin, policy, savePolicy) {
    const group = context.node('section', 'agent-tool-plugin');
    const commandIds = (plugin.commands || []).map((command) => command.id);
    const enabledCount = (plugin.commands || []).filter((command) => enabled(policy, command.id, command.command)).length;
    const allEnabled = commandIds.length > 0 && enabledCount === commandIds.length;
    const head = context.node('div', 'agent-tool-plugin-head');
    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'agent-tool-plugin-disclosure';
    disclosure.setAttribute('aria-label', `展开 ${plugin.title}`);
    disclosure.setAttribute('aria-expanded', 'false');
    disclosure.append(icon(context, 'chevron_right'));
    const copy = context.node('div', 'agent-tool-row-copy');
    copy.append(icon(context, plugin.icon || 'extension', 'agent-tool-row-icon'));
    const labels = context.node('div', 'agent-tool-row-labels');
    labels.append(context.node('strong', '', plugin.title));
    labels.append(context.node('span', '', `${enabledCount}/${commandIds.length} 个命令可用`));
    copy.append(labels);
    head.append(disclosure, copy, toggle(context, allEnabled, `${plugin.title} 全部命令`, (next) => {
        const custom = materializeCustom(policy, context.catalog);
        const retained = custom.enabledVcpTools.filter((id) => !commandIds.includes(id));
        savePolicy({ ...custom, enabledVcpTools: next ? [...retained, ...commandIds] : retained });
    }));
    const commands = context.node('div', 'agent-tool-command-list');
    commands.hidden = true;
    for (const command of plugin.commands || []) {
        commands.append(toolRow(context, {
            ...command,
            title: command.command,
        }, enabled(policy, command.id, command.command), (next) => {
            const custom = materializeCustom(policy, context.catalog);
            const ids = new Set(custom.enabledVcpTools);
            if (next) ids.add(command.id); else ids.delete(command.id);
            savePolicy({ ...custom, enabledVcpTools: [...ids] });
        }, true));
    }
    disclosure.addEventListener('click', () => {
        commands.hidden = !commands.hidden;
        group.classList.toggle('is-open', !commands.hidden);
        disclosure.setAttribute('aria-expanded', String(!commands.hidden));
    });
    group.append(head, commands);
    return group;
}

export function renderAgentToolSettings(context, value, onChange) {
    const catalog = context.catalog || { native: [], plugins: [], presets: [] };
    const policy = normalizePolicy(value);
    const root = context.node('div', 'agent-tool-settings');
    const presets = context.node('div', 'agent-tool-presets');
    presets.setAttribute('role', 'radiogroup');
    for (const preset of catalog.presets || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `agent-tool-preset${policy.preset === preset.id ? ' is-active' : ''}`;
        button.textContent = preset.label;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(policy.preset === preset.id));
        button.addEventListener('click', () => onChange({ ...policy, preset: preset.id }));
        presets.append(button);
    }
    root.append(presets);

    if (context.loading) {
        root.append(context.node('p', 'agent-tool-loading', '正在读取可用工具...'));
        return root;
    }
    if (context.error) root.append(context.node('p', 'agent-tool-error', context.error));

    const nativeSection = context.node('section', 'agent-tool-category');
    nativeSection.append(context.node('h4', '', 'Codex 内置'));
    for (const item of catalog.native || []) {
        nativeSection.append(toolRow(context, item, enabled(policy, item.id), (next) => {
            const custom = materializeCustom(policy, catalog);
            const ids = new Set(custom.enabledCodexCapabilities);
            if (next) ids.add(item.id); else ids.delete(item.id);
            onChange({ ...custom, enabledCodexCapabilities: [...ids] });
        }));
    }
    root.append(nativeSection);

    const vcpSection = context.node('section', 'agent-tool-category');
    vcpSection.append(context.node('h4', '', 'VCP 插件'));
    for (const plugin of catalog.plugins || []) {
        vcpSection.append(pluginGroup({ ...context, catalog }, plugin, policy, onChange));
    }
    if (!(catalog.plugins || []).length) {
        vcpSection.append(context.node('p', 'agent-tool-loading', '没有发现已启用且可调用的 VCP 插件。'));
    }
    root.append(vcpSection);
    return root;
}

export { normalizePolicy as normalizeAgentToolPolicy };
