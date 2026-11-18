'use strict';

// V桌面接口目录（第一批）。
// 渲染端状态（挂件、Dock、样式自动化）经 desktopRemoteHandlers 的渲染端 RPC 读取；
// 落盘数据与系统指标直接复用已有的 ipcMain.handle 通道；
// 写操作复用 DesktopRemote 原有实现，两条路径行为一致。

const READ_BOTH = Object.freeze(['model', 'widget']);

// 与 Desktopmodules/builtinWidgets/vchatApps.js 的 VCHAT_APPS / SYSTEM_TOOLS 对齐；
// open-loom-app:<id> 是 Loom 生成的动态应用。
const VCHAT_APP_ACTIONS = Object.freeze([
    'show-main-window',
    'open-game-window',
    'open-notes-window',
    'open-memo-window',
    'open-forum-window',
    'open-rag-observer-window',
    'open-dice-window',
    'open-canvas-window',
    'open-translator-window',
    'open-music-window',
    'open-themes-window',
    'open-loom-manager',
    'launch-human-toolbox',
    'launch-vchat-manager',
    'open-system-tool:ms-settings:display',
    'open-system-tool:ms-settings:',
    'open-system-tool:control',
    'open-system-tool:shell:RecycleBinFolder',
    'open-system-tool:shell:MyComputerFolder',
]);
const LOOM_APP_PATTERN = /^open-loom-app:[\w.-]+$/;

function isAllowedAppAction(appAction) {
    return VCHAT_APP_ACTIONS.includes(appAction) || LOOM_APP_PATTERN.test(appAction);
}

const WIDGET_ID = Object.freeze({
    type: 'string',
    required: true,
    maxLength: 200,
    description: '桌面上的挂件 ID，可先用 desktop.state.query 查到。',
});

/** @param {{ bridge: object }} deps */
function createDesktopOperations() {
    return [
        {
            id: 'desktop.state.query',
            title: '查询桌面状态',
            description: '列出桌面画布上当前打开的挂件和快捷方式图标。已收藏的挂件会带上收藏名与持久化目录。桌面没开时 desktopOpen 为 false，列表为空。',
            access: 'read',
            callers: READ_BOTH,
            returns: '{ desktopOpen, widgets: [{ id, savedName?, savedId?, savedDir? }], icons: string[] }',
            async handler(_params, { bridge }) {
                const win = bridge.getDesktopWindow();
                if (!win || win.isDestroyed()) return { desktopOpen: false, widgets: [], icons: [] };
                const data = await bridge.queryDesktopRenderer('QueryDesktop');
                return { desktopOpen: true, widgets: data?.widgets || [], icons: data?.icons || [] };
            },
        },
        {
            id: 'desktop.dock.query',
            title: '查询 Dock 与可启动应用',
            description: '列出 Dock 里的快捷方式、VChat 内置应用、Windows 系统工具与内置挂件。需要桌面窗口已打开。',
            access: 'read',
            callers: READ_BOTH,
            returns: '{ dockItems, vchatApps, systemTools, builtinWidgets }',
            handler: (_params, { bridge }) => bridge.queryDesktopRenderer('QueryDock'),
        },
        {
            id: 'desktop.widget.source',
            title: '读取挂件源码',
            description: '返回桌面上某个挂件当前渲染的 HTML 源码，以及收藏信息。需要桌面窗口已打开。',
            access: 'read',
            callers: READ_BOTH,
            params: { widgetId: WIDGET_ID },
            returns: '{ widgetId, html, savedName, savedId }',
            handler: ({ widgetId }, { bridge }) => bridge.queryDesktopRenderer('ViewWidgetSource', { widgetId }),
        },
        {
            id: 'desktop.favorites.list',
            title: '列出收藏挂件',
            description: '列出 AppData/DesktopWidgets 下保存的挂件（收藏与随聊推送归档），加星的排在前面。不返回缩略图。',
            access: 'read',
            callers: READ_BOTH,
            returns: '{ widgets: [{ id, name, pinned, origin, createdAt, updatedAt, dir }] }',
            ipc: {
                channel: 'desktop-list-widgets',
                map: (data) => ({
                    widgets: (data?.widgets || []).map(({ thumbnail, ...rest }) => ({ ...rest, dir: `AppData/DesktopWidgets/${rest.id}` })),
                }),
            },
        },
        {
            id: 'desktop.layout.load',
            title: '读取桌面布局',
            description: '读取保存的桌面布局（挂件 savedId 与坐标、图标、全局设置）。从没保存过时返回 null。',
            access: 'read',
            callers: READ_BOTH,
            returns: 'layout.json 内容或 null',
            ipc: { channel: 'desktop-load-layout' },
        },
        {
            id: 'desktop.metrics.snapshot',
            title: '读取系统指标',
            description: '读取一次系统指标快照：cpu、memory、disk、network、gpu、battery、docker、sensors、processes。进程与 Docker 默认不采，需要时显式打开。',
            access: 'read',
            callers: READ_BOTH,
            params: {
                includeProcesses: { type: 'boolean', default: false, description: '是否附带进程列表。' },
                includeDocker: { type: 'boolean', default: false, description: '是否附带 Docker 容器。' },
                forceRefresh: { type: 'boolean', default: false, description: '跳过缓存重新采样。' },
            },
            returns: '各类指标对象，例如 cpu.usagePct、memory.usagePct、memory.usedBytes。',
            timeoutMs: 15000,
            ipc: { channel: 'desktop-metrics-get-snapshot', args: (params) => [params] },
        },
        {
            id: 'desktop.metrics.capabilities',
            title: '查询可用指标',
            description: '查询本机哪些指标可以采集，每类的状态为 supported / permission_denied / provider_missing / error / unsupported。',
            access: 'read',
            callers: READ_BOTH,
            ipc: { channel: 'desktop-metrics-get-capabilities' },
        },
        {
            id: 'desktop.style.status',
            title: '查询样式自动化状态',
            description: '查询“指标驱动全局样式”是否在运行，以及当前配置。需要桌面窗口已打开。',
            access: 'read',
            callers: READ_BOTH,
            handler: async (_params, { bridge }) => (await bridge.queryDesktopRenderer('GetStyleAutomationStatus'))?.status || null,
        },
        {
            id: 'desktop.widget.create',
            title: '创建挂件',
            description: '在桌面上创建一个挂件。传 htmlContent 创建自定义挂件，或传 builtinWidgetKey 创建内置监控挂件（cpu/memory/disk/network/gpu/battery/docker/sensors/processes）。桌面没开时会先打开。',
            access: 'write',
            callers: READ_BOTH,
            params: {
                htmlContent: { type: 'string', maxLength: 2000000, description: '挂件完整 HTML，可含 <style> 与 <script>。与 builtinWidgetKey 二选一。' },
                builtinWidgetKey: { type: 'string', enum: ['cpu', 'memory', 'disk', 'network', 'gpu', 'battery', 'docker', 'sensors', 'processes'], description: '内置监控挂件。与 htmlContent 二选一。' },
                widgetId: { type: 'string', maxLength: 200, description: '自定义挂件 ID，默认自动生成。' },
                x: { type: 'number', description: '左上角 X 坐标（像素），默认 100。' },
                y: { type: 'number', description: '左上角 Y 坐标（像素），默认 100。' },
                width: { type: 'number', min: 40, description: '初始宽度，默认 320。' },
                height: { type: 'number', min: 40, description: '初始高度，默认 200。' },
                autoSave: { type: 'boolean', default: false, description: '创建后自动收藏。' },
                saveName: { type: 'string', maxLength: 100, description: '收藏名称，autoSave 或 scriptCode 时使用。' },
                scriptCode: { type: 'string', maxLength: 2000000, description: '外部脚本源码，存为挂件目录下的 app.js 并强制收藏。' },
            },
            returns: '{ widgetId, x, y, width, height, savedId, savedName, savedDir, builtinWidgetKey, script, timedOut }',
            example: { htmlContent: '<div style="padding:16px">Hello</div>', x: 200, y: 120 },
            timeoutMs: 20000,
            handler: (params, { bridge }) => {
                if (!params.htmlContent && !params.builtinWidgetKey) {
                    const error = new Error('htmlContent 与 builtinWidgetKey 至少提供一个');
                    error.code = 'INVALID_PARAMS';
                    throw error;
                }
                return bridge.createWidget(params);
            },
        },
        {
            id: 'desktop.widget.remove',
            title: '关闭挂件',
            description: '从桌面上关闭一个挂件。只关闭画布上的实例，不删除收藏目录。',
            access: 'write',
            callers: READ_BOTH,
            params: { widgetId: WIDGET_ID },
            returns: '{ widgetId, removed }',
            handler: ({ widgetId }, { bridge }) => bridge.queryDesktopRenderer('RemoveWidget', { widgetId }),
        },
        {
            id: 'desktop.wallpaper.set',
            title: '设置壁纸',
            description: '设置桌面壁纸。来源可以是 http(s) 链接、file:/// 本地文件，或以 <!DOCTYPE / <html 开头的整段 HTML（存成文件作为动态壁纸）。类型按扩展名识别：图片、mp4/webm 视频、html。桌面没开时会先打开。',
            access: 'write',
            callers: READ_BOTH,
            params: {
                source: { type: 'string', required: true, maxLength: 2000000, description: '壁纸来源：URL、file:/// 路径或 HTML 文本。' },
            },
            returns: '{ type, source, filePath }',
            timeoutMs: 15000,
            async handler({ source }, { bridge }) {
                const config = await bridge.setWallpaper(source);
                return { type: config.type, source: config.source, filePath: config.filePath };
            },
        },
        {
            id: 'desktop.style.set',
            title: '设置样式自动化',
            description: '启用或更新“指标驱动全局样式”：按 intervalMs 读取系统指标，按 rules 映射到 --desktop- 开头的 CSS 变量或壁纸 blur/brightness/opacity。规则格式见 Desktopmodules/挂件运行时与远控参考.md 第四节。桌面没开时会先打开。',
            access: 'write',
            callers: READ_BOTH,
            params: {
                configPatch: { type: 'object', required: true, description: '配置补丁：enabled、intervalMs、metricsOptions、rules。' },
                persist: { type: 'boolean', default: false, description: '写入全局设置，开机读回。' },
            },
            returns: '样式自动化状态',
            timeoutMs: 15000,
            handler: async ({ configPatch, persist }, { bridge }) => (await bridge.queryDesktopRenderer('SetStyleAutomation', { configPatch, persist }, { open: true, timeoutMs: 8000 }))?.status || null,
        },
        {
            id: 'vchat.app.launch',
            title: '打开 VChat 应用',
            description: '打开一个 VChat 内置应用或系统工具窗口，例如笔记、音乐、论坛、画布、翻译、骰子、人类工具箱。可用的 appAction 见 desktop.dock.query 的 vchatApps 与 systemTools。',
            access: 'write',
            callers: READ_BOTH,
            params: {
                appAction: { type: 'string', required: true, maxLength: 120, description: `应用动作，例如 ${VCHAT_APP_ACTIONS.slice(0, 4).join('、')}，或 open-loom-app:<id>。` },
            },
            returns: '{ appId? }',
            timeoutMs: 15000,
            ipc: {
                channel: 'desktop-launch-vchat-app',
                args: ({ appAction }) => {
                    if (!isAllowedAppAction(appAction)) {
                        const error = new Error(`不支持的 appAction：${appAction}`);
                        error.code = 'INVALID_PARAMS';
                        throw error;
                    }
                    return [appAction];
                },
            },
        },
    ];
}

module.exports = { createDesktopOperations, VCHAT_APP_ACTIONS, isAllowedAppAction };
