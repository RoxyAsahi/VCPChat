'use strict';

const { WebContentsView, app, shell, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs-extra');
const { PRELOAD_ROLES, resolveAppPreload } = require('./preloadPaths');
const windowService = require('./windowService');

const EMBEDDED_APP_ACTIONS = new Set([
    'open-notes-window',
    'open-note-mini-window',
    'open-translator-window',
    'open-memo-window',
    'open-forum-window',
    'open-log-window',
    'open-themes-window',
    'open-task-window',
    'open-plugin-manager-window',
]);

function toFileUrl(appRoot, relativePath, query = {}) {
    const url = pathToFileURL(path.join(appRoot, relativePath));
    Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, String(value));
        }
    });
    url.searchParams.set('vcpEmbedded', '1');
    return url.toString();
}

async function resolveDescriptor(appAction, appRoot) {
    switch (appAction) {
        case 'open-notes-window':
            return { url: toFileUrl(appRoot, 'Notemodules/notes.html') };
        case 'open-note-mini-window':
            return { url: toFileUrl(appRoot, 'Notemodules/notemini.html') };
        case 'open-memo-window':
            return { url: toFileUrl(appRoot, 'Memomodules/memo.html') };
        case 'open-forum-window':
            return { url: toFileUrl(appRoot, 'Forummodules/forum.html') };
        case 'open-log-window':
            return { url: toFileUrl(appRoot, 'Logmodules/log.html') };
        case 'open-themes-window':
            return { url: toFileUrl(appRoot, 'Themesmodules/themes.html') };
        case 'open-task-window':
            return { url: toFileUrl(appRoot, 'Agenttaskmodules/task.html') };
        case 'open-plugin-manager-window':
            return { url: toFileUrl(appRoot, 'PluginManagerModules/plugin-manager.html') };
        case 'open-translator-window': {
            let settings = {};
            try {
                const settingsPath = path.join(appRoot, 'AppData', 'settings.json');
                if (await fs.pathExists(settingsPath)) settings = await fs.readJson(settingsPath);
            } catch (error) {
                console.warn('[EmbeddedApps] Failed to read translator settings:', error.message);
            }
            return {
                url: toFileUrl(appRoot, 'Translatormodules/translator.html', {
                    vcpServerUrl: settings.vcpServerUrl || '',
                    vcpApiKey: settings.vcpApiKey || '',
                }),
            };
        }
        default:
            return null;
    }
}

function normalizeBounds(bounds, parentBounds) {
    const parentWidth = Math.max(1, Number(parentBounds?.width) || 1);
    const parentHeight = Math.max(1, Number(parentBounds?.height) || 1);
    const x = Math.max(0, Math.min(parentWidth - 1, Math.round(Number(bounds?.x) || 0)));
    const y = Math.max(0, Math.min(parentHeight - 1, Math.round(Number(bounds?.y) || 0)));
    const width = Math.max(1, Math.min(parentWidth - x, Math.round(Number(bounds?.width) || 1)));
    const height = Math.max(1, Math.min(parentHeight - y, Math.round(Number(bounds?.height) || 1)));
    return { x, y, width, height };
}

function createEmbeddedAppSessionManager({ mainWindow, launchStandalone }) {
    const sessions = new Map();
    const appRoot = app.getAppPath();
    let activeAction = null;

    function assertMainRenderer(event) {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
            throw new Error('Embedded application sessions can only be controlled by the main renderer.');
        }
    }

    function notify(action, state, detail = {}) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('embedded-vchat-app-state', { action, state, ...detail });
    }

    function hideAll() {
        sessions.forEach(session => session.view.setVisible(false));
    }

    async function create(appAction) {
        if (!EMBEDDED_APP_ACTIONS.has(appAction)) {
            return { success: false, embeddable: false, error: '此应用需要在独立窗口中运行。' };
        }
        const current = sessions.get(appAction);
        if (current && !current.view.webContents.isDestroyed()) {
            return { success: true, embeddable: true, action: appAction, reused: true };
        }

        const descriptor = await resolveDescriptor(appAction, appRoot);
        if (!descriptor) return { success: false, embeddable: false, error: '没有可用的内嵌应用描述。' };

        const view = new WebContentsView({
            webPreferences: {
                preload: resolveAppPreload(appRoot, PRELOAD_ROLES.UTILITY),
                contextIsolation: true,
                nodeIntegration: false,
                devTools: true,
            },
        });
        const session = { action: appAction, view, bounds: { x: 0, y: 44, width: 1, height: 1 } };
        sessions.set(appAction, session);
        mainWindow.contentView.addChildView(view);
        view.setVisible(false);
        view.setBounds(session.bounds);
        view.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
            return { action: 'deny' };
        });
        view.webContents.on('render-process-gone', (_event, details) => {
            notify(appAction, 'error', { error: `应用进程已退出：${details.reason}` });
        });
        view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (isMainFrame !== false && errorCode !== -3) {
                notify(appAction, 'error', { error: errorDescription, url: validatedURL });
            }
        });
        view.webContents.once('destroyed', () => {
            const active = sessions.get(appAction);
            if (active?.view === view) sessions.delete(appAction);
            if (activeAction === appAction) activeAction = null;
        });

        try {
            await view.webContents.loadURL(descriptor.url);
            await view.webContents.executeJavaScript(
                "document.documentElement.dataset.vcpEmbeddedApp='true';document.body?.setAttribute('data-vcp-embedded-app','true');",
                true
            ).catch(() => {});
            await view.webContents.insertCSS(`
                html[data-vcp-embedded-app="true"] #minimize-btn,
                html[data-vcp-embedded-app="true"] #maximize-btn,
                html[data-vcp-embedded-app="true"] #close-btn,
                html[data-vcp-embedded-app="true"] #minimize-theme-btn,
                html[data-vcp-embedded-app="true"] #maximize-theme-btn,
                html[data-vcp-embedded-app="true"] #close-theme-btn,
                html[data-vcp-embedded-app="true"] #minimize-translator-btn,
                html[data-vcp-embedded-app="true"] #maximize-translator-btn,
                html[data-vcp-embedded-app="true"] #close-translator-btn { display: none !important; }
            `).catch(() => {});
            notify(appAction, 'ready');
            return { success: true, embeddable: true, action: appAction };
        } catch (error) {
            close(appAction);
            return { success: false, embeddable: true, error: error.message };
        }
    }

    function activate(appAction) {
        hideAll();
        activeAction = null;
        if (!appAction) return { success: true };
        const session = sessions.get(appAction);
        if (!session || session.view.webContents.isDestroyed()) {
            return { success: false, error: '内嵌应用会话不存在。' };
        }
        session.view.setBounds(normalizeBounds(session.bounds, mainWindow.getContentBounds()));
        session.view.setVisible(true);
        activeAction = appAction;
        return { success: true };
    }

    function setBounds(appAction, bounds) {
        const session = sessions.get(appAction);
        if (!session || session.view.webContents.isDestroyed()) {
            return { success: false, error: '内嵌应用会话不存在。' };
        }
        session.bounds = normalizeBounds(bounds, mainWindow.getContentBounds());
        session.view.setBounds(session.bounds);
        return { success: true };
    }

    function close(appAction) {
        const session = sessions.get(appAction);
        if (!session) return { success: true };
        sessions.delete(appAction);
        if (activeAction === appAction) activeAction = null;
        try { mainWindow.contentView.removeChildView(session.view); } catch (_error) { /* already detached */ }
        if (!session.view.webContents.isDestroyed()) {
            session.view.webContents.close({ waitForBeforeUnload: false });
        }
        notify(appAction, 'closed');
        return { success: true };
    }

    async function detach(appAction, point = {}) {
        if (!sessions.has(appAction)) return { success: false, error: '内嵌应用会话不存在。' };
        close(appAction);
        const result = await launchStandalone(appAction);
        if (!result?.success) return result || { success: false, error: '独立窗口启动失败。' };
        if (result.appId && Number.isFinite(point.x) && Number.isFinite(point.y)) {
            const standaloneWindow = windowService.getWindow(result.appId);
            if (standaloneWindow && !standaloneWindow.isDestroyed()) {
                const windowBounds = standaloneWindow.getBounds();
                const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) });
                const area = display.workArea;
                const x = Math.min(area.x + area.width - windowBounds.width, Math.max(area.x, Math.round(point.x - 80)));
                const y = Math.min(area.y + area.height - windowBounds.height, Math.max(area.y, Math.round(point.y - 18)));
                standaloneWindow.setPosition(x, y, false);
            }
        }
        return { ...result, detached: true };
    }

    function closeAll() {
        [...sessions.keys()].forEach(close);
    }

    mainWindow.on('closed', closeAll);

    return {
        isEmbeddable: appAction => EMBEDDED_APP_ACTIONS.has(appAction),
        create,
        activate,
        setBounds,
        close,
        detach,
        closeAll,
        assertMainRenderer,
    };
}

module.exports = {
    EMBEDDED_APP_ACTIONS,
    createEmbeddedAppSessionManager,
};
