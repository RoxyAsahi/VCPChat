'use strict';

const fs = require('fs');
const path = require('path');
const { CODEX_CAPABILITIES } = require('./tool-policy');

const NATIVE_TOOLS = Object.freeze([
    {
        id: CODEX_CAPABILITIES.SHELL,
        title: '终端命令',
        description: '运行项目命令、测试和构建任务',
        icon: 'terminal',
        category: '终端',
    },
    {
        id: CODEX_CAPABILITIES.WORKSPACE_WRITE,
        title: '编辑文件',
        description: '创建和修改工作目录中的文件',
        icon: 'edit_note',
        category: '文件',
    },
    {
        id: CODEX_CAPABILITIES.VIEW_IMAGE,
        title: '查看图片',
        description: '读取并检查本地图片内容',
        icon: 'image',
        category: '文件',
    },
    {
        id: CODEX_CAPABILITIES.PLAN,
        title: '任务计划',
        description: '维护任务步骤与完成状态',
        icon: 'checklist',
        category: '上下文',
    },
]);

function shortDescription(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function readPlugin(pluginRoot, entry) {
    const manifestPath = path.join(pluginRoot, entry.name, 'plugin-manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const commands = Array.isArray(manifest?.capabilities?.invocationCommands)
            ? manifest.capabilities.invocationCommands.map((command) => ({
                id: `vcp:${manifest.name || entry.name}:${String(command?.command || '').trim()}`,
                command: String(command?.command || '').trim(),
                description: shortDescription(command?.description),
            })).filter((command) => command.command)
            : [];
        if (!commands.length) return null;
        return {
            id: `vcp:${manifest.name || entry.name}`,
            pluginId: String(manifest.name || entry.name),
            title: String(manifest.displayName || manifest.name || entry.name),
            description: shortDescription(manifest.description),
            icon: 'extension',
            category: 'VCP 插件',
            commands,
        };
    } catch {
        return null;
    }
}

function listAgentToolCatalog(projectRoot) {
    const pluginRoot = path.join(projectRoot, 'VCPDistributedServer', 'Plugin');
    const plugins = fs.existsSync(pluginRoot)
        ? fs.readdirSync(pluginRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => readPlugin(pluginRoot, entry))
            .filter(Boolean)
            .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
        : [];
    return {
        schemaVersion: 1,
        presets: [
            { id: 'full', label: '全部开启' },
            { id: 'readonly', label: '只读' },
            { id: 'custom', label: '自定义' },
        ],
        native: NATIVE_TOOLS.map((entry) => ({ ...entry })),
        plugins,
    };
}

module.exports = { listAgentToolCatalog, NATIVE_TOOLS };
