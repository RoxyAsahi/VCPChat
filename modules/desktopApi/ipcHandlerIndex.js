'use strict';

// 记下每个 ipcMain.handle 通道对应的 handler，让声明式接口可以直接复用现有 IPC 实现，
// 不必为每个通道再写一遍转发。必须在任何 handler 注册之前安装（main.js 开头）。
//
// 只用于接口目录里明确登记过的通道：invoke(channel, args) 用一个合成的事件调用 handler，
// 事件的 sender 是桌面窗口（若已打开），并带上 desktopApi 标记，handler 需要区分时可以看它。

let installedOn = null;
const handlers = new Map();

function install(ipcMain) {
    if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('[IpcHandlerIndex] 需要 ipcMain');
    if (installedOn === ipcMain) return;
    if (installedOn) throw new Error('[IpcHandlerIndex] 已安装在另一个 ipcMain 上');
    const originalHandle = ipcMain.handle.bind(ipcMain);
    const originalRemove = ipcMain.removeHandler.bind(ipcMain);
    ipcMain.handle = (channel, handler) => {
        const result = originalHandle(channel, handler);
        handlers.set(channel, handler);
        return result;
    };
    ipcMain.removeHandler = (channel) => {
        handlers.delete(channel);
        return originalRemove(channel);
    };
    installedOn = ipcMain;
}

function has(channel) {
    return handlers.has(channel);
}

/**
 * @param {string} channel
 * @param {any[]} args
 * @param {{ sender?: any }} [options]
 */
async function invoke(channel, args = [], { sender = null } = {}) {
    const handler = handlers.get(channel);
    if (!handler) {
        const error = new Error(`IPC 通道 ${channel} 没有注册 handler（对应模块可能未启用）`);
        error.code = 'API_UNAVAILABLE';
        throw error;
    }
    const event = Object.freeze({
        sender,
        senderFrame: sender?.mainFrame || null,
        desktopApi: true,
    });
    return handler(event, ...args);
}

// 测试用
function reset() {
    handlers.clear();
    installedOn = null;
}

module.exports = { install, has, invoke, reset };
