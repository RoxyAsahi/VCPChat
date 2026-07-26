'use strict';

const { ipcMain, BrowserWindow, app } = require('electron');
const { AgentRuntimeManager } = require('../agent-runtime/runtimeManager');
const { IPC_CHANNELS } = require('../agent-runtime/contracts');
const { AgentRuntimeError } = require('../agent-runtime/errors');
const { createAgentRuntimeStore } = require('../agent-runtime/persistence');

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
        IPC_CHANNELS.GET_SESSION,
        IPC_CHANNELS.RENAME_SESSION,
        IPC_CHANNELS.CLOSE_SESSION,
        IPC_CHANNELS.DELETE_SESSION,
        IPC_CHANNELS.FORK_SESSION,
        IPC_CHANNELS.GET_EVENTS,
        IPC_CHANNELS.GET_MESSAGES,
        IPC_CHANNELS.GET_ARTIFACTS,
        IPC_CHANNELS.GET_TOOL_CATALOG,
        IPC_CHANNELS.REFRESH_TOOL_CATALOG,
        IPC_CHANNELS.LIST_PATCH_PROPOSALS,
        IPC_CHANNELS.GET_PATCH_PROPOSAL,
        IPC_CHANNELS.REJECT_PATCH_PROPOSAL,
        IPC_CHANNELS.COMPACT_SESSION,
        IPC_CHANNELS.START_TURN,
        IPC_CHANNELS.STEER_TURN,
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

    const store = options.store || createAgentRuntimeStore(options.userDataPath || app.getPath('userData'));
    manager = new AgentRuntimeManager({
        projectRoot,
        driver,
        store,
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
    ipcMain.handle(IPC_CHANNELS.GET_SESSION, (event, payload) => guard(event, () => manager.getSession(payload?.sessionId)));
    ipcMain.handle(IPC_CHANNELS.RENAME_SESSION, (event, payload) => guard(event, () => manager.renameSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CLOSE_SESSION, (event, payload) => guard(event, () => manager.closeSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.DELETE_SESSION, (event, payload) => guard(event, () => manager.deleteSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.FORK_SESSION, (event, payload) => guard(event, () => manager.forkSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.GET_EVENTS, (event, payload) => guard(event, () => manager.getEvents(payload?.sessionId, payload?.sinceSequence || 0)));
    ipcMain.handle(IPC_CHANNELS.GET_MESSAGES, (event, payload) => guard(event, () => manager.getMessages(payload?.sessionId)));
    ipcMain.handle(IPC_CHANNELS.GET_ARTIFACTS, (event, payload) => guard(event, () => manager.getArtifacts(payload?.sessionId)));
    ipcMain.handle(IPC_CHANNELS.GET_TOOL_CATALOG, (event, payload) => guard(event, () => manager.getToolCatalog(payload || {})));
    ipcMain.handle(IPC_CHANNELS.REFRESH_TOOL_CATALOG, (event) => guard(event, () => manager.refreshToolCatalog()));
    ipcMain.handle(IPC_CHANNELS.LIST_PATCH_PROPOSALS, (event, payload) => guard(event, () => manager.listPatchProposals(payload?.sessionId)));
    ipcMain.handle(IPC_CHANNELS.GET_PATCH_PROPOSAL, (event, payload) => guard(event, () => manager.getPatchProposal(payload || {})));
    ipcMain.handle(IPC_CHANNELS.REJECT_PATCH_PROPOSAL, (event, payload) => guard(event, () => manager.rejectPatchProposal(payload || {})));
    ipcMain.handle(IPC_CHANNELS.COMPACT_SESSION, (event, payload) => guard(event, () => manager.compactSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.START_TURN, (event, payload) => guard(event, () => manager.startTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.STEER_TURN, (event, payload) => guard(event, () => manager.steerTurn(payload || {})));
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
        manager.store?.close();
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
