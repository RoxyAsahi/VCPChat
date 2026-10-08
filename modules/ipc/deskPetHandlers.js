// modules/ipc/deskPetHandlers.js
// 桌宠（可选模块，默认关闭）：每个 agent 一个透明、无边框、置顶的小窗，
// 显示该 agent 的 Live2D 模型或差分立绘。可以在桌宠上直接和这个 agent 说话（经主窗口发送，
// 历史照常保存），回复以气泡显示，表情由页面里的情绪导演（modules/emotion）按回复流决定。
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
const crypto = require('crypto');

const SCHEME = 'vcp-deskpet';
// 上方留出气泡和输入框的位置。
const PET_SIZE = { width: 360, height: 580 };
// Windows：'pop-up-menu' 压住任务栏，又不像 'screen-saver' 那样和全屏程序抢；
// macOS 需要 'screen-saver' 才能浮在全屏空间之上。
const TOPMOST_LEVEL = process.platform === 'darwin' ? 'screen-saver' : 'pop-up-menu';
const HIT_POLL_MS = 50;
const DRAG_TICK_MS = 16;
// X11 上整窗穿透后 Chromium 收不到指针，getCursorScreenPoint() 会停在旧坐标，
// 光标轮询就再也发现不了宠物；Linux 改为把窗口输入区裁到内容包围盒。
const USE_SHAPE = process.platform === 'linux';
const IMAGE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg', 'gif', 'avif'];
// 与 modules/emotion/emotionVocabulary.js 一致：12 个情绪键加 3 个状态键。
const PORTRAIT_KEYS = ['neutral', 'calm', 'happy', 'excited', 'shy', 'affectionate', 'curious',
    'surprised', 'concerned', 'sad', 'tired', 'angry', 'thinking', 'tool', 'error'];
const SEND_TIMEOUT_MS = 10000;
const DRAG_MAX_MS = 60000;
const DISPLAY_SETTLE_MS = 400;
// 窗口创建时的可聚焦设置（见 openPet）；输入框关上或页面重载后回到它。
const PET_FOCUSABLE = process.platform !== 'linux';

let paths = null; // { projectRoot, appDataRoot, agentDir }
let mainWindow = null;
let initialized = false;
const pets = new Map(); // agentId -> { win, ignoringMouse, interactive, hitPoll, drag, lastShape }
const pendingSends = new Map(); // requestId -> resolve
let emotionPrompt = null; // modules/emotion/emotionPrompt.js（ESM，初始化时异步载入）

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
    if (root === 'emotion') return guard(path.join(paths.projectRoot, 'modules', 'emotion'), segments);
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
    // 与侧栏立绘相同的结构：{ default, light?, <键>?, <键>-light? }，交给 resolvePortrait 挑图。
    const portraits = {};
    const defaultPortrait = pick('portrait');
    if (defaultPortrait) portraits.default = defaultPortrait;
    const lightPortrait = pick('portrait.light');
    if (lightPortrait) portraits.light = lightPortrait;
    for (const key of PORTRAIT_KEYS) {
        const url = pick(`portrait.${key}`);
        if (url) portraits[key] = url;
        const light = pick(`portrait.${key}-light`);
        if (light) portraits[`${key}-light`] = light;
    }
    if (!portraits.default) {
        // 只有差分没有默认立绘时，用 neutral / calm 顶上。
        const fallback = portraits.neutral || portraits.calm || Object.values(portraits)[0];
        if (fallback) portraits.default = fallback;
    }
    const model = await findModel3(path.join(agentRoot, 'deskpet'));
    const hasCore = await fs.pathExists(coreFilePath());
    return {
        agentId,
        name,
        live2d: model ? { modelUrl: agentUrl(agentId, model) } : null,
        coreUrl: hasCore ? `${SCHEME}://pet/core/live2dcubismcore.min.js` : null,
        corePath: coreFilePath(),
        portraits: portraits.default ? portraits : null,
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

function defaultPosition(index) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
        x: area.x + area.width - PET_SIZE.width - 24 - index * 40,
        y: area.y + area.height - PET_SIZE.height,
    };
}

function isOnScreen(x, y) {
    return screen.getAllDisplays().some(({ workArea: a }) =>
        x + PET_SIZE.width > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height);
}

function initialBounds(saved) {
    const fallback = defaultPosition(pets.size);
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { ...PET_SIZE, ...fallback };
    // 位置不在任何显示器上（拔了外接屏）就回到默认位置。
    return { ...PET_SIZE, ...(isOnScreen(saved.x, saved.y) ? { x: saved.x, y: saved.y } : fallback) };
}

// 拔掉外接屏、改分辨率或缩放之后：不在任何屏上的桌宠挪回主屏，被系统改掉的窗口尺寸改回来。
function fitPetsToDisplays() {
    let index = 0;
    for (const pet of pets.values()) {
        if (pet.win.isDestroyed() || pet.drag) continue;
        const b = pet.win.getBounds();
        const onScreen = isOnScreen(b.x, b.y);
        const next = onScreen ? { x: b.x, y: b.y } : defaultPosition(index);
        if (!onScreen || b.width !== PET_SIZE.width || b.height !== PET_SIZE.height) {
            pet.win.setBounds({ ...next, ...PET_SIZE });
            if (!onScreen) savePetPosition(pet.agentId, [next.x, next.y]).catch(() => {});
        }
        index += 1;
    }
}

let displayTimer = null;
function onDisplaysChanged() {
    // 改缩放、远程桌面重连时这些事件会连发，等它们停下来再处理。
    clearTimeout(displayTimer);
    displayTimer = setTimeout(() => {
        displayTimer = null;
        try { fitPetsToDisplays(); } catch (error) { console.warn('[DeskPet] display change:', error.message); }
    }, DISPLAY_SETTLE_MS);
}

function visibleAgents() {
    return [...pets.entries()].filter(([, pet]) => !pet.win.isDestroyed() && pet.win.isVisible()).map(([id]) => id);
}

function notifyMain(agentId) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        const openAgents = visibleAgents();
        mainWindow.webContents.send('deskpet:state-changed', { agentId, open: openAgents.includes(agentId), openAgents });
    }
}

function showPet(pet) {
    pet.win.showInactive();
    // Windows 上透明窗口隐藏再显示后可能丢掉 WS_EX_TOPMOST，每次显示后重新声明。
    pet.win.setAlwaysOnTop(true, TOPMOST_LEVEL);
    pet.win.moveTop();
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
        if (pet.win.isDestroyed() || pet.drag || pet.interactive || !pet.win.isVisible()) return;
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

// agent 目录名：单独一段，不能是 . 或 ..（否则会指到 Agents 目录本身或它的上级）。
function isAgentId(agentId) {
    return typeof agentId === 'string' && agentId.length > 0 && agentId !== '.' && agentId !== '..'
        && agentId === path.basename(agentId) && !/[\\/]/.test(agentId);
}

async function openPet(agentId, { bounds = null } = {}) {
    if (pets.has(agentId)) {
        showPet(pets.get(agentId));
        notifyMain(agentId);
        return { success: true, open: true };
    }
    if (!isAgentId(agentId) || !(await fs.pathExists(path.join(paths.agentDir, agentId)))) {
        return { success: false, error: 'agent-not-found' };
    }
    const saved = (await readPetState())[agentId];
    const win = new BrowserWindow({
        ...(bounds ? { ...PET_SIZE, x: bounds.x, y: bounds.y } : initialBounds(saved)),
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
        focusable: PET_FOCUSABLE,
        show: false,
        title: 'VCPChat 桌宠',
        webPreferences: {
            preload: path.join(paths.projectRoot, 'preloads', 'deskpet.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // 主窗口最小化时桌宠照常动；空闲降帧和隐藏时暂停由页面自己做。
            backgroundThrottling: false,
        },
    });
    const pet = { win, agentId, ignoringMouse: true, interactive: false, hitPoll: null, drag: null, lastShape: '' };
    pets.set(agentId, pet);

    win.setAlwaysOnTop(true, TOPMOST_LEVEL);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!USE_SHAPE) win.setIgnoreMouseEvents(true, { forward: true });
    win.once('ready-to-show', () => {
        showPet(pet);
        notifyMain(agentId);
    });
    // 第一次载入时状态本来就是初始值；之后的重载（崩溃恢复、刷新）要把主进程这边也清零。
    win.webContents.on('did-start-loading', () => resetInputState(pet));
    win.webContents.on('render-process-gone', (_e, details) => {
        console.warn('[DeskPet] renderer gone:', details.reason);
        if (win.isDestroyed()) return;
        resetInputState(pet);
        if (details.reason === 'clean-exit') return;
        // 最多自动重载 3 次，避免模型本身有问题时无限崩溃重启。
        pet.crashes = (pet.crashes || 0) + 1;
        if (pet.crashes <= 3) setTimeout(() => !win.isDestroyed() && win.reload(), 250);
        else win.close();
    });
    // 窗口开着时关了后台节流（主窗口最小化时桌宠照常动），隐藏时页面感觉不到，主动告诉它停下。
    const sendVisibility = (visible) => !win.isDestroyed() && win.webContents.send('deskpet:visibility', visible);
    win.on('hide', () => sendVisibility(false));
    win.on('show', () => sendVisibility(true));
    win.on('closed', () => {
        clearInterval(pet.hitPoll);
        stopDrag(pet);
        pets.delete(agentId);
        notifyMain(agentId);
    });
    win.loadURL(`${SCHEME}://pet/app/deskpet.html?agentId=${encodeURIComponent(agentId)}`);
    if (!USE_SHAPE) startHitPoll(pet);
    notifyMain(agentId);
    return { success: true, open: true };
}

// 混合 DPI 多屏之间 setPosition 可能顺带改尺寸，统一用 setBounds 固定宽高。
function moveWithCursor(pet, drag) {
    const c = screen.getCursorScreenPoint();
    pet.win.setBounds({ x: c.x - drag.dx, y: c.y - drag.dy, ...PET_SIZE });
}

function stopDrag(pet, { save = false } = {}) {
    if (!pet.drag) return;
    clearInterval(pet.drag.timer);
    pet.drag = null;
    if (save && !pet.win.isDestroyed()) savePetPosition(pet.agentId, pet.win.getPosition()).catch(() => {});
}

// 页面重新载入（崩溃自动重载、刷新）时，页面那边的命中、输入框、拖动状态都清零了，
// 主进程这边也要回到初始状态：否则上一次的「可点击」会让一块看不见的窗口挡住桌面。
function resetInputState(pet) {
    stopDrag(pet, { save: true });
    pet.interactive = false;
    pet.lastShape = '';
    if (pet.win.isDestroyed()) return;
    pet.win.setFocusable(PET_FOCUSABLE);
    if (!USE_SHAPE) {
        pet.ignoringMouse = null;
        setIgnoreMouse(pet, true);
    }
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

/** 该 agent 的桌宠打开时，返回要追加到 system prompt 的情绪标记说明（与侧栏差分立绘共用一段）。 */
function getSystemPromptAppend(agentId, systemPrompt = '') {
    if (!agentId || !pets.has(agentId) || !emotionPrompt) return '';
    // 侧栏立绘已经加过、或者角色自己的提示词里写了标记说明，就不再重复。
    if (!emotionPrompt.shouldAddEmotionTagPrompt({ systemPrompt, hasDisplay: true })) return '';
    return emotionPrompt.EMOTION_TAG_PROMPT;
}

function appendProtocolToMessages(messages, agentId) {
    if (!Array.isArray(messages)) return messages;
    const first = messages[0];
    const hasSystem = first && first.role === 'system' && typeof first.content === 'string';
    const append = getSystemPromptAppend(agentId, hasSystem ? first.content : '');
    if (!append) return messages;
    if (hasSystem) return [{ ...first, content: `${first.content}\n\n${append}` }, ...messages.slice(1)];
    return [{ role: 'system', content: append }, ...messages];
}

function extractDeltaText(chunk) {
    if (typeof chunk === 'string') return chunk;
    const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : null;
    const delta = choice?.delta || choice?.message || {};
    return typeof delta.content === 'string' ? delta.content : '';
}

// 回复流原样转给页面，由页面里的情绪导演决定表情和气泡内容。
function forward(agentId, event) {
    const pet = agentId && pets.get(agentId);
    if (pet && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:stream', event);
}

function onRequestStart(messageId, context) {
    forward(context?.agentId, { type: 'start', messageId: String(messageId) });
}

function onStreamPayload(payload) {
    const agentId = payload?.context?.agentId;
    if (!agentId || !pets.has(agentId)) return;
    const messageId = String(payload.messageId);
    if (payload.type === 'data') {
        const text = extractDeltaText(payload.chunk);
        if (text) forward(agentId, { type: 'data', messageId, text });
    } else if (payload.type === 'end' || payload.type === 'error') {
        forward(agentId, { type: payload.type, messageId });
    }
}

/** 非流式回复：整条内容一次性转过去。 */
function onFullResponse(messageId, context, response) {
    const agentId = context?.agentId;
    if (!agentId || !pets.has(agentId)) return;
    const text = response?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) forward(agentId, { type: 'data', messageId: String(messageId), text });
    forward(agentId, { type: 'end', messageId: String(messageId) });
}

// ---- 从桌宠发消息：交给主窗口按正常流程发送 -----------------------------------

function sendFromPet(agentId, text) {
    if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve({ success: false, error: '主窗口不在了' });
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingSends.delete(requestId);
            resolve({ success: false, error: '主窗口没有响应' });
        }, SEND_TIMEOUT_MS);
        pendingSends.set(requestId, (result) => {
            clearTimeout(timer);
            pendingSends.delete(requestId);
            resolve(result || { success: false });
        });
        mainWindow.webContents.send('deskpet:send-request', { requestId, agentId, text });
    });
}

async function listAgents() {
    const ids = (await fs.pathExists(paths.agentDir)) ? await fs.readdir(paths.agentDir) : [];
    const agents = [];
    for (const id of ids) {
        try {
            const config = await fs.readJson(path.join(paths.agentDir, id, 'config.json'));
            agents.push({ id, name: config?.name || id });
        } catch { /* 不是 agent 目录 */ }
    }
    return agents;
}

/** 在同一个位置把桌宠换成另一个 agent。 */
async function switchPet(fromId, toId) {
    const pet = pets.get(fromId);
    if (!pet || fromId === toId) return;
    const [x, y] = pet.win.getPosition();
    if (pets.has(toId)) {
        pets.get(toId).win.setPosition(x, y);
        showPet(pets.get(toId));
    } else {
        const opened = await openPet(toId, { bounds: { x, y } });
        // 换不过去（助手刚被删掉）就留着原来的桌宠，不要两边都没了。
        if (!opened?.success) return;
    }
    closePet(fromId);
    savePetPosition(toId, [x, y]).catch(() => {});
}

function openMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// ---- IPC ----------------------------------------------------------------

function registerIpc() {
    ipcMain.handle('deskpet:toggle', async (_e, agentId) => {
        if (typeof agentId !== 'string' || !agentId) return { success: false, error: 'invalid-agent' };
        const pet = pets.get(agentId);
        // 隐藏着的桌宠：再点一次是叫回来，不是关掉。
        const result = await (pet && pet.win.isVisible() ? closePet(agentId) : openPet(agentId));
        return { ...result, openAgents: visibleAgents() };
    });
    ipcMain.handle('deskpet:get-open-agents', () => visibleAgents());
    ipcMain.on('deskpet:send-result', (_e, payload) => {
        pendingSends.get(payload?.requestId)?.(payload?.result);
    });

    ipcMain.handle('deskpet:get-assets', (event) => {
        const pet = petFromEvent(event);
        return pet ? resolveAssets(pet.agentId) : null;
    });
    ipcMain.handle('deskpet:send', async (event, text) => {
        const pet = petFromEvent(event);
        const message = typeof text === 'string' ? text.trim() : '';
        if (!pet || !message) return { success: false, error: '没有内容' };
        return sendFromPet(pet.agentId, message.slice(0, 8000));
    });
    // 输入框打开时整窗可点、可聚焦；关上后回到按像素穿透。
    ipcMain.on('deskpet:set-interactive', (event, on) => {
        const pet = petFromEvent(event);
        if (!pet || pet.win.isDestroyed()) return;
        pet.interactive = !!on;
        if (on) {
            if (!USE_SHAPE) setIgnoreMouse(pet, false);
            pet.win.setFocusable(true);
            pet.win.focus();
        }
    });
    ipcMain.on('deskpet:open-main', () => openMainWindow());
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
        if (!pet || pet.win.isDestroyed()) return;
        // 上一次拖动的 pointerup 丢了（触屏 pointercancel、拖动中弹出菜单）时还会再来一次 drag-start；
        // 先收掉旧的定时器，否则它会一直跟着光标，drag-end 之后还会每帧抛异常。
        stopDrag(pet);
        const p = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? origin : screen.getCursorScreenPoint();
        const [wx, wy] = pet.win.getPosition();
        const drag = { dx: p.x - wx, dy: p.y - wy, timer: null, startedAt: Date.now() };
        drag.timer = setInterval(() => {
            if (pet.win.isDestroyed() || pet.drag !== drag) {
                clearInterval(drag.timer);
                return;
            }
            // 兜底：页面再也没发 drag-end（渲染进程卡死），不让窗口永远粘在光标上。
            if (Date.now() - drag.startedAt > DRAG_MAX_MS) {
                stopDrag(pet, { save: true });
                return;
            }
            moveWithCursor(pet, drag);
        }, DRAG_TICK_MS);
        pet.drag = drag;
    });
    ipcMain.on('deskpet:drag-end', (event) => {
        const pet = petFromEvent(event);
        if (!pet?.drag || pet.win.isDestroyed()) return;
        moveWithCursor(pet, pet.drag);
        stopDrag(pet, { save: true });
    });

    ipcMain.on('deskpet:context-menu', async (event) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        const agents = await listAgents().catch(() => []);
        // 读助手列表期间桌宠可能已经被关掉了。
        if (pet.win.isDestroyed()) return;
        Menu.buildFromTemplate([
            { label: '和 TA 说话', click: () => !pet.win.isDestroyed() && pet.win.webContents.send('deskpet:open-input') },
            {
                label: '切换助手',
                enabled: agents.length > 1,
                submenu: agents.map((agent) => ({
                    label: agent.name,
                    type: 'radio',
                    checked: agent.id === pet.agentId,
                    click: () => switchPet(pet.agentId, agent.id).catch((error) => console.warn('[DeskPet] switch failed:', error.message)),
                })),
            },
            { label: '打开主窗口', click: openMainWindow },
            { type: 'separator' },
            {
                label: '隐藏桌宠',
                click: () => {
                    if (pet.win.isDestroyed()) return;
                    pet.win.hide();
                    notifyMain(pet.agentId);
                },
            },
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
    screen.on('display-removed', onDisplaysChanged);
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-metrics-changed', onDisplaysChanged);
    import(pathToFileURL(path.join(paths.projectRoot, 'modules', 'emotion', 'emotionPrompt.js')).href)
        .then((mod) => { emotionPrompt = mod; })
        .catch((error) => console.warn('[DeskPet] emotion prompt unavailable:', error.message));
    // 主窗口关掉时桌宠跟着关，否则剩下的透明窗口会让应用无法退出。
    mainWindow?.on?.('closed', closeAll);
}

function closeAll() {
    for (const agentId of [...pets.keys()]) closePet(agentId);
}

// chatHandlers 在主聊天的发送和流式路径上调用这些钩子；桌宠出任何错都不能打断主聊天。
function isolated(name, fn, fallback) {
    return (...args) => {
        try {
            return fn(...args);
        } catch (error) {
            console.warn(`[DeskPet] ${name} failed:`, error?.message || error);
            return typeof fallback === 'function' ? fallback(...args) : fallback;
        }
    };
}

module.exports = {
    registerSchemes,
    initialize,
    closeAll,
    getSystemPromptAppend: isolated('getSystemPromptAppend', getSystemPromptAppend, ''),
    appendProtocolToMessages: isolated('appendProtocolToMessages', appendProtocolToMessages, (messages) => messages),
    onRequestStart: isolated('onRequestStart', onRequestStart),
    onStreamPayload: isolated('onStreamPayload', onStreamPayload),
    onFullResponse: isolated('onFullResponse', onFullResponse),
    // 测试用
    _promptReady: () => Boolean(emotionPrompt),
    _resolveServedFile: (url, testPaths) => {
        const previous = paths;
        paths = testPaths;
        try { return resolveServedFile(url); } finally { paths = previous; }
    },
};
