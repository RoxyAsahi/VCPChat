'use strict';

const { ipcMain, BrowserWindow, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { CodexRuntimeManager } = require('../codex-runtime/runtimeManager');
const { AgentWorkspaceService } = require('../codex-runtime/workspaceService');
const { AGENT_CHANNELS: IPC_CHANNELS } = require('./ipcContracts');

let manager = null;
let workspaceService = null;
let cachedSettings = {};
const workbenchSenders = new Set();
let settingsManagerWithListener = null;
let settingsUpdatedListener = null;

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
        const error = new Error('Agent runtime IPC is restricted to main windows');
        error.code = 'UNAUTHORIZED_SENDER';
        throw error;
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
    if (settingsManagerWithListener && settingsUpdatedListener) {
        settingsManagerWithListener.off?.('settings-updated', settingsUpdatedListener);
    }
    settingsManagerWithListener = null;
    settingsUpdatedListener = null;
    for (const channel of [
        IPC_CHANNELS.GET_PRESENTATION_MODE,
        IPC_CHANNELS.LIST_AGENT_PROFILES,
        IPC_CHANNELS.SAVE_AGENT_PROFILE,
        IPC_CHANNELS.SAVE_AGENT_AVATAR,
        IPC_CHANNELS.APPLY_AGENT_PROFILE,
        IPC_CHANNELS.GET_STATUS,
        IPC_CHANNELS.START,
        IPC_CHANNELS.STOP,
        IPC_CHANNELS.CREATE_TOPIC,
         IPC_CHANNELS.CREATE_SESSION,
         IPC_CHANNELS.ENSURE_SESSION_RUNTIME,
         IPC_CHANNELS.FORK_SESSION,
         IPC_CHANNELS.CLOSE_SESSION,
         IPC_CHANNELS.RESTORE_SESSION,
         IPC_CHANNELS.SET_SESSION_PINNED,
        IPC_CHANNELS.COMPACT_SESSION,
        IPC_CHANNELS.LIST_TOPICS,
        IPC_CHANNELS.SEARCH_TOPICS,
        IPC_CHANNELS.SEARCH_TOPIC_MESSAGES,
        IPC_CHANNELS.GET_TOPIC_INDEX_STATUS,
        IPC_CHANNELS.REBUILD_TOPIC_INDEX,
        IPC_CHANNELS.READ_TOPIC,
        IPC_CHANNELS.READ_PROJECTION,
        IPC_CHANNELS.RENAME_TOPIC,
        IPC_CHANNELS.DELETE_TOPIC,
        IPC_CHANNELS.PERMANENTLY_DELETE_SESSION,
        IPC_CHANNELS.EXPORT_SESSION,
        IPC_CHANNELS.LIST_RECOVERY_OPERATIONS,
        IPC_CHANNELS.LIST_RECOVERY_CANDIDATES,
        IPC_CHANNELS.RESOLVE_RECOVERY_OPERATION,
        IPC_CHANNELS.LIST_INTERACTION_QUEUE,
        IPC_CHANNELS.REPLACE_INTERACTION_QUEUE,
        IPC_CHANNELS.CLEAR_INTERACTION_QUEUE,
        IPC_CHANNELS.RESOLVE_PENDING_INPUT,
        IPC_CHANNELS.GET_WORKBENCH_SETTINGS,
        IPC_CHANNELS.UPDATE_WORKBENCH_SETTINGS,
        IPC_CHANNELS.READ_SESSION_CONFIG,
        IPC_CHANNELS.UPDATE_SESSION_CONFIG,
        IPC_CHANNELS.SELECT_ATTACHMENTS,
        IPC_CHANNELS.START_TURN,
        IPC_CHANNELS.STEER_TURN,
        IPC_CHANNELS.FOLLOW_UP_TURN,
        IPC_CHANNELS.CANCEL_TURN,
        IPC_CHANNELS.RESPOND_APPROVAL,
        IPC_CHANNELS.RESPOND_INTERACTION,
        IPC_CHANNELS.WORKSPACE_LIST_DIRECTORY,
        IPC_CHANNELS.WORKSPACE_READ_PREVIEW,
        IPC_CHANNELS.WORKSPACE_SEARCH_FILES,
        IPC_CHANNELS.WORKSPACE_STAT_PATH,
        IPC_CHANNELS.WORKSPACE_PERFORM_PATH_ACTION,
        IPC_CHANNELS.WORKSPACE_CANCEL,
    ]) {
        ipcMain.removeHandler(channel);
    }
    ipcMain.removeAllListeners(IPC_CHANNELS.SET_WORKBENCH_PRESENCE);
    workbenchSenders.clear();
}

function initialize(options) {
    const { settingsManager, projectRoot } = options;
    removeHandlers();
    manager = new CodexRuntimeManager({
        projectRoot,
        settingsPath: settingsManager.settingsPath || path.join(projectRoot, 'AppData', 'settings.json'),
        // In a packaged Electron app settings live under userData, not inside
        // app.asar.  Keep Agent catalog discovery beside that shared file so
        // the Codex Agent catalog uses the same layout in development and release.
        agentsDir: path.join(path.dirname(settingsManager.settingsPath || path.join(projectRoot, 'AppData', 'settings.json')), 'CodexAgents'),
        getSettings: () => cachedSettings,
        getModels: () => options.getModels?.() || [],
        setSettings: (updater) => settingsManager.updateSettings(updater),
        hasUi: () => workbenchSenders.size > 0 && Boolean(getMainWindow()),
        sendEvent: (event) => {
            for (const window of BrowserWindow.getAllWindows()) {
                if (isMainHtmlWindow(window)) {
                    window.webContents.send(IPC_CHANNELS.EVENT, event);
                }
            }
        },
    });
    workspaceService = new AgentWorkspaceService({
        getSession: (sessionId) => manager?.repository?.getSession(sessionId) || null,
        shell,
        clipboard,
        confirmOpen: async ({ relativePath }) => {
            const window = getMainWindow();
            if (!window) return false;
            const result = await dialog.showMessageBox(window, {
                type: 'warning',
                buttons: ['取消', '仍然打开'],
                defaultId: 0,
                cancelId: 0,
                title: '打开可能执行的文件',
                message: '此文件可能执行本地代码。',
                detail: relativePath,
                noLink: true,
            });
            return result.response === 1;
        },
    });

    const settingsReady = refreshSettings(settingsManager);
    const projectionGuard = (event, fn) => {
        assertMainWindowSender(event);
        return fn();
    };
    const runtimeGuard = async (event, fn) => {
        assertMainWindowSender(event);
        await settingsReady;
        return fn();
    };
    const toolboxGuard = async (event, fn) => {
        assertMainWindowSender(event);
        await settingsReady;
        await manager?.refreshToolboxConfiguration(cachedSettings);
        return fn();
    };
    const workspaceGuard = (event, fn) => {
        assertMainWindowSender(event);
        if (!workspaceService) throw new AgentRuntimeError('WORKSPACE_UNAVAILABLE', 'Agent workspace service is unavailable');
        return fn();
    };

    // Standard VChat settings writes emit this event.  Reconfigure at the
    // Main boundary immediately rather than waiting for the next Workbench
    // click; credentials never travel through Renderer IPC.
    settingsUpdatedListener = (settings) => {
        cachedSettings = settings || {};
        void manager?.refreshToolboxConfiguration(cachedSettings).catch((error) => {
            console.warn('[AgentRuntime] Could not refresh ToolBox connection:', error.message);
        });
    };
    settingsManager.on?.('settings-updated', settingsUpdatedListener);
    settingsManagerWithListener = settingsManager;

    ipcMain.handle(IPC_CHANNELS.GET_PRESENTATION_MODE, (event) => projectionGuard(event, () => ({
        mode: String(process.env.VCP_AGENT_PRESENTATION_RENDERER || '').toLowerCase() === 'legacy'
            ? 'legacy'
            : 'fork',
    })));
    ipcMain.handle(IPC_CHANNELS.LIST_AGENT_PROFILES, (event) => projectionGuard(event, () => manager.listAgentProfiles()));
    ipcMain.handle(IPC_CHANNELS.SAVE_AGENT_PROFILE, (event, payload) => projectionGuard(event, () => manager.saveAgentProfile(payload || {})));
    ipcMain.handle(IPC_CHANNELS.SAVE_AGENT_AVATAR, (event, payload) => projectionGuard(event, () => manager.saveAgentAvatar(payload || {})));
    ipcMain.handle(IPC_CHANNELS.APPLY_AGENT_PROFILE, (event, payload) => projectionGuard(event, () => manager.applyAgentProfileToSession(payload || {})));

    ipcMain.handle(IPC_CHANNELS.GET_STATUS, (event) => projectionGuard(event, () => manager.getStatus()));
    ipcMain.handle(IPC_CHANNELS.START, (event) => runtimeGuard(event, () => manager.start()));
    ipcMain.handle(IPC_CHANNELS.STOP, (event) => runtimeGuard(event, () => manager.stop()));
    ipcMain.handle(IPC_CHANNELS.CREATE_TOPIC, (event, payload) => projectionGuard(event, () => manager.createTopic({
        agentId: payload?.agentId || payload?.agent,
        title: payload?.title,
    })));
    ipcMain.handle(IPC_CHANNELS.CREATE_SESSION, (event, payload) => toolboxGuard(event, () => manager.createSession({
        sessionId: payload?.sessionId || payload?.topicId,
        resume: payload?.resume,
        agentId: payload?.agentId || payload?.agent,
        title: payload?.title,
    })));
    ipcMain.handle(IPC_CHANNELS.ENSURE_SESSION_RUNTIME, (event, payload) => toolboxGuard(event, () => manager.ensureSessionRuntime(payload || {})));
    ipcMain.handle(IPC_CHANNELS.FORK_SESSION, (event, payload) => runtimeGuard(event, () => manager.forkSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CLOSE_SESSION, (event, payload) => runtimeGuard(event, () => manager.closeSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESTORE_SESSION, (event, payload) => runtimeGuard(event, () => manager.restoreSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.SET_SESSION_PINNED, (event, payload) => projectionGuard(event, () => manager.setSessionPinned(payload || {})));
    ipcMain.handle(IPC_CHANNELS.COMPACT_SESSION, (event, payload) => runtimeGuard(event, () => manager.compactSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_TOPICS, (event, payload) => projectionGuard(event, async () => {
        return manager.listTopics(payload || {});
    }));
    ipcMain.handle(IPC_CHANNELS.SEARCH_TOPICS, (event, payload) => projectionGuard(event, () => manager.searchTopics(payload || {})));
    ipcMain.handle(IPC_CHANNELS.SEARCH_TOPIC_MESSAGES, (event, payload) => projectionGuard(event, () => manager.searchTopicMessages(payload || {})));
    ipcMain.handle(IPC_CHANNELS.GET_TOPIC_INDEX_STATUS, (event) => projectionGuard(event, () => manager.getTopicIndexStatus()));
    ipcMain.handle(IPC_CHANNELS.REBUILD_TOPIC_INDEX, (event) => projectionGuard(event, () => manager.rebuildTopicIndex()));
    ipcMain.handle(IPC_CHANNELS.READ_TOPIC, (event, payload) => runtimeGuard(event, () => manager.readTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.READ_PROJECTION, (event, payload) => projectionGuard(event, () => manager.readTopic({ ...(payload || {}), reconcile: false })));
    ipcMain.handle(IPC_CHANNELS.RENAME_TOPIC, (event, payload) => projectionGuard(event, () => manager.renameTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.DELETE_TOPIC, (event, payload) => runtimeGuard(event, () => manager.deleteTopic(payload || {})));
    ipcMain.handle(IPC_CHANNELS.PERMANENTLY_DELETE_SESSION, (event, payload) => runtimeGuard(event, () => manager.permanentlyDeleteSession(payload || {})));
    ipcMain.handle(IPC_CHANNELS.LIST_RECOVERY_OPERATIONS, (event) => projectionGuard(event, () => manager.listRecoveryOperations()));
    ipcMain.handle(IPC_CHANNELS.LIST_RECOVERY_CANDIDATES, (event) => runtimeGuard(event, () => manager.listRecoveryCandidates()));
    ipcMain.handle(IPC_CHANNELS.RESOLVE_RECOVERY_OPERATION, (event, payload) => runtimeGuard(event, () => manager.resolveRecoveryOperation(payload || {})));
    ipcMain.handle(IPC_CHANNELS.EXPORT_SESSION, (event, payload) => projectionGuard(event, async () => {
        const mainWindow = assertMainWindowSender(event);
        const format = payload?.format === 'json' ? 'json' : 'markdown';
        const exported = manager.exportSession({ ...(payload || {}), format });
        const result = await dialog.showSaveDialog(mainWindow, {
            title: '导出 Agent Session',
            defaultPath: exported.fileName,
            filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [format === 'json' ? 'json' : 'md'] }],
        });
        if (result.canceled || !result.filePath) return { exported: false };
        await fs.promises.writeFile(result.filePath, exported.content, 'utf8');
        return { exported: true, filePath: result.filePath, format };
    }));
    ipcMain.handle(IPC_CHANNELS.LIST_INTERACTION_QUEUE, (event, payload) => projectionGuard(event, () => manager.listInteractionQueue(payload || {})));
    ipcMain.handle(IPC_CHANNELS.REPLACE_INTERACTION_QUEUE, (event, payload) => projectionGuard(event, () => manager.replaceInteractionQueue(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CLEAR_INTERACTION_QUEUE, (event, payload) => projectionGuard(event, () => manager.clearInteractionQueue(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESOLVE_PENDING_INPUT, (event, payload) => toolboxGuard(event, () => manager.resolvePendingInput(payload || {})));
    ipcMain.handle(IPC_CHANNELS.GET_WORKBENCH_SETTINGS, (event) => projectionGuard(event, () => manager.getWorkbenchSettings()));
    ipcMain.handle(IPC_CHANNELS.UPDATE_WORKBENCH_SETTINGS, (event, payload) => projectionGuard(event, () => manager.updateWorkbenchSettings(payload || {})));
    ipcMain.handle(IPC_CHANNELS.READ_SESSION_CONFIG, (event, payload) => projectionGuard(event, () => manager.readSessionConfig(payload || {})));
    ipcMain.handle(IPC_CHANNELS.UPDATE_SESSION_CONFIG, (event, payload) => projectionGuard(event, () => manager.updateSessionConfig(payload || {})));
    ipcMain.handle(IPC_CHANNELS.SELECT_ATTACHMENTS, (event, payload) => projectionGuard(event, async () => {
        const mainWindow = assertMainWindowSender(event);
        const sessionId = String(payload?.sessionId || '').trim();
        if (!sessionId) throw new Error('Agent media selection requires sessionId');
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
    ipcMain.handle(IPC_CHANNELS.START_TURN, (event, payload) => toolboxGuard(event, () => manager.startTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.STEER_TURN, (event, payload) => runtimeGuard(event, () => manager.steerTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.FOLLOW_UP_TURN, (event, payload) => toolboxGuard(event, () => manager.followUpTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.CANCEL_TURN, (event, payload) => runtimeGuard(event, () => manager.cancelTurn(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESPOND_APPROVAL, (event, payload) => runtimeGuard(event, () => manager.respondApproval(payload || {})));
    ipcMain.handle(IPC_CHANNELS.RESPOND_INTERACTION, (event, payload) => runtimeGuard(event, () => manager.respondInteraction(payload || {})));
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_DIRECTORY, (event, payload) => workspaceGuard(event, () => workspaceService.listDirectory(payload || {})));
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_PREVIEW, (event, payload) => workspaceGuard(event, () => workspaceService.readPreview(payload || {})));
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_SEARCH_FILES, (event, payload) => workspaceGuard(event, () => workspaceService.searchFiles(payload || {})));
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_STAT_PATH, (event, payload) => workspaceGuard(event, () => workspaceService.statPath(payload || {})));
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_PERFORM_PATH_ACTION, (event, payload) => workspaceGuard(event, () => workspaceService.performPathAction(payload || {})));
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_CANCEL, (event, payload) => workspaceGuard(event, () => workspaceService.cancel(payload || {})));
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
        // Main forwards presence but never owns approval state. RuntimeManager
        // rejects all pending local approvals once this becomes false.
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
    workspaceService = null;
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
