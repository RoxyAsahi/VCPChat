import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const prefs = require('../modules/deskpet/petPrefs.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 尺寸和设置（纯函数） ----

test('pet window sizes stay on a 4px grid so fractional display scaling does not round them up', () => {
    assert.deepEqual(prefs.windowSizeForScale(1), { width: 360, height: 580 });
    for (let scale = prefs.SCALE_MIN; scale <= prefs.SCALE_MAX + 1e-9; scale += 0.05) {
        const { width, height } = prefs.windowSizeForScale(scale);
        assert.equal(width % 4, 0, `width at ${scale}`);
        assert.equal(height % 4, 0, `height at ${scale}`);
        // 125%、150%、175% 下换成物理像素都是整数
        for (const factor of [1.25, 1.5, 1.75]) assert.ok(Number.isInteger(width * factor) && Number.isInteger(height * factor));
    }
    assert.ok(prefs.windowSizeForScale(0.5).width >= 280, '缩到最小也要放得下气泡和输入框');
    assert.equal(prefs.clampScale(9), prefs.SCALE_MAX);
    assert.equal(prefs.clampScale('nope'), 1);
});

test('resizing keeps the character standing on the same spot and inside the work area', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1040 };
    const before = { x: 1000, y: 400, width: 360, height: 580 };
    const after = prefs.resizeAnchored(before, prefs.windowSizeForScale(1.5), area);
    assert.equal(after.x + after.width / 2, before.x + before.width / 2, '脚底中点不动');
    assert.equal(after.y + after.height, before.y + before.height, '脚底高度不动');
    const corner = prefs.resizeAnchored({ x: 1700, y: 600, width: 360, height: 580 }, prefs.windowSizeForScale(1.5), area);
    assert.ok(corner.x + corner.width <= area.width && corner.y + corner.height <= area.height, '放大以后挪回屏幕里');
    assert.ok(prefs.maxScaleForWorkArea({ height: 600 }) < 1.2, '矮屏放不下的大小要缩');
});

test('shortcuts need real modifiers and never take what VCPChat already uses', () => {
    assert.equal(prefs.normalizeAccelerator('ctrl+alt+shift+p'), 'CommandOrControl+Alt+Shift+P');
    assert.equal(prefs.normalizeAccelerator('Alt+Ctrl+M'), 'CommandOrControl+Alt+M');
    assert.equal(prefs.normalizeAccelerator('Ctrl+F9'), 'CommandOrControl+F9');
    assert.equal(prefs.normalizeAccelerator(''), '');
    assert.equal(prefs.normalizeAccelerator('Ctrl+C'), null, '单个 Ctrl 加字母会抢走复制粘贴这类按键');
    assert.equal(prefs.normalizeAccelerator('Shift+F1+F2'), null);
    assert.equal(prefs.normalizeAccelerator('Shift+Alt'), null);
    assert.equal(prefs.normalizeAccelerator('Shift+F3'), 'Shift+F3');
    assert.equal(prefs.normalizeAccelerator('F3'), null);
    assert.ok(prefs.isReserved(prefs.normalizeAccelerator('Ctrl+Shift+P')));
    for (const accelerator of Object.values(prefs.DEFAULT_SETTINGS.shortcuts)) {
        assert.equal(prefs.normalizeAccelerator(accelerator), accelerator);
        assert.ok(!prefs.isReserved(accelerator));
    }
});

test('a hand-edited or broken settings file falls back to safe defaults', () => {
    assert.deepEqual(prefs.normalizeSettings(null), {
        doNotDisturb: false, restoreOnLaunch: true, shortcuts: { ...prefs.DEFAULT_SETTINGS.shortcuts }, openAgents: [], lastAgent: null,
    });
    const odd = prefs.normalizeSettings({
        doNotDisturb: 'yes',
        restoreOnLaunch: false,
        shortcuts: { toggle: 'Ctrl+Shift+I', talk: '' },
        openAgents: ['Nova', '../x', 'Nova', 5, 'Coco'],
        lastAgent: '..',
    });
    assert.equal(odd.doNotDisturb, false);
    assert.equal(odd.restoreOnLaunch, false);
    assert.equal(odd.shortcuts.toggle, prefs.DEFAULT_SETTINGS.shortcuts.toggle, '占用的组合回到默认');
    assert.equal(odd.shortcuts.talk, '', '留空表示不用');
    assert.deepEqual(odd.openAgents, ['Nova', 'Coco']);
    assert.equal(odd.lastAgent, null);
});

// ---- 主进程：大小、免打扰、快捷键、恢复 ----

function fakeElectron({ taken = [] } = {}) {
    const handlers = new Map();
    const listeners = new Map();
    const windows = [];
    const shortcuts = new Map();
    const screen = Object.assign(new EventEmitter(), {
        displays: [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
        cursor: { x: 0, y: 0 },
        getPrimaryDisplay() { return this.displays[0]; },
        getAllDisplays() { return this.displays; },
        getDisplayMatching() { return this.displays[0]; },
        getCursorScreenPoint() { return { ...this.cursor }; },
    });
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
            this.sent = [];
            this.visible = false;
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), {
                send: (channel, payload) => this.sent.push({ channel, payload }),
                isLoading: () => false,
                getURL: () => 'file://main.html',
                isDestroyed: () => this.destroyed,
                reload: () => { this.reloads = (this.reloads || 0) + 1; },
                setFrameRate() {},
                loadURL: (url) => { this.contentsUrl = url; return Promise.resolve(); },
                // 离屏快照：截到的是一张 40×80 的图
                capturePage: async (rect) => {
                    this.captured = rect;
                    return { isEmpty: () => false, getSize: () => ({ width: 40, height: 80 }), resize: () => this, toPNG: () => Buffer.from('png') };
                },
            });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        isMinimized() { return false; }
        show() { this.visible = true; this.emit('show'); }
        showInactive() { this.visible = true; this.emit('show'); }
        hide() { this.visible = false; this.emit('hide'); }
        close() { this.destroyed = true; this.emit('closed'); }
        destroy() { this.close(); }
        setContentSize(width, height) { this.bounds = { ...this.bounds, width, height }; }
        setAlwaysOnTop() {} moveTop() {} setVisibleOnAllWorkspaces() {} focus() {} loadURL(url) { this.url = url; } reload() {}
        restore() {} setMenu() {} setResizable() {}
        setIgnoreMouseEvents() {}
        setFocusable() {}
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
        getBounds() { return { ...this.bounds }; }
        setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
        getContentSize() { return [this.bounds.width, this.bounds.height]; }
    }
    const globalShortcut = {
        register(accelerator, fn) {
            if (taken.includes(accelerator) || shortcuts.has(accelerator)) return false;
            shortcuts.set(accelerator, fn);
            return true;
        },
        unregister(accelerator) { shortcuts.delete(accelerator); },
        isRegistered(accelerator) { return shortcuts.has(accelerator); },
    };
    const electron = {
        BrowserWindow,
        ipcMain: {
            handle: (channel, fn) => handlers.set(channel, fn),
            on: (channel, fn) => listeners.set(channel, fn),
        },
        protocol: { handle() {}, registerSchemesAsPrivileged() {} },
        net: {},
        Menu: {},
        screen,
        globalShortcut,
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
        shell: { openPath: async () => '' },
    };
    return { electron, handlers, listeners, windows, screen, shortcuts };
}

async function loadHandlers({ root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-ctl-')), taken = [] } = {}) {
    const fake = fakeElectron({ taken });
    const originalLoad = Module._load;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Module._load = function load(request, ...rest) {
        if (request === 'electron') return fake.electron;
        return originalLoad.call(this, request, ...rest);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    for (const name of ['../modules/ipc/deskPetHandlers.js', '../modules/deskpet/petControls.js']) delete require.cache[require.resolve(name)];
    let handlers;
    try {
        handlers = require('../modules/ipc/deskPetHandlers.js');
    } finally {
        Module._load = originalLoad;
        Object.defineProperty(process, 'platform', platform);
    }
    const agentDir = path.join(root, 'Agents');
    for (const id of ['Nova', 'Coco']) {
        fs.mkdirSync(path.join(agentDir, id), { recursive: true });
        fs.writeFileSync(path.join(agentDir, id, 'config.json'), JSON.stringify({ name: id }));
    }
    const mainWindow = new fake.electron.BrowserWindow({});
    handlers.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir });
    await sleep(20); // 等设置文件读完、快捷键注册好
    const petWindows = () => fake.windows.filter((w) => w.url?.includes('deskpet.html') && !w.destroyed);
    const open = async (agentId = 'Nova') => {
        await fake.handlers.get('deskpet:toggle')({}, agentId);
        const pet = fake.windows.at(-1);
        pet.emit('ready-to-show');
        // 页面载完形象、输入框能用了
        fake.listeners.get('deskpet:page-ready')({ sender: pet.webContents });
        return pet;
    };
    const fromPet = (pet) => ({ sender: pet.webContents });
    const settingsFile = path.join(root, 'deskpet', 'settings.json');
    const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    return { handlers, fake, open, fromPet, root, mainWindow, petWindows, settingsFile, readJson };
}

const bottomCenter = (b) => [b.x + b.width / 2, b.y + b.height];

test('ctrl+wheel resizes a pet around its feet and the size is remembered per agent', async () => {
    const env = await loadHandlers();
    const pet = await env.open('Nova');
    const before = pet.getBounds();
    const wheel = env.fake.listeners.get('deskpet:wheel-resize');
    wheel(env.fromPet(pet), -60); // 半格：不动
    assert.deepEqual(pet.getBounds(), before);
    wheel(env.fromPet(pet), -60);
    const grown = pet.getBounds();
    assert.ok(grown.width > before.width && grown.height > before.height, '往上滚放大');
    assert.deepEqual(bottomCenter(grown), bottomCenter(before), '脚底不动');
    assert.equal(pet.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.scale, 1.1);
    await sleep(30);
    env.handlers.closeAll();

    // 重新载入（相当于重启）：同一个助手按记住的大小和位置回来
    const again = await loadHandlers({ root: env.root });
    const reopened = await again.open('Nova');
    assert.deepEqual(reopened.getBounds(), grown);
    const prefsReply = await again.fake.handlers.get('deskpet:get-prefs')(again.fromPet(reopened));
    assert.equal(prefsReply.scale, 1.1);
    // 另一个助手不受影响
    const coco = await again.open('Coco');
    assert.deepEqual([coco.getBounds().width, coco.getBounds().height], [360, 580]);
    again.handlers.closeAll();
});

test('do not disturb reaches every open pet and the tray item reflects it', async () => {
    const env = await loadHandlers();
    const nova = await env.open('Nova');
    const coco = await env.open('Coco');
    let trayRebuilds = 0;
    env.handlers.setTrayRefresher(() => { trayRebuilds += 1; });
    const toggle = env.handlers.trayMenuItems()[0].submenu.find((item) => item.label === '免打扰');
    assert.equal(toggle.checked, false);
    toggle.click({ checked: true });
    for (const pet of [nova, coco]) assert.equal(pet.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.doNotDisturb, true);
    assert.ok(trayRebuilds > 0);
    assert.equal(env.handlers.trayMenuItems()[0].submenu.find((item) => item.label === '免打扰').checked, true);
    await sleep(300);
    assert.equal(env.readJson(env.settingsFile).doNotDisturb, true, '免打扰写进设置，重启后还在');
    env.handlers.closeAll();
});

test('global shortcuts hide and bring back the pets and open the input box', async () => {
    const env = await loadHandlers();
    const toggleKey = prefs.DEFAULT_SETTINGS.shortcuts.toggle;
    const talkKey = prefs.DEFAULT_SETTINGS.shortcuts.talk;
    assert.ok(env.fake.shortcuts.has(toggleKey) && env.fake.shortcuts.has(talkKey));
    const nova = await env.open('Nova');
    const coco = await env.open('Coco');
    await env.fake.shortcuts.get(toggleKey)();
    await sleep(5);
    assert.ok(!nova.isVisible() && !coco.isVisible(), '有露着的就全部收起');
    await env.fake.shortcuts.get(toggleKey)();
    await sleep(5);
    assert.ok(nova.isVisible() && coco.isVisible(), '再按一次全部回来');
    env.fake.listeners.get('deskpet:touched')(env.fromPet(nova));
    await env.fake.shortcuts.get(talkKey)();
    await sleep(5);
    assert.deepEqual(nova.sent.filter((m) => m.channel === 'deskpet:open-input').at(-1)?.payload, { toggle: true }, '最近碰过的那个弹输入框');
    assert.equal(coco.sent.some((m) => m.channel === 'deskpet:open-input'), false);
    env.handlers.closeAll();
    assert.equal(env.fake.shortcuts.size, 0, '退出时只注销自己的快捷键');
});

test('a shortcut another program holds is reported, and a reserved one is refused', async () => {
    const taken = [prefs.DEFAULT_SETTINGS.shortcuts.talk];
    const env = await loadHandlers({ taken });
    const controls = env.handlers._controls();
    assert.match(controls.failures().talk, /占用/);
    assert.equal(controls.setShortcut('toggle', 'Ctrl+Shift+P').success, false, 'VCPChat 自己的组合不给');
    assert.equal(controls.setShortcut('toggle', prefs.DEFAULT_SETTINGS.shortcuts.talk).success, false, '两个动作不能同一个键');
    const ok = controls.setShortcut('talk', 'Ctrl+Alt+K');
    assert.equal(ok.success, true);
    assert.ok(env.fake.shortcuts.has('CommandOrControl+Alt+K'));
    assert.ok(!env.fake.shortcuts.has(taken[0]));
    env.handlers.closeAll();
});

test('pets open at quit come back on the next launch; ones the user closed do not', async () => {
    const env = await loadHandlers();
    await env.open('Nova');
    const coco = await env.open('Coco');
    await env.fake.handlers.get('deskpet:toggle')({}, 'Coco'); // 用户关掉 Coco
    assert.ok(coco.destroyed);
    env.handlers.closeAll(); // 退出
    await sleep(250);
    assert.deepEqual(env.readJson(env.settingsFile).openAgents, ['Nova']);

    const again = await loadHandlers({ root: env.root });
    // 主窗口载完以后再恢复
    again.mainWindow.webContents.emit('did-finish-load');
    await sleep(1700);
    assert.deepEqual(again.petWindows().map((w) => decodeURIComponent(w.url.split('agentId=')[1])), ['Nova']);
    again.handlers.closeAll();
});

test('a smaller display shrinks a pet that no longer fits', async () => {
    const env = await loadHandlers();
    const pet = await env.open('Nova');
    env.handlers._controls(); // 已初始化
    await env.fake.handlers.get('deskpet-settings:set-scale')?.({ sender: null }, 'Nova', 2); // 不是设置窗口发的：不理
    assert.equal(pet.getBounds().width, 360);
    for (let i = 0; i < 6; i += 1) env.fake.listeners.get('deskpet:wheel-resize')(env.fromPet(pet), -100);
    assert.ok(pet.getBounds().height > 800);
    env.fake.screen.displays = [{ workArea: { x: 0, y: 0, width: 1280, height: 680 } }];
    env.fake.screen.emit('display-metrics-changed');
    await sleep(450);
    const b = pet.getBounds();
    assert.ok(b.height <= 680 && b.y >= 0 && b.y + b.height <= 680, `fits: ${JSON.stringify(b)}`);
    env.handlers.closeAll();
});

// ---- 全局设置 → 桌宠 ----

const fromMain = (env) => ({ sender: env.mainWindow.webContents });

function addOutfit(env, agentId, folder, name) {
    const dir = path.join(env.root, 'Agents', agentId, 'deskpet', folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'portrait.png'), 'x');
    fs.writeFileSync(path.join(dir, 'outfit.json'), JSON.stringify({ name, description: `${name}的介绍` }));
}

test('the settings page only answers the main window and lists the outfits of one agent', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    addOutfit(env, 'Nova', 'tech', '科技服');
    const catalog = env.fake.handlers.get('deskpet-settings:catalog');
    assert.equal(await catalog({ sender: null }, 'Nova'), null, '不是主窗口发的不理');
    const page = await catalog(fromMain(env), 'Nova');
    assert.equal(page.agentId, 'Nova');
    assert.deepEqual(page.outfits.map((o) => o.name), ['科技服', '女仆'].sort((a, b) => a.localeCompare(b, 'zh')));
    assert.equal(page.outfits.find((o) => o.id === 'maid').description, '女仆的介绍');
    assert.equal(page.open, false);
    assert.equal(page.outfit, null, '关着的桌宠选中的是「无」');
    assert.deepEqual(page.agents.map((a) => a.id).sort(), ['Coco', 'Nova']);
    env.handlers.closeAll();
});

test('picking a card opens the pet in that outfit, picking none closes it', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    addOutfit(env, 'Nova', 'tech', '科技服');
    const choose = env.fake.handlers.get('deskpet-settings:choose');
    const result = await choose(fromMain(env), 'Nova', 'tech');
    assert.equal(result.success, true);
    const pet = env.petWindows()[0];
    assert.ok(pet, '没开着的桌宠打开了');
    assert.equal(env.readJson(path.join(env.root, 'deskpet', 'state.json')).Nova.outfit, 'tech', '直接按选的那套开');
    pet.emit('ready-to-show');
    assert.equal(result.catalog.outfit, 'tech');
    const switched = await choose(fromMain(env), 'Nova', 'maid');
    assert.equal(switched.catalog.outfit, 'maid', '开着的桌宠换装');
    const none = await choose(fromMain(env), 'Nova', '');
    assert.equal(none.success, true);
    assert.equal(env.petWindows().length, 0, '「无」收起这个助手的桌宠');
    assert.equal(none.catalog.outfit, null);
    assert.equal((await choose(fromMain(env), '../x', 'maid')).success, false);
    env.handlers.closeAll();
});

test('words typed in the settings preview wait until the pet page is ready, then the pet sends them', async () => {
    const env = await loadHandlers();
    const talk = env.fake.handlers.get('deskpet-settings:talk');
    assert.equal((await talk(fromMain(env), 'Nova', '   ')).success, false);
    const result = await talk(fromMain(env), 'Nova', '你好');
    assert.equal(result.success, true);
    const pet = env.petWindows()[0];
    pet.emit('ready-to-show');
    assert.equal(pet.sent.some((m) => m.channel === 'deskpet:open-input'), false, '页面还没好，先不发');
    env.fake.listeners.get('deskpet:page-ready')({ sender: pet.webContents });
    assert.deepEqual(pet.sent.filter((m) => m.channel === 'deskpet:open-input').at(-1)?.payload, { submit: '你好' });
    env.handlers.closeAll();
});

test('show and hide from the settings page, and a closed pet remembers the size set there', async () => {
    const env = await loadHandlers();
    const visible = env.fake.handlers.get('deskpet-settings:set-visible');
    let page = await visible(fromMain(env), true, 'Coco');
    const coco = env.petWindows()[0];
    coco.emit('ready-to-show');
    assert.ok(coco.url.includes('agentId=Coco'), '一个都没开时打开正在看的那个助手');
    page = await visible(fromMain(env), false, 'Coco');
    assert.equal(coco.isVisible(), false);
    assert.equal(page.anyVisible, false);
    await env.fake.handlers.get('deskpet-settings:set-scale')(fromMain(env), 'Nova', 1.5);
    await sleep(30);
    assert.equal(env.readJson(path.join(env.root, 'deskpet', 'state.json')).Nova.scale, 1.5);
    env.handlers.closeAll();
});

test('card snapshots are rendered offscreen once and reused while the files stay the same', async () => {
    const env = await loadHandlers();
    addOutfit(env, 'Nova', 'maid', '女仆');
    const catalog = env.fake.handlers.get('deskpet-settings:catalog');
    const first = await catalog(fromMain(env), 'Nova');
    assert.equal(first.outfits[0].preview, null, '第一次没有现成的快照');
    const offscreen = env.fake.windows.find((w) => w.options.webPreferences?.offscreen);
    assert.ok(offscreen, '在离屏窗口里画');
    assert.match(offscreen.contentsUrl, /preview=1/);
    // 离屏页面问自己该画谁
    const assets = await env.fake.handlers.get('deskpet:get-assets')({ sender: offscreen.webContents });
    assert.equal(assets.preview, true);
    assert.equal(assets.outfit.id, 'maid');
    env.fake.listeners.get('deskpet:preview-ready')({ sender: offscreen.webContents }, { bounds: { x: 100, y: 200, width: 120, height: 300 }, aspect: 2.5 });
    await sleep(50);
    assert.deepEqual(offscreen.captured, { x: 94, y: 194, width: 132, height: 312 }, '只截角色那一块，四周留一点边');
    const pushed = env.mainWindow.sent.find((m) => m.channel === 'deskpet-settings:preview');
    assert.equal(pushed.payload.outfitId, 'maid');
    assert.match(pushed.payload.url, /^file:.*\.png\?v=/);
    const second = await catalog(fromMain(env), 'Nova');
    assert.equal(second.outfits[0].preview, pushed.payload.url, '文件没变就直接用');
    env.handlers.closeAll();
});
