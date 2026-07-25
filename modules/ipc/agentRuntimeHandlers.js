'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const { AgentRuntimeManager } = require('../agent-runtime/runtimeManager');
const { IPC_CHANNELS } = require('../agent-runtime/contracts');
const { AgentRuntimeError } = require('../agent-runtime/errors');

let manager = null;
let cachedSettings = {};
let workbenchMounted = false;

function getMainWindow() {
    return BrowserWindow.getAllWindows().find((window) => {
        if (!window || window.isDestroyed()) return false;
        const url = window.webContents.getURL();
        return url.endsWith('/main.html') || url.endsWith('main.html');
    }) || null;
}

function assertMainWindowSender(event) {
    const mainWindow = getMainWindow();
    if (!mainWindow) {
        throw new AgentRuntimeError('UNAUTHORIZED_SENDER', 'Main window is not available');
    }
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.id !== mainWindow.id) {
        throw new AgentRuntimeError('UNAUTHORIZED_SENDER', 'Agent runtime IPC is restricted to the main window');
    }
    return mainWindow;
}

async function refreshSettings(settingsManager) {
    try {
        cachedSettings = await settingsManager.readSettings();
    } catch (error) {
        // Keep the previous snapshot on read failure.
    }
    return cachedSettings;
}

function removeHandlers() {
    for (const channel of [
        IPC_CHANNELS.GET_STATUS,
        IPC_CHANNELS.START,
        IPC_CHANNELS.STOP,
        IPC_CHANNELS.CREATE_SESSION,
        IPC_CHANNELS.LIST_SESSIONS,
        IPC_CHANNELS.START_TURN,
        IPC_CHANNELS.CANCEL_TURN,
        IPC_CHANNELS.RESPOND_APPROVAL,
    ]) {
        ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(IPC_CHANNELS.SET_WORKBENCH_PRESENCE);
}

function initialize(options) {
    const { settingsManager, projectRoot } = options;
    const driver = process.env.VCP_AGENT_RUNTIME_DRIVER || 'pi';
    removeHandlers();
    workbenchMounted = false;

    manager = new AgentRuntimeManager({
        projectRoot,
        driver,
        getSettings: () => cachedSettings,
        hasUi: () => Boolean(workbenchMounted && getMainWindow()),
        sendEvent: (event) => {
            const mainWindow = getMainWindow();
            if (mainWindow) {
                mainWindow.webContents.send(IPC_CHANNELS.EVENT, event);
            }
        },
    });

    const guard = async (event, fn) => {
        assertMainWindowSender(event);
        await refreshSettings(settingsManager);
        return fn();
    };

    ipcMain.handle(IPC_CHANNELS.GET_STATUS, (event) => guard(event, () => manager.getStatus()));
    ipcMain.handle(IPC_CHANNELS.START, (event) => guard(event, () => manager.start()));
    ipcMain.handle(IPC_CHANNELS.STOP, (event) => guard(event, () => manager.stop()));
    ipcMain.handle(IPC_CHANNELS.CREATE_SESSION, (event, payload) => guard(event, () => manager.createSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_SESSIONS, (event) => guard(event, () => manager.listSessions()));
    ipcMain.handle(IPC_CHANNELS.START_TURN, (event, payload) => guard(event, () => manager.startTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CANCEL_TURN, (event, payload) => guard(event, () => manager.cancelTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESPOND_APPROVAL, (event, payload) => guard(event, () => manager.respondApproval(payload || {})));
    ipcMain.on(IPC_CHANNELS.SET_WORKBENCH_PRESENCE, (event, payload) => {
        assertMainWindowSender(event);
        workbenchMounted = payload?.mounted === true;
        if (!workbenchMounted) {
            manager?.approvals.cancelAll('workbench-unmounted');
        }
    });

    return manager;
}

async function shutdown() {
    workbenchMounted = false;
    if (manager) {
        try {
            await manager.stop();
        } catch (error) {
            console.warn('[AgentRuntime] Shutdown encountered an issue:', error.message);
        }
        manager = null;
    }
    removeHandlers();
}

function getManager() {
    return manager;
}

module.exports = {
    initialize,
    shutdown,
    getManager,
};
