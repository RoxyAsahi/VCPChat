'use strict';

const { ipcMain, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { RustAgentRuntimeManager } = require('../agent-runtime/rustRuntimeManager');
const { IPC_CHANNELS } = require('../agent-runtime/contracts');
const { AgentRuntimeError } = require('../agent-runtime/errors');

let manager = null;
let cachedSettings = {};
const workbenchSenders = new Set();

function isMainHtmlWindow(window) {
    if (!window || window.isDestroyed()) return false;
    const url = window.webContents.getURL();
    return url.endsWith('/main.html') || url.includes('main.html');
}

function getMainWindow() {
    return BrowserWindow.getAllWindows().find(isMainHtmlWindow) || null;
}

function assertMainWindowSender(event) {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!isMainHtmlWindow(senderWindow)) {
        throw new AgentRuntimeError('UNAUTHORIZED_SENDER', 'Agent runtime IPC is restricted to main windows');
    }
    return senderWindow;
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
        IPC_CHANNELS.CREATE_TOPIC,
        IPC_CHANNELS.CREATE_SESSION,
        IPC_CHANNELS.CLOSE_SESSION,
        IPC_CHANNELS.COMPACT_SESSION,
        IPC_CHANNELS.LIST_TOPICS,
        IPC_CHANNELS.SEARCH_TOPICS,
        IPC_CHANNELS.SEARCH_TOPIC_MESSAGES,
        IPC_CHANNELS.GET_TOPIC_INDEX_STATUS,
        IPC_CHANNELS.REBUILD_TOPIC_INDEX,
        IPC_CHANNELS.READ_TOPIC,
        IPC_CHANNELS.TAKEOVER_TOPIC,
        IPC_CHANNELS.RENAME_TOPIC,
        IPC_CHANNELS.DELETE_TOPIC,
        IPC_CHANNELS.LIST_INTERACTION_QUEUE,
        IPC_CHANNELS.REPLACE_INTERACTION_QUEUE,
        IPC_CHANNELS.CLEAR_INTERACTION_QUEUE,
        IPC_CHANNELS.GET_WORKBENCH_SETTINGS,
        IPC_CHANNELS.UPDATE_WORKBENCH_SETTINGS,
        IPC_CHANNELS.SELECT_ATTACHMENTS,
        IPC_CHANNELS.START_TURN,
        IPC_CHANNELS.STEER_TURN,
        IPC_CHANNELS.FOLLOW_UP_TURN,
        IPC_CHANNELS.CANCEL_TURN,
        IPC_CHANNELS.RESPOND_APPROVAL,
    ]) {
        ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(IPC_CHANNELS.SET_WORKBENCH_PRESENCE);
    workbenchSenders.clear();
}

function initialize(options) {
    const { settingsManager, projectRoot } = options;
    removeHandlers();
    manager = new RustAgentRuntimeManager({
        projectRoot,
        settingsPath: settingsManager.settingsPath || path.join(projectRoot, 'AppData', 'settings.json'),
        // In a packaged Electron app settings live under userData, not inside
        // app.asar.  Keep Agent catalog discovery beside that shared file so
        // the daemon can use the exact same layout in development and release.
        agentsDir: path.join(path.dirname(settingsManager.settingsPath || path.join(projectRoot, 'AppData', 'settings.json')), 'Agents'),
        getSettings: () => cachedSettings,
        hasUi: () => workbenchSenders.size > 0 && Boolean(getMainWindow()),
        sendEvent: (event) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (isMainHtmlWindow(window)) {
                    window.webContents.send(IPC_CHANNELS.EVENT, event);
                }
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
    ipcMain.handle(IPC_CHANNELS.CREATE_TOPIC, (event, payload) => guard(event, () => manager.createTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CREATE_SESSION, (event, payload) => guard(event, () => manager.createSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CLOSE_SESSION, (event, payload) => guard(event, () => manager.closeSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.COMPACT_SESSION, (event, payload) => guard(event, () => manager.compactSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_TOPICS, (event, payload) => guard(event, async () => {
        const topics = await manager.listTopics(payload || {});
        const topicList = Array.isArray(topics) ? topics : topics?.topics || [];
        const attachedTopicId = manager?.getAttachedTopicId() || null;
        const enriched = topicList.map((topic) => (
            attachedTopicId && topic.id === attachedTopicId
                ? { ...topic, locallyAttached: true }
                : topic
        ));
        return Array.isArray(topics) ? enriched : { ...topics, topics: enriched };
    }));
    ipcMain.handle(IPC_CHANNELS.SEARCH_TOPICS, (event, payload) => guard(event, () => manager.searchTopics(payload || {})));
    ipcMain.handle(IPC_CHANNELS.SEARCH_TOPIC_MESSAGES, (event, payload) => guard(event, () => manager.searchTopicMessages(payload || {})));
    ipcMain.handle(IPC_CHANNELS.GET_TOPIC_INDEX_STATUS, (event) => guard(event, () => manager.getTopicIndexStatus()));
    ipcMain.handle(IPC_CHANNELS.REBUILD_TOPIC_INDEX, (event) => guard(event, () => manager.rebuildTopicIndex()));
    ipcMain.handle(IPC_CHANNELS.READ_TOPIC, (event, payload) => guard(event, () => manager.readTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.TAKEOVER_TOPIC, (event, payload) => guard(event, () => manager.takeoverTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RENAME_TOPIC, (event, payload) => guard(event, () => manager.renameTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.DELETE_TOPIC, (event, payload) => guard(event, () => manager.deleteTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_INTERACTION_QUEUE, (event) => guard(event, () => manager.listInteractionQueue()));
    ipcMain.handle(IPC_CHANNELS.REPLACE_INTERACTION_QUEUE, (event, payload) => guard(event, () => manager.replaceInteractionQueue(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CLEAR_INTERACTION_QUEUE, (event) => guard(event, () => manager.clearInteractionQueue()));
    ipcMain.handle(IPC_CHANNELS.GET_WORKBENCH_SETTINGS, (event) => guard(event, () => manager.getWorkbenchSettings()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_WORKBENCH_SETTINGS, (event, payload) => guard(event, () => manager.updateWorkbenchSettings(payload || {})));
    ipcMain.handle(IPC_CHANNELS.SELECT_ATTACHMENTS, (event, payload) => guard(event, async () => {
        const mainWindow = assertMainWindowSender(event);
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) throw new Error('Agent attachment selection requires sessionId');
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择 Agent 媒体附件',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico'] },
                { name: '音频', extensions: ['wav', 'mp3', 'aiff', 'aif', 'aac', 'ogg', 'flac'] },
                { name: '视频', extensions: ['mp4', 'webm', 'mov', 'avi'] },
                { name: '所有文件', extensions: ['*'] },
            ],
        });
        if (result.canceled) return { attachments: [] };
        const attachments = [];
        const errors = [];
        for (const filePath of result.filePaths.slice(0, 8)) {
            try {
                const imported = await manager.importAttachment({ sessionId, path: filePath });
                if (imported?.attachment) attachments.push(imported.attachment);
            } catch (error) {
                errors.push(error?.message || String(error));
            }
        }
        return { attachments, errors };
    }));
    ipcMain.handle(IPC_CHANNELS.START_TURN, (event, payload) => guard(event, () => manager.startTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.STEER_TURN, (event, payload) => guard(event, () => manager.steerTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.FOLLOW_UP_TURN, (event, payload) => guard(event, () => manager.followUpTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CANCEL_TURN, (event, payload) => guard(event, () => manager.cancelTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESPOND_APPROVAL, (event, payload) => guard(event, () => manager.respondApproval(payload || {})));
    ipcMain.on(IPC_CHANNELS.SET_WORKBENCH_PRESENCE, (event, payload) => {
        const senderWindow = assertMainWindowSender(event);
        if (payload?.mounted === true) {
            workbenchSenders.add(senderWindow.webContents.id);
            senderWindow.webContents.once('destroyed', () => {
                workbenchSenders.delete(senderWindow.webContents.id);
                void manager?.setWorkbenchPresence(workbenchSenders.size > 0).catch(() => null);
            });
        } else {
            workbenchSenders.delete(senderWindow.webContents.id);
        }
        // Main forwards presence but never owns approval state. Rust rejects
        // all pending local approvals once this becomes false.
        void manager?.setWorkbenchPresence(workbenchSenders.size > 0).catch((error) => {
            console.warn('[AgentRuntime] Could not forward Workbench presence:', error.message);
        });
    });

    return manager;
}

async function shutdown() {
    workbenchSenders.clear();
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
