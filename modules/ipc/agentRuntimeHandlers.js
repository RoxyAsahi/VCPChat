'use strict';

const { ipcMain, BrowserWindow } = require('electron');
const path = require('path');
const { RustAgentRuntimeManager } = require('../agent-runtime/rustRuntimeManager');
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
        IPC_CHANNELS.CLOSE_SESSION,
        IPC_CHANNELS.COMPACT_SESSION,
        IPC_CHANNELS.LIST_TOPICS,
        IPC_CHANNELS.READ_TOPIC,
        IPC_CHANNELS.TAKEOVER_TOPIC,
        IPC_CHANNELS.RENAME_TOPIC,
        IPC_CHANNELS.DELETE_TOPIC,
        IPC_CHANNELS.LIST_INTERACTION_QUEUE,
        IPC_CHANNELS.REPLACE_INTERACTION_QUEUE,
        IPC_CHANNELS.CLEAR_INTERACTION_QUEUE,
        IPC_CHANNELS.GET_WORKBENCH_SETTINGS,
        IPC_CHANNELS.UPDATE_WORKBENCH_SETTINGS,
        IPC_CHANNELS.START_TURN,
        IPC_CHANNELS.STEER_TURN,
        IPC_CHANNELS.FOLLOW_UP_TURN,
        IPC_CHANNELS.CANCEL_TURN,
        IPC_CHANNELS.RESPOND_APPROVAL,
    ]) {
        ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(IPC_CHANNELS.SET_WORKBENCH_PRESENCE);
}

function initialize(options) {
    const { settingsManager, projectRoot } = options;
    removeHandlers();
    workbenchMounted = false;

    manager = new RustAgentRuntimeManager({
        projectRoot,
        settingsPath: settingsManager.settingsPath || path.join(projectRoot, 'AppData', 'settings.json'),
        // In a packaged Electron app settings live under userData, not inside
        // app.asar.  Keep Agent catalog discovery beside that shared file so
        // the daemon can use the exact same layout in development and release.
        agentsDir: path.join(path.dirname(settingsManager.settingsPath || path.join(projectRoot, 'AppData', 'settings.json')), 'Agents'),
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
    ipcMain.handle(IPC_CHANNELS.CLOSE_SESSION, (event, payload) => guard(event, () => manager.closeSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.COMPACT_SESSION, (event, payload) => guard(event, () => manager.compactSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_TOPICS, (event) => guard(event, () => manager.listTopics()));
    ipcMain.handle(IPC_CHANNELS.READ_TOPIC, (event, payload) => guard(event, () => manager.readTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.TAKEOVER_TOPIC, (event, payload) => guard(event, () => manager.takeoverTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RENAME_TOPIC, (event, payload) => guard(event, () => manager.renameTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.DELETE_TOPIC, (event, payload) => guard(event, () => manager.deleteTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_INTERACTION_QUEUE, (event) => guard(event, () => manager.listInteractionQueue()));
    ipcMain.handle(IPC_CHANNELS.REPLACE_INTERACTION_QUEUE, (event, payload) => guard(event, () => manager.replaceInteractionQueue(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CLEAR_INTERACTION_QUEUE, (event) => guard(event, () => manager.clearInteractionQueue()));
    ipcMain.handle(IPC_CHANNELS.GET_WORKBENCH_SETTINGS, (event) => guard(event, () => manager.getWorkbenchSettings()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_WORKBENCH_SETTINGS, (event, payload) => guard(event, () => manager.updateWorkbenchSettings(payload || {})));
    ipcMain.handle(IPC_CHANNELS.START_TURN, (event, payload) => guard(event, () => manager.startTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.STEER_TURN, (event, payload) => guard(event, () => manager.steerTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.FOLLOW_UP_TURN, (event, payload) => guard(event, () => manager.followUpTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CANCEL_TURN, (event, payload) => guard(event, () => manager.cancelTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESPOND_APPROVAL, (event, payload) => guard(event, () => manager.respondApproval(payload || {})));
    ipcMain.on(IPC_CHANNELS.SET_WORKBENCH_PRESENCE, (event, payload) => {
        assertMainWindowSender(event);
        workbenchMounted = payload?.mounted === true;
        // Main forwards presence but never owns approval state. Rust rejects
        // all pending local approvals once this becomes false.
        void manager?.setWorkbenchPresence(workbenchMounted).catch((error) => {
            console.warn('[AgentRuntime] Could not forward Workbench presence:', error.message);
        });
    });

    return manager;
}

async function shutdown() {
    workbenchMounted = false;
    if (manager) {
        try {
            await manager.setWorkbenchPresence(false).catch(() => null);
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
