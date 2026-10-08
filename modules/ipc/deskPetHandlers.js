// modules/ipc/deskPetHandlers.js
// 桌宠（可选模块，默认关闭）：每个 agent 一个透明、无边框、置顶的小窗，
// 显示该 agent 的 Live2D 模型或差分立绘。可以在桌宠上直接和这个 agent 说话（经主窗口发送，
// 历史照常保存），回复以气泡显示，表情由页面里的情绪导演（modules/emotion）按回复流决定。
//
// 资源全部来自用户数据目录，VCPChat 不分发任何 Live2D 文件：
//   AppData/deskpet/live2dcubismcore.min.js     Cubism Core（必须是 5.x，用户自行放入）
//   AppData/Agents/<id>/deskpet/**/*.model3.json Live2D 模型（找到的第一个）
//   AppData/Agents/<id>/deskpet/**/*.puppet.json 网格立绘（一张图切块做的可动角色，不需要 Core）
//   AppData/Agents/<id>/portrait.<情绪>.<ext>    差分立绘，没有 Live2D 模型时使用
//   AppData/Agents/<id>/portrait.<ext>           默认立绘；再没有就用头像

const electron = require('electron');
const { BrowserWindow, ipcMain, protocol, net, screen, Menu } = electron;
const path = require('path');
const fs = require('fs-extra');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const petPrefs = require('../deskpet/petPrefs');
const { createPetControls } = require('../deskpet/petControls');
const { getAgentMoodStore } = require('../agentMood');

const SCHEME = 'vcp-deskpet';
// 窗口大小随每个桌宠自己的缩放走（modules/deskpet/petPrefs.js）；1 倍是 360×580，上方留出气泡和输入框的位置。
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
// 启动时恢复上次的桌宠：等主窗口载完再开，不和首屏抢。
const RESTORE_DELAY_MS = 1500;
// 滚轮调大小：攒够一格再变，触控板的细碎滚动不至于一下变好几档。
const WHEEL_NOTCH = 100;
// 窗口平时是否可聚焦（见 openPet）；输入框关上或页面重载后回到它。
const PET_FOCUSABLE = process.platform !== 'win32';

let paths = null; // { projectRoot, appDataRoot, agentDir }
let mainWindow = null;
let initialized = false;
const pets = new Map(); // agentId -> { win, scale, ignoringMouse, interactive, hitPoll, drag, lastShape }
const pendingSends = new Map(); // requestId -> resolve
let emotionPrompt = null; // modules/emotion/emotionPrompt.js（ESM，初始化时异步载入）
let controls = null; // modules/deskpet/petControls.js：全局设置、快捷键、设置窗口
let shuttingDown = false; // 退出时关窗口不算用户关掉，下次启动还要恢复
let lastTouched = null; // 最近一次被点、被叫出来的桌宠，「和桌宠说话」快捷键找它
let refreshTray = () => {};
let lastTalkedAgentId = null; // 最近一次发出请求的 agent，闹钟认不出是谁设的时交给它的桌宠
const alarms = new Map(); // id -> { timer, dueAt, text, maid }
const announcedTopics = new Set(); // 已经在桌宠上说过的话题（同一请求重放时结果会重复回来）

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

async function findBySuffix(dir, suffix, depth = 0) {
    if (depth > 3 || !(await fs.pathExists(dir))) return null;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const direct = entries.find((e) => e.isFile() && e.name.toLowerCase().endsWith(suffix));
    if (direct) return path.join(dir, direct.name);
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const found = await findBySuffix(path.join(dir, entry.name), suffix, depth + 1);
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
    const model = await findBySuffix(path.join(agentRoot, 'deskpet'), '.model3.json');
    const puppet = await findBySuffix(path.join(agentRoot, 'deskpet'), '.puppet.json');
    const hasCore = await fs.pathExists(coreFilePath());
    return {
        agentId,
        name,
        live2d: model ? { modelUrl: agentUrl(agentId, model) } : null,
        puppet: puppet ? { rigUrl: agentUrl(agentId, puppet) } : null,
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

// 读改写串行：拖动结束和改大小几乎同时保存时，后一次不会拿着旧内容把前一次盖掉。
let stateWrites = Promise.resolve();
function savePetState(agentId, patch) {
    stateWrites = stateWrites.then(async () => {
        const state = await readPetState();
        state[agentId] = { ...(state[agentId] || {}), ...patch };
        await fs.outputJson(petStatePath(), state, { spaces: 2 });
    }).catch((error) => console.warn('[DeskPet] state save failed:', error.message));
    return stateWrites;
}

function savePetPosition(agentId, position) {
    return savePetState(agentId, { x: position[0], y: position[1] });
}

function sizeOf(pet) {
    return petPrefs.windowSizeForScale(pet.scale);
}

function defaultPosition(index, size) {
    const area = screen.getPrimaryDisplay().workArea;
    return {
        x: area.x + area.width - size.width - 24 - index * 40,
        y: area.y + area.height - size.height,
    };
}

function isOnScreen(x, y, size) {
    return screen.getAllDisplays().some(({ workArea: a }) =>
        x + size.width > a.x && x < a.x + a.width && y + 40 > a.y && y < a.y + a.height);
}

function workAreaAt(bounds) {
    try {
        return (screen.getDisplayMatching?.(bounds) || screen.getPrimaryDisplay()).workArea;
    } catch {
        return screen.getPrimaryDisplay().workArea;
    }
}

function initialBounds(saved, size) {
    const fallback = defaultPosition(pets.size, size);
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return { ...size, ...fallback };
    // 位置不在任何显示器上（拔了外接屏）就回到默认位置。
    return { ...size, ...(isOnScreen(saved.x, saved.y, size) ? { x: saved.x, y: saved.y } : fallback) };
}

// 窗口位置和大小都从这里设。宽高总用算出来的值，不把 getBounds() 读回来的再写回去：
// Windows 在 125%/150% 缩放下读回来的宽高可能多了一两个像素，写回去就会越变越大。
function applyBounds(pet, bounds, { verify = true } = {}) {
    if (pet.win.isDestroyed()) return;
    pet.win.setBounds(bounds);
    if (!verify) return;
    const got = pet.win.getBounds();
    if (got.width === bounds.width && got.height === bounds.height) return;
    // 不可调整大小的窗口在部分缩放比例下 setBounds 改不动尺寸，临时放开再设一次
    pet.win.setResizable?.(true);
    pet.win.setBounds(bounds);
    pet.win.setResizable?.(false);
}

// 拔掉外接屏、改分辨率或缩放之后：不在任何屏上的桌宠挪回主屏，被系统改掉的窗口尺寸改回来，
// 新屏放不下的大小缩到放得下。
function fitPetsToDisplays() {
    let index = 0;
    for (const pet of pets.values()) {
        if (pet.win.isDestroyed() || pet.drag) continue;
        const b = pet.win.getBounds();
        const area = workAreaAt(b);
        const previous = { ...b, ...sizeOf(pet) };
        const fitted = petPrefs.fitScale(pet.scale, area);
        const scaleChanged = fitted !== pet.scale;
        pet.scale = fitted;
        const size = sizeOf(pet);
        const onScreen = isOnScreen(b.x, b.y, size);
        // 缩小了：脚底对齐、整个挪回这块屏里；没缩只是不在屏上：回默认位置
        const next = scaleChanged ? petPrefs.resizeAnchored(previous, size, area)
            : onScreen ? { x: b.x, y: b.y } : defaultPosition(index, size);
        if (scaleChanged || !onScreen || b.width !== size.width || b.height !== size.height) {
            applyBounds(pet, { ...next, ...size });
            if (scaleChanged || !onScreen) savePetState(pet.agentId, { x: next.x, y: next.y, ...(scaleChanged ? { scale: fitted } : {}) });
        }
        if (scaleChanged) {
            resetShape(pet);
            sendPrefs(pet);
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
    lastTouched = pet.agentId;
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
            // 光标在窗外时只用来让角色看过去；同一位置不重复发。
            if (pet.lastGaze !== `${p.x},${p.y}`) {
                pet.lastGaze = `${p.x},${p.y}`;
                pet.win.webContents.send('deskpet:cursor', { x: p.x - b.x, y: p.y - b.y, outside: true });
            }
            return;
        }
        pet.lastGaze = null;
        pet.win.webContents.send('deskpet:cursor', { x: p.x - b.x, y: p.y - b.y });
    }, HIT_POLL_MS);
}

// agent 目录名：单独一段，不能是 . 或 ..（否则会指到 Agents 目录本身或它的上级）。
function isAgentId(agentId) {
    return typeof agentId === 'string' && agentId.length > 0 && agentId !== '.' && agentId !== '..'
        && agentId === path.basename(agentId) && !/[\\/]/.test(agentId);
}

// anchor：在别的桌宠原来的位置打开（切换助手），按脚底中点对齐。
async function openPet(agentId, { anchor = null } = {}) {
    if (pets.has(agentId)) {
        showPet(pets.get(agentId));
        notifyMain(agentId);
        return { success: true, open: true };
    }
    if (!isAgentId(agentId) || !(await fs.pathExists(path.join(paths.agentDir, agentId)))) {
        return { success: false, error: 'agent-not-found' };
    }
    // 读状态期间同一个助手可能已经被另一次调用打开了（快捷键连按、启动恢复和点按钮撞在一起）
    const saved = (await readPetState())[agentId];
    if (pets.has(agentId)) return openPet(agentId);
    const scale = petPrefs.fitScale(saved?.scale ?? 1, workAreaAt(anchor || saved || screen.getPrimaryDisplay().workArea));
    const size = petPrefs.windowSizeForScale(scale);
    const win = new BrowserWindow({
        ...(anchor ? petPrefs.resizeAnchored(anchor, size, workAreaAt(anchor)) : initialBounds(saved, size)),
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
        // Windows：点宠物不抢走正在输入的程序的焦点，只在输入框打开时临时变成可聚焦。
        // macOS 不可聚焦的窗口收不到点击，Linux 窗口管理器对不可聚焦窗口的处理不一
        // （有的直接丢输入），这两处保持可聚焦。
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
    const pet = { win, agentId, scale, ignoringMouse: true, interactive: false, hitPoll: null, drag: null, lastShape: '', wheel: 0 };
    pets.set(agentId, pet);
    rememberOpen(agentId, true);

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
        if (lastTouched === agentId) lastTouched = null;
        // 用户关掉的下次不再恢复；退出时一起关掉的照旧恢复
        if (!shuttingDown) rememberOpen(agentId, false);
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
    applyBounds(pet, { x: c.x - drag.dx, y: c.y - drag.dy, ...sizeOf(pet) }, { verify: false });
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
    if (context?.agentId) lastTalkedAgentId = context.agentId;
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

/** 在同一个位置把桌宠换成另一个 agent（各自保留自己的大小，脚底对齐）。 */
async function switchPet(fromId, toId) {
    const pet = pets.get(fromId);
    if (!pet || fromId === toId) return;
    const anchor = pet.win.getBounds();
    if (pets.has(toId)) {
        const target = pets.get(toId);
        applyBounds(target, petPrefs.resizeAnchored(anchor, sizeOf(target), workAreaAt(anchor)));
        showPet(target);
    } else {
        const opened = await openPet(toId, { anchor });
        // 换不过去（助手刚被删掉）就留着原来的桌宠，不要两边都没了。
        if (!opened?.success) return;
    }
    closePet(fromId);
    const moved = pets.get(toId);
    if (moved && !moved.win.isDestroyed()) savePetPosition(toId, moved.win.getPosition());
}

// ---- 大小、免打扰、全部显示隐藏 ------------------------------------------------

function sendPrefs(pet) {
    if (!pet || pet.win.isDestroyed()) return;
    pet.win.webContents.send('deskpet:prefs', prefsFor(pet));
}

function prefsFor(pet) {
    const settings = controls?.get() || petPrefs.DEFAULT_SETTINGS;
    return { scale: pet.scale, doNotDisturb: settings.doNotDisturb };
}

/** 改一个桌宠的大小：脚底不动，放不下就缩到当前屏放得下。 */
function setPetScale(agentId, scale) {
    const pet = pets.get(agentId);
    if (!pet || pet.win.isDestroyed() || pet.drag) return null;
    const bounds = pet.win.getBounds();
    const area = workAreaAt(bounds);
    const next = petPrefs.fitScale(scale, area);
    if (next === pet.scale) return pet.scale;
    // 脚底位置按算出来的旧宽高定，不用读回来的（系统可能多算了一两个像素）
    const previous = { ...bounds, ...sizeOf(pet) };
    pet.scale = next;
    const target = petPrefs.resizeAnchored(previous, sizeOf(pet), area);
    applyBounds(pet, target);
    resetShape(pet);
    sendPrefs(pet);
    savePetState(agentId, { x: target.x, y: target.y, scale: next });
    controls?.refreshSettingsWindow();
    return next;
}

function stepPetScale(agentId, direction) {
    const pet = pets.get(agentId);
    if (!pet) return null;
    return setPetScale(agentId, pet.scale + Math.sign(direction) * petPrefs.SCALE_STEP);
}

// Linux 的输入区按旧窗口算的，换大小后让页面重新报一次
function resetShape(pet) {
    pet.lastShape = '';
}

function setDoNotDisturb(on) {
    controls?.update({ doNotDisturb: !!on });
}

function broadcastPrefs() {
    for (const pet of pets.values()) sendPrefs(pet);
}

function rememberOpen(agentId, open) {
    if (!controls) return;
    const current = controls.get().openAgents.filter((id) => id !== agentId);
    controls.update(open ? { openAgents: [...current, agentId], lastAgent: agentId } : { openAgents: current });
}

/** 快捷键「显示/隐藏桌宠」：有露着的就全部收起；都收着就全部叫回来；一个都没开就打开上次那个。 */
async function toggleAllPets() {
    const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
    const visible = live.filter((pet) => pet.win.isVisible());
    if (visible.length) {
        for (const pet of visible) pet.win.hide();
    } else if (live.length) {
        for (const pet of live) showPet(pet);
    } else {
        const settings = controls?.get();
        const candidates = [...(settings?.openAgents || []), settings?.lastAgent].filter(Boolean);
        for (const agentId of [...new Set(candidates)].slice(0, 1)) await openPet(agentId);
        if (!pets.size) openMainWindow();
    }
    for (const pet of live) notifyMain(pet.agentId);
    refreshTray();
}

/** 快捷键「和桌宠说话」：叫出最近用过的那个桌宠并打开输入框；输入框已经开着就收起。 */
async function talkToPet() {
    let pet = (lastTouched && pets.get(lastTouched)) || [...pets.values()].find((p) => !p.win.isDestroyed() && p.win.isVisible())
        || [...pets.values()].find((p) => !p.win.isDestroyed());
    if (!pet) {
        await toggleAllPets();
        pet = [...pets.values()][0];
        if (!pet) return;
    }
    if (!pet.win.isVisible()) {
        showPet(pet);
        notifyMain(pet.agentId);
    }
    lastTouched = pet.agentId;
    const send = () => !pet.win.isDestroyed() && pet.win.webContents.send('deskpet:open-input', { toggle: true });
    // 刚打开的桌宠页面还没载完，等它准备好再弹输入框
    if (pet.win.webContents.isLoading?.()) pet.win.webContents.once('did-finish-load', () => setTimeout(send, 300));
    else send();
}

function listPetsForSettings() {
    return [...pets.values()].filter((pet) => !pet.win.isDestroyed()).map((pet) => ({
        agentId: pet.agentId,
        name: pet.name || pet.agentId,
        scale: pet.scale,
        maxScale: petPrefs.maxScaleForWorkArea(workAreaAt(pet.win.getBounds())),
        visible: pet.win.isVisible(),
    }));
}

function scaleMenu(pet) {
    const presets = [0.6, 0.8, 1, 1.25, 1.5];
    const max = petPrefs.maxScaleForWorkArea(workAreaAt(pet.win.getBounds()));
    const shortcut = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
    return [
        { label: `放大（${shortcut}+滚轮）`, enabled: pet.scale < max, click: () => stepPetScale(pet.agentId, 1) },
        { label: '缩小', enabled: pet.scale > petPrefs.SCALE_MIN, click: () => stepPetScale(pet.agentId, -1) },
        { type: 'separator' },
        ...presets.map((value) => ({
            label: `${Math.round(value * 100)}%`,
            type: 'radio',
            checked: Math.abs(pet.scale - value) < 0.001,
            enabled: value <= max,
            click: () => setPetScale(pet.agentId, value),
        })),
    ];
}

/** 托盘菜单里的「桌宠」一项（main.js 建托盘菜单时调用）。 */
function trayMenuItems() {
    if (!controls) return [];
    const settings = controls.get();
    const live = [...pets.values()].filter((pet) => !pet.win.isDestroyed());
    const anyVisible = live.some((pet) => pet.win.isVisible());
    const hasCandidate = live.length > 0 || settings.openAgents.length > 0 || Boolean(settings.lastAgent);
    // 只显示快捷键，不在菜单里再注册一次（全局快捷键已经注册过了）
    const shortcut = (id) => (settings.shortcuts[id] ? { accelerator: settings.shortcuts[id], registerAccelerator: false } : {});
    return [{
        label: '桌宠',
        submenu: [
            { label: anyVisible ? '隐藏桌宠' : '显示桌宠', ...shortcut('toggle'), enabled: hasCandidate, click: () => toggleAllPets().catch(() => {}) },
            { label: '和桌宠说话', ...shortcut('talk'), enabled: hasCandidate, click: () => talkToPet().catch(() => {}) },
            { type: 'separator' },
            { label: '免打扰', type: 'checkbox', checked: settings.doNotDisturb, click: (item) => setDoNotDisturb(item.checked) },
            { label: '桌宠设置…', click: () => controls.openSettingsWindow() },
        ],
    }];
}

// 启动时打开上次开着的桌宠（设置里可以关掉）。
function restoreOpenPets() {
    const settings = controls?.get();
    if (!settings?.restoreOnLaunch || !settings.openAgents.length) return;
    (async () => {
        for (const agentId of settings.openAgents) {
            if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
            const result = await openPet(agentId).catch(() => null);
            // 助手被删掉了：从恢复列表里拿掉
            if (!result?.success) rememberOpen(agentId, false);
        }
    })();
}

function openMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}

// ---- 主动搭话：AI 主动开的新话题、闹钟到点 ---------------------------------------
// 这两样原本只在主窗口话题列表里冒个未读、或者弹一个独立的闹钟小窗；桌宠开着时让角色自己说出来。

const ALARM_MAX_DELAY_MS = 7 * 24 * 3600 * 1000;
const MAX_ALARMS = 50;

function proactive(agentId, payload) {
    const pet = pets.get(agentId);
    if (!pet || pet.win.isDestroyed()) return false;
    // 闹钟要叫得醒人：藏起来的桌宠也出来；新话题不打扰藏起来的桌宠，免打扰时也不说。
    if (payload.kind === 'alarm') showPet(pet);
    else if (!pet.win.isVisible() || controls?.get().doNotDisturb) return false;
    pet.win.webContents.send('deskpet:proactive', payload);
    return true;
}

async function agentIdByName(name) {
    if (!name) return null;
    const wanted = String(name).trim().toLowerCase();
    const agents = await listAgents().catch(() => []);
    const open = agents.filter((agent) => pets.has(agent.id));
    return open.find((agent) => agent.name.toLowerCase() === wanted || agent.id.toLowerCase() === wanted)?.id || null;
}

// 闹钟交给谁：设闹钟时说了是谁（maid）就找那个 agent 的桌宠；否则最近在聊的那个；再不行任意一个开着的。
async function alarmTarget(maid) {
    const named = await agentIdByName(maid);
    if (named) return named;
    if (lastTalkedAgentId && pets.has(lastTalkedAgentId)) return lastTalkedAgentId;
    return visibleAgents()[0] || [...pets.keys()][0] || null;
}

function parsePluginOutput(result) {
    if (result && typeof result === 'object') return result;
    const text = String(result || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// 角色写在第一句话里的情绪标签（<!--emo:…-->）和心流锁这类 [[…::…]] 控制标记不念出来
function spokenText(value) {
    return String(value || '').replace(/<!--[\s\S]*?-->/g, '').replace(/\[\[[A-Za-z]+::[^\]\n]*\]\]/g, '').trim();
}

// 同一个闹钟的结果回来两次（请求重放）时只记一个：提醒相同、到点时间差不到一分钟
const ALARM_SAME_MS = 60 * 1000;

function scheduleAlarm({ dueAt, text, maid }) {
    const delay = dueAt - Date.now();
    if (!Number.isFinite(delay) || delay < 0 || delay > ALARM_MAX_DELAY_MS || alarms.size >= MAX_ALARMS) return null;
    for (const alarm of alarms.values()) {
        if (alarm.text === text && alarm.maid === maid && Math.abs(alarm.dueAt - dueAt) < ALARM_SAME_MS) return null;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(async () => {
        alarms.delete(id);
        const agentId = await alarmTarget(maid);
        if (agentId) proactive(agentId, { kind: 'alarm', text: text || '时间到了！', at: dueAt });
    }, delay);
    timer.unref?.();
    alarms.set(id, { timer, dueAt, text, maid });
    return id;
}

/** 分布式服务器每执行完一个工具调用就告诉这里一声（只看结果，不改结果）。 */
function onDistributedToolResult(toolName, toolArgs = {}, result) {
    if (!initialized) return;
    if (toolName === 'TopicSponsor' && ['CreateTopic', 'CreateFlowlockTopic'].includes(toolArgs?.command)) {
        const info = parsePluginOutput(result);
        if (!info?.agent_id || !info.topic_id || announcedTopics.has(info.topic_id)) return;
        announcedTopics.add(info.topic_id);
        if (announcedTopics.size > 200) announcedTopics.delete(announcedTopics.values().next().value);
        proactive(info.agent_id, {
            kind: 'topic',
            title: String(info.topic_name || ''),
            text: spokenText(info.initial_message),
            topicId: String(info.topic_id),
        });
    } else if (toolName === 'VCPAlarm') {
        const info = parsePluginOutput(result);
        if (info?.status !== 'success' || !Number.isFinite(info.due_at)) return;
        scheduleAlarm({ dueAt: info.due_at, text: spokenText(info.reminder_text || toolArgs?.reminder_text), maid: toolArgs?.maid });
    }
}

// 点桌宠说的新话题：打开主窗口并切到那个话题（由主窗口按正常流程选中）。
// 话题可能在气泡还挂着时被删掉了：主窗口选中一个不存在的话题后，接着说的话会存进一份话题列表里看不到的历史，
// 所以先确认它还在这个助手的配置里。
async function openTopic(agentId, topicId) {
    openMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !isAgentId(agentId) || typeof topicId !== 'string' || !topicId) return false;
    let topics = [];
    try {
        topics = (await fs.readJson(path.join(paths.agentDir, agentId, 'config.json')))?.topics;
    } catch { /* 读不到配置就当话题不在了 */ }
    if (!Array.isArray(topics) || !topics.some((topic) => String(topic?.id) === topicId)) return false;
    if (mainWindow.isDestroyed()) return false;
    mainWindow.webContents.send('deskpet:open-topic', { agentId, topicId });
    return true;
}

// ---- 持续心情 ----------------------------------------------------------------

const MOOD_LABEL = {
    neutral: '🙂 平静', calm: '😌 放松', happy: '😊 开心', excited: '🤩 兴奋', shy: '😳 害羞', affectionate: '🥰 温柔',
    curious: '🤔 好奇', surprised: '😮 惊讶', concerned: '😟 担心', sad: '😢 难过', tired: '😪 疲惫', angry: '😠 生气',
};

async function readMood(agentId) {
    try {
        return (await getAgentMoodStore()?.get(agentId)) ?? null;
    } catch (_error) {
        return null;
    }
}

function moodMenuLabel(mood) {
    const label = MOOD_LABEL[mood?.emotion] || MOOD_LABEL.neutral;
    if (!mood || mood.emotion === 'neutral') return `现在的心情：${label}`;
    const degree = mood.intensity >= 0.6 ? '很' : mood.intensity >= 0.35 ? '' : '有点';
    return `现在的心情：${label.replace(' ', ` ${degree}`)}`;
}

// ---- IPC ----------------------------------------------------------------

function registerIpc() {
    ipcMain.handle('deskpet:toggle', async (_e, agentId) => {
        if (typeof agentId !== 'string' || !agentId) return { success: false, error: 'invalid-agent' };
        const pet = pets.get(agentId);
        // 隐藏着的桌宠：再点一次是叫回来，不是关掉。
        const result = await (pet && pet.win.isVisible() ? closePet(agentId) : openPet(agentId));
        refreshTray();
        return { ...result, openAgents: visibleAgents() };
    });
    ipcMain.handle('deskpet:get-open-agents', () => visibleAgents());
    ipcMain.on('deskpet:send-result', (_e, payload) => {
        pendingSends.get(payload?.requestId)?.(payload?.result);
    });

    ipcMain.handle('deskpet:get-assets', async (event) => {
        const pet = petFromEvent(event);
        if (!pet) return null;
        const assets = await resolveAssets(pet.agentId);
        pet.name = assets.name;
        return assets;
    });
    ipcMain.handle('deskpet:get-prefs', (event) => {
        const pet = petFromEvent(event);
        return pet ? prefsFor(pet) : null;
    });
    // 在角色上按住 Ctrl 滚滚轮调大小；deltaY 按像素给，攒够一格再变
    ipcMain.on('deskpet:wheel-resize', (event, deltaY) => {
        const pet = petFromEvent(event);
        const delta = Number(deltaY);
        if (!pet || !Number.isFinite(delta) || pet.drag) return;
        pet.wheel = (Math.sign(pet.wheel) === Math.sign(delta) ? pet.wheel : 0) + delta;
        if (Math.abs(pet.wheel) < WHEEL_NOTCH) return;
        // 往上滚（deltaY < 0）是放大
        stepPetScale(pet.agentId, -Math.sign(pet.wheel));
        pet.wheel = 0;
    });
    ipcMain.on('deskpet:touched', (event) => {
        const pet = petFromEvent(event);
        if (pet) lastTouched = pet.agentId;
    });
    // 这个助手的持续心情（modules/agentMood.js，和侧栏立绘同一份）：待机时显示它，之后跟着 agent-mood-changed 更新
    ipcMain.handle('deskpet:get-mood', async (event) => {
        const pet = petFromEvent(event);
        return pet ? readMood(pet.agentId) : null;
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
        } else if (!PET_FOCUSABLE) {
            // 输入框收起：回到不抢焦点的状态，之后点宠物也不会把正在打字的程序挤到后面
            pet.win.setFocusable(false);
        }
    });
    ipcMain.on('deskpet:open-main', () => openMainWindow());
    ipcMain.on('deskpet:open-topic', (event, topicId) => {
        const pet = petFromEvent(event);
        if (!pet) return;
        openTopic(pet.agentId, topicId).then((opened) => {
            if (!opened && !pet.win.isDestroyed()) pet.win.webContents.send('deskpet:topic-missing');
        }).catch((error) => console.warn('[DeskPet] open topic failed:', error.message));
    });
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
        const [agents, mood] = await Promise.all([listAgents().catch(() => []), readMood(pet.agentId)]);
        // 读助手列表期间桌宠可能已经被关掉了。
        if (pet.win.isDestroyed()) return;
        Menu.buildFromTemplate([
            { label: moodMenuLabel(mood), enabled: false },
            { type: 'separator' },
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
            { label: '大小', submenu: scaleMenu(pet) },
            {
                label: '免打扰',
                type: 'checkbox',
                checked: controls?.get().doNotDisturb === true,
                click: (item) => setDoNotDisturb(item.checked),
            },
            { label: '桌宠设置…', click: () => controls?.openSettingsWindow() },
            { type: 'separator' },
            {
                label: '隐藏桌宠',
                click: () => {
                    if (pet.win.isDestroyed()) return;
                    pet.win.hide();
                    notifyMain(pet.agentId);
                    refreshTray();
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
    controls = createPetControls({
        electron,
        appDataRoot: paths.appDataRoot,
        projectRoot: paths.projectRoot,
        settingsUrl: `${SCHEME}://pet/app/settings.html`,
        actions: {
            toggleAll: () => toggleAllPets().catch((error) => console.warn('[DeskPet] toggle failed:', error.message)),
            talk: () => talkToPet().catch((error) => console.warn('[DeskPet] talk failed:', error.message)),
            listPets: listPetsForSettings,
            setScale: (agentId, scale) => setPetScale(agentId, scale),
        },
    });
    controls.registerIpc();
    controls.onChange((_settings, changed) => {
        if (changed.includes('doNotDisturb')) broadcastPrefs();
        if (changed.some((key) => key === 'doNotDisturb' || key === 'shortcuts' || key === 'openAgents' || key === 'lastAgent')) refreshTray();
    });
    const settingsReady = controls.load().then(() => {
        controls.applyShortcuts();
        refreshTray();
    });
    // 主窗口载完以后再恢复上次的桌宠
    const scheduleRestore = () => settingsReady.then(() => setTimeout(restoreOpenPets, RESTORE_DELAY_MS));
    if (mainWindow?.webContents?.isLoading?.() === false && mainWindow.webContents.getURL?.()) scheduleRestore();
    else mainWindow?.webContents?.once?.('did-finish-load', scheduleRestore);
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
    // 退出（或主窗口关掉）时一起关：恢复列表保持原样，下次启动照旧打开
    shuttingDown = true;
    for (const agentId of [...pets.keys()]) closePet(agentId);
    controls?.dispose();
    for (const { timer } of alarms.values()) clearTimeout(timer);
    alarms.clear();
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
    // 托盘：main.js 建菜单时取「桌宠」这一项，并在桌宠状态变了时重建菜单
    trayMenuItems: isolated('trayMenuItems', trayMenuItems, []),
    setTrayRefresher: (fn) => { refreshTray = typeof fn === 'function' ? isolated('refreshTray', fn) : () => {}; },
    getSystemPromptAppend: isolated('getSystemPromptAppend', getSystemPromptAppend, ''),
    appendProtocolToMessages: isolated('appendProtocolToMessages', appendProtocolToMessages, (messages) => messages),
    onRequestStart: isolated('onRequestStart', onRequestStart),
    onStreamPayload: isolated('onStreamPayload', onStreamPayload),
    onFullResponse: isolated('onFullResponse', onFullResponse),
    onDistributedToolResult: isolated('onDistributedToolResult', onDistributedToolResult),
    // 测试用
    _promptReady: () => Boolean(emotionPrompt),
    _controls: () => controls,
    _pets: () => pets,
    _resolveServedFile: (url, testPaths) => {
        const previous = paths;
        paths = testPaths;
        try { return resolveServedFile(url); } finally { paths = previous; }
    },
};
