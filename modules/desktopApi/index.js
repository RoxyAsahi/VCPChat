'use strict';

// 声明式 API 的进程内单例：把接口目录、现有 IPC handler 索引和桌面桥接接在一起。
// 调用入口：
//   - AI：DesktopRemote 插件的 ListAPIs / DescribeAPI / CallAPI（modules/ipc/desktopRemoteHandlers.js）
//   - 桌面挂件：vcpAPI.apis() / describe() / call()，经 desktop-api:* 通道（registerIpc）
// 新增接口：在 operations/ 下加定义，并在 createDesktopApi 里登记。

const { createDesktopApiRegistry } = require('./registry');
const ipcHandlerIndex = require('./ipcHandlerIndex');
const { createDesktopOperations } = require('./operations/desktop');

const { CHANNELS } = require('../ipc/ipcContracts');

const IPC_CHANNELS = Object.freeze({
    LIST: CHANNELS.DESKTOP_API_LIST,
    DESCRIBE: CHANNELS.DESKTOP_API_DESCRIBE,
    CALL: CHANNELS.DESKTOP_API_CALL,
});

let instance = null;

function createDesktopApi({ bridge, invokeIpc, logger = console } = {}) {
    const registry = createDesktopApiRegistry({ invokeIpc, context: { bridge }, logger });
    registry.defineAll(createDesktopOperations());
    return registry;
}

function getDesktopApi() {
    if (!instance) {
        const { desktopBridge } = require('../ipc/desktopRemoteHandlers');
        instance = createDesktopApi({
            bridge: desktopBridge,
            invokeIpc: (channel, args) => {
                const win = desktopBridge.getDesktopWindow();
                const sender = win && !win.isDestroyed() ? win.webContents : null;
                return ipcHandlerIndex.invoke(channel, args, { sender });
            },
        });
    }
    return instance;
}

/**
 * 给桌面窗口注册 desktop-api:* 通道。只认桌面窗口自己的调用，调用方身份固定为 widget。
 * @param {{ ipcMain: object, getDesktopWindow: () => any }} deps
 */
function registerIpc({ ipcMain, getDesktopWindow }) {
    const fromDesktop = (event) => {
        const win = getDesktopWindow();
        return Boolean(win && !win.isDestroyed() && event?.sender?.id === win.webContents.id);
    };
    // 主窗口重建时这段初始化会再跑一次，先撤掉旧 handler
    for (const channel of Object.values(IPC_CHANNELS)) ipcMain.removeHandler(channel);
    const denied = { ok: false, error: { code: 'API_FORBIDDEN', message: '只有桌面窗口可以调用声明式 API。' } };

    ipcMain.handle(IPC_CHANNELS.LIST, (event, filter = {}) => {
        if (!fromDesktop(event)) return denied;
        const { prefix = '', query = '' } = filter && typeof filter === 'object' ? filter : {};
        return { ok: true, data: getDesktopApi().list({ caller: 'widget', prefix, query }) };
    });
    ipcMain.handle(IPC_CHANNELS.DESCRIBE, (event, apiId) => {
        if (!fromDesktop(event)) return denied;
        try {
            return { ok: true, data: getDesktopApi().describe(apiId, { caller: 'widget' }) };
        } catch (error) {
            return { ok: false, error: { code: error.code || 'API_FAILED', message: error.message } };
        }
    });
    ipcMain.handle(IPC_CHANNELS.CALL, (event, apiId, params) => {
        if (!fromDesktop(event)) return denied;
        return getDesktopApi().call(apiId, params, { caller: 'widget' });
    });
}

module.exports = { createDesktopApi, getDesktopApi, registerIpc, IPC_CHANNELS };
