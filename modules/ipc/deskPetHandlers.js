// modules/ipc/deskPetHandlers.js
// 桌宠（可选模块，默认关闭）：每个 agent 一个透明、无边框、置顶的小窗，
// 显示该 agent 的 Live2D 模型或差分立绘，跟着这个 agent 的回复流换表情。
//
// 资源全部来自用户数据目录，VCPChat 不分发任何 Live2D 文件：
//   AppData/deskpet/live2dcubismcore.min.js     Cubism Core（必须是 5.x，用户自行放入）
//   AppData/Agents/<id>/deskpet/**/*.model3.json Live2D 模型（找到的第一个）
//   AppData/Agents/<id>/portrait.<情绪>.<ext>    差分立绘，没有 Live2D 模型时使用
//   AppData/Agents/<id>/portrait.<ext>           默认立绘；再没有就用头像

const { BrowserWindow, ipcMain, protocol, net, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');
const { createPetDirector } = require('../deskpet/petDirector');
const { EMOTIONS, EMO_PROTOCOL_PROMPT } = require('../deskpet/emoTags');

const SCHEME = 'vcp-deskpet';
const PET_SIZE = { width: 320, height: 480 };
// Windows：'pop-up-menu' 压住任务栏，又不像 'screen-saver' 那样和全屏程序抢；
// macOS 需要 'screen-saver' 才能浮在全屏空间之上。
const TOPMOST_LEVEL = process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu';
const HIT_POLL_MS = 50;
const DRAG_TICK_MS = 16;
// X11 上整窗穿透后 Chromium 收不到指针，getCursorScreenPoint() 会停在旧坐标，
// 光标轮询就再也发现不了宠物；Linux 改为把窗口输入区裁到内容包围盒。
const USE_SHAPE = process.platform === 'linux';
const IMAGE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg', 'gif', 'avif'];

let paths = null; // { projectRoot, appDataRoot, agentDir }
let mainWindow = null;
let initialized = false;
const pets = new Map(); // agentId -> { win, director, ignoringMouse, hitPoll, drag, lastShape }

function registerSchemes() {
    protocol.registerSchemesAsPrivileged([
        { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ]);
}

function isInside(base, file) {
    const rel = path.relative(base, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// vcp-deskpet://pet/<root>/<path>：同一个 origin，模型的 XHR 不跨域。
function resolveServedFile(urlString) {
    const url = new URL(urlString);
    let segments;
    try {
        segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
        return null;
    }
    // 每一段都必须是普通文件名：Windows 会把反斜杠当分隔符，'..' 一律拒绝。
    if (segments.some((s) => s === '..' || s === '.' || /[\\/:]/.test(s))) return null;
    const root = segments.shift();
    if (root === 'app') return guard(path.join(paths.projectRoot, 'DeskPetmodules'), segments);
    if (root === 'vendor') return guard(path.join(paths.projectRoot, 'vendor'), segments);
    if (root === 'core') {
        return segments.join('/') === 'live2dcubismcore.min.js' ? coreFilePath() : null;
    }
    if (root === 'agent') {
        const agentId = segments.shift();
        if (!agentId || agentId.includes('..')) return null;
        const agentRoot = path.join(paths.agentDir, agentId);
        const name = segments.join('/');
        // 只放行 deskpet/ 子目录、立绘和头像，agent 目录里的其他文件（配置、历史）不可见。
        if (segments[0] === 'deskpet') return guard(path.join(agentRoot, 'deskpet'), segments.slice(1));
        if (segments.length === 1 && /^(portrait|avatar)(\.[\w-]+)?\.[a-z0-9]+$/i.test(name)) return guard(agentRoot, segments);
        return null;
    }
    return null;
}

function guard(base, segments) {
    const file = path.normalize(path.join(base, ...segments));
    return isInside(base, file) ? file : null;
}

function coreFilePath() {
    return path.join(paths.appDataRoot, 'deskpet', 'live2dcubismcore.min.js');
}

function registerProtocol() {
    protocol.handle(SCHEME, async (request) => {
        const file = resolveServedFile(request.url);
        if (!file || !(await fs.pathExists(file))) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
    });
}

async function findModel3(dir, depth = 0) {
    if (depth > 3 || !(await fs.pathExists(dir))) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const direct = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith('.model3.json'));
    if (direct) return path.join(dir, direct.name);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await findModel3(path.join(dir, entry.name), depth + 1);
        if (found) return found;
    }
    return null;
}

function agentUrl(agentId, file) {
    const rel = path.relative(path.join(paths.agentDir, agentId), file).split(path.sep).map(encodeURIComponent).join('/');
    return `${SCHEME}://pet/agent/${encodeURIComponent(agentId)}/${rel}`;
}

async function resolveAssets(agentId) {
    const agentRoot = path.join(paths.agentDir, agentId);
    let name = agentId;
    try {
        const config = await fs.readJson(path.join(agentRoot, 'config.json'));
        if (config?.name) name = config.name;
    } catch { /* 没有配置就用 id */ }

    const files = (await fs.pathExists(agentRoot)) ? await fs.readdir(agentRoot) : [];
    const pick = (stem) => {
        for (const ext of IMAGE_EXTENSIONS) {
            const hit = files.find((f) => f.toLowerCase() === `${stem}.${ext}`);
            if (hit) return agentUrl(agentId, path.join(agentRoot, hit));
        }
        return null;
    };
    const portraits = {};
    for (const emotion of EMOTIONS) {
        const url = pick(`portrait.${emotion}`);
        if (url) portraits[emotion] = url;
    }
    const model = await findModel3(path.join(agentRoot, 'deskpet'));
    const hasCore = await fs.pathExists(coreFilePath());
    return {
        agentId,
        name,
        live2d: model ? { modelUrl: agentUrl(agentId, model) } : null,
        coreUrl: hasCore ? `${SCHEME}://pet/core/live2dcubismcore.min.js` : null,
        corePath: coreFilePath(),
        portraits,
        defaultPortrait: pick('portrait'),
        avatar: pick('avatar'),
    };
}

// ---- 窗口 ----------------------------------------------------------------

function petStatePath() {
    return path.join(paths.appDataRoot, 'deskpet', 'state.json');
}

async function readPetState() {
    try { return await fs.readJson(petStatePath()); } catch { return {}; }
}

async function savePetPosition(agentId, position) {
    const state = await readPetState();
    state[agentId] = { ...(state[agentId] || {}), x: position[0], y: position[1] };
    await fs.outputJson(petStatePath(), state, { spaces: 2 });
}

function initialBounds(saved) {
    const area = screen.getPrimaryDisplay().workArea;
    const fallback = {
        x: area.x + area.width - PET_SIZE.width - 24 - pets.size * 40,
        y: area.y + area.height - PET_SIZE.height,
    };
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { ...PET_SIZE, ...fallback };
    // 位置不在任何显示器上（拔了外接屏）就回到默认位置。
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
        saved.x + PET_SIZE.width > a.x && saved.x < a.x + a.width && saved.y + 40 > a.y && saved.y < a.y + a.height);
    return { ...PET_SIZE, ...(onScreen ? { x: saved.x, y: saved.y } : fallback) };
}

function notifyMain(agentId) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('deskpet:state-changed', { agentId, open: pets.has(agentId), openAgents: [...pets.keys()] });
    }
}

function setIgnoreMouse(pet, ignore) {
    if (USE_SHAPE || pet.win.isDestroyed() || ignore === pet.ignoringMouse) return;
    pet.ignoringMouse = ignore;
    // forward:true 让 Windows/macOS 在穿透时仍把 mousemove 送到页面。
    pet.win.setIgnoreMouseEvents(ignore, { forward: true });
}

// 光标在窗口范围内时把窗口内坐标发给页面，页面按像素 alpha 回答是否命中。
// 不依赖 forward 的鼠标钩子（Windows 上它会悄悄失效）。
function startHitPoll(pet) {
    pet.hitPoll = setInterval(() => {
        if (pet.win.isDestroyed() || pet.drag) return;
        const p = screen.getCursorScreenPoint();
        const b = pet.win.getBounds();
        const inside = p.x >= b.x && p.y >= b.y && p.x < b.x + b.width && p.y < b.y + b.height;
        if (!inside) {
            setIgnoreMouse(pet, true);
            return;
        }
        pet.win.webContents.send('deskpet:cursor', { x: p.x - b.x, y: p.y - b.y });
    }, HIT_POLL_MS);
}

async function openPet(agentId) {
    if (pets.has(agentId)) {
        pets.get(agentId).win.showInactive();
        return { success: true, open: true };
    }
    if (agentId !== path.basename(agentId) || !(await fs.pathExists(path.join(paths.agentDir, agentId)))) {
        return { success: false, error: 'agent-not-found' };
    }
    const saved = (await readPetState())[agentId];
    const win = new BrowserWindow({
        ...initialBounds(saved),
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // Windows：点宠物不抢走正在输入的程序的焦点。Linux 窗口管理器对不可聚焦
        // 窗口的处理不一（有的直接丢输入），保持可聚焦。
        focusable: process.platform !== 'linux',
        show: false,
        title: 'VCPChat 桌宠',
        webPreferences: {
            preload: path.join(paths.projectRoot, 'preloads', 'deskpet.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // 主窗口最小化时桌宠照常动；空闲暂停由页面自己做。
            backgroundThrottling: false,
        },
    });
    const pet = { win, agentId, ignoringMouse: true, hitPoll: null, drag: null, lastShape: '' };
    pet.director = createPetDirector({
        agentId,
        emit: (frame) => { if (!win.isDestroyed()) win.webContents.send('deskpet:frame', frame); },
    });
    pets.set(agentId, pet);

    win.setAlwaysOnTop(true, TOPMOST_LEVEL);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!USE_SHAPE) win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => {
        win.showInactive();
        // Windows 上透明窗口隐藏再显示后可能丢掉 WS_EX_TOPMOST，每次显示后重新声明。
        win.setAlwaysOnTop(true, TOPMOST_LEVEL);
        win.moveTop();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
        console.warn('[DeskPet] renderer gone:', details.reason);
        if (details.reason === 'clean-exit' || win.isDestroyed()) return;
        // 最多自动重载 3 次，避免模型本身有问题时无限崩溃重启。
        pet.crashes = (pet.crashes || 0) + 1;
        if (pet.crashes <= 3) setTimeout(() => !win.isDestroyed() && win.reload(), 250);
        else win.close();
    });
    win.on('closed', () => {
        clearInterval(pet.hitPoll);
        if (pet.drag) clearInterval(pet.drag.timer);
        pet.director.dispose();
        pets.delete(agentId);
        notifyMain(agentId);
    });
    win.loadURL(`${SCHEME}://pet/app/deskpet.html?agentId=${encodeURIComponent(agentId)}`);
    if (!USE_SHAPE) startHitPoll(pet);
    notifyMain(agentId);
    return { success: true, open: true };
}

function closePet(agentId) {
    const pet = pets.get(agentId);
    if (pet && !pet.win.isDestroyed()) pet.win.close();
    return { success: true, open: false };
}

function petFromEvent(event) {
    for (const pet of pets.values()) {
        if (!pet.win.isDestroyed() && pet.win.webContents === event.sender) return pet;
    }
    return null;
}

// ---- 回复流接入（chatHandlers 调用） ----------------------------------------

/** 该 agent 的桌宠打开时，返回要追加到 system prompt 的情绪标记协议。 */
function getSystemPromptAppend(agentId) {
    return agentId && pets.has(agentId) ? EMO_PROTOCOL_PROMPT : '';
}

function appendProtocolToMessages(messages, agentId) {
    const append = getSystemPromptAppend(agentId);
    if (!append || !Array.isArray(messages)) return messages;
    const first = messages[0];
    if (first && first.role === 'system' && typeof first.content === 'string') {
        return [{ ...first, content: `${first.content}\n\n${append}` }, ...messages.slice(1)];
    }
    return [{ role: 'system', content: append }, ...messages];
}

function onRequestStart(messageId, context) {
    const pet = context?.agentId && pets.get(context.agentId);
    if (pet) pet.director.begin(messageId);
}

function onStreamPayload(payload) {
    const pet = payload?.context?.agentId && pets.get(payload.context.agentId);
    if (!pet) return;
    try {
        if (payload.type === 'data') pet.director.data(payload.messageId, payload.chunk);
        else if (payload.type === 'end') pet.director.end(payload.messageId);
        else if (payload.type === 'error') pet.director.error(payload.messageId);
    } catch (error) {
        console.warn('[DeskPet] director failed:', error.message);
    }
}

/** 非流式回复：整条内容一次性喂给导演。 */
function onFullResponse(messageId, context, response) {
    const pet = context?.agentId && pets.get(context.agentId);
    if (!pet) return;
    const content = response?.choices?.[0]?.message?.content;
    if (typeof content === 'string') pet.director.data(messageId, { choices: [{ delta: { content } }] });
    pet.director.end(messageId);
}

// ---- IPC ----------------------------------------------------------------

function registerIpc() {
    ipcMain.handle('deskpet:toggle', async (_e, agentId) => {
        if (typeof agentId !== 'string' || !agentId) return { success: false, error: 'invalid-agent' };
        const result = await (pets.has(agentId) ? closePet(agentId) : openPet(agentId));
        return { ...result, openAgents: [...pets.keys()] };
    });
    ipcMain.handle('deskpet:get-open-agents', () => [...pets.keys()]);

    ipcMain.handle('deskpet:get-assets', (event) => {
        const pet = petFromEvent(event);
        return pet ? resolveAssets(pet.agentId) : null;
    });
    ipcMain.handle('deskpet:get-frame', (event) => petFromEvent(event)?.director.snapshot() || null);
    ipcMain.on('deskpet:hit', (event, hit) => {
        const pet = petFromEvent(event);
        if (pet) setIgnoreMouse(pet, !hit);
    });
    ipcMain.on('deskpet:content-bounds', (event, rect) => {
        const pet = petFromEvent(event);
        if (!USE_SHAPE || !pet || pet.win.isDestroyed() || !rect) return;
        const [w, h] = pet.win.getContentSize();
        const x = Math.max(0, Math.floor(rect.x));
        const y = Math.max(0, Math.floor(rect.y));
        const shape = { x, y, width: Math.min(w - x, Math.ceil(rect.width)), height: Math.min(h - y, Math.ceil(rect.height)) };
        const key = JSON.stringify(shape);
        if (key === pet.lastShape || shape.width <= 0 || shape.height <= 0) return;
        pet.lastShape = key;
        pet.win.setShape([shape]);
    });

    // 拖动在主进程里跟随光标，不用 -webkit-app-region：它在 Windows 上会吞点击，
    // 也没法和按像素穿透同时用。origin 是按下那一刻的屏幕坐标。
    ipcMain.on('deskpet:drag-start', (event, origin) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        const p = origin && Number.isFinite(origin.x) ? origin : screen.getCursorScreenPoint();
        const [wx, wy] = pet.win.getPosition();
        pet.drag = { dx: p.x - wx, dy: p.y - wy, timer: null };
        pet.drag.timer = setInterval(() => {
            if (pet.win.isDestroyed()) return;
            const c = screen.getCursorScreenPoint();
            pet.win.setBounds({ x: c.x - pet.drag.dx, y: c.y - pet.drag.dy, ...PET_SIZE });
        }, DRAG_TICK_MS);
    });
    ipcMain.on('deskpet:drag-end', (event) => {
        const pet = petFromEvent(event);
        if (!pet?.drag) return;
        clearInterval(pet.drag.timer);
        const c = screen.getCursorScreenPoint();
        // 混合 DPI 多屏之间 setPosition 可能顺带改尺寸，统一用 setBounds 固定宽高。
        pet.win.setBounds({ x: c.x - pet.drag.dx, y: c.y - pet.drag.dy, ...PET_SIZE });
        pet.drag = null;
        savePetPosition(pet.agentId, pet.win.getPosition()).catch(() => {});
    });

    ipcMain.on('deskpet:context-menu', (event) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        Menu.buildFromTemplate([
            {
                label: '打开主窗口',
                click: () => {
                    if (!mainWindow || mainWindow.isDestroyed()) return;
                    if (mainWindow.isMinimized()) mainWindow.restore();
                    mainWindow.show();
                    mainWindow.focus();
                },
            },
            { type: 'separator' },
            { label: '关闭桌宠', click: () => closePet(pet.agentId) },
        ]).popup({ window: pet.win });
    });
}

function initialize(options) {
    if (initialized) return;
    initialized = true;
    mainWindow = options.mainWindow || null;
    paths = {
        projectRoot: options.projectRoot,
        appDataRoot: options.appDataRoot,
        agentDir: options.agentDir,
    };
    registerProtocol();
    registerIpc();
    // 主窗口关掉时桌宠跟着关，否则剩下的透明窗口会让应用无法退出。
    mainWindow?.on?.('closed', closeAll);
}

function closeAll() {
    for (const agentId of [...pets.keys()]) closePet(agentId);
}

module.exports = {
    registerSchemes,
    initialize,
    closeAll,
    getSystemPromptAppend,
    appendProtocolToMessages,
    onRequestStart,
    onStreamPayload,
    onFullResponse,
    // 测试用
    _resolveServedFile: (url, testPaths) => {
        const previous = paths;
        paths = testPaths;
        try { return resolveServedFile(url); } finally { paths = previous; }
    },
};
