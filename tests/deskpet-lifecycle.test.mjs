import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假的 electron：窗口记录位置、穿透和可聚焦状态，屏幕可以换布局、光标可以挪。
function fakeElectron() {
    const handlers = new Map();
    const listeners = new Map();
    const windows = [];
    const screen = Object.assign(new EventEmitter(), {
        displays: [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
        cursor: { x: 0, y: 0 },
        getPrimaryDisplay() { return this.displays[0]; },
        getAllDisplays() { return this.displays; },
        getCursorScreenPoint() { return { ...this.cursor }; },
    });
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
            this.sent = [];
            this.ignoreMouse = [];
            this.focusable = options.focusable;
            this.visible = false;
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), {
                send: (channel, payload) => {
                    if (this.sendThrows) throw new Error('Object has been destroyed');
                    this.sent.push({ channel, payload });
                },
            });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        showInactive() { this.visible = true; }
        hide() { this.visible = false; }
        close() { this.destroyed = true; this.emit('closed'); }
        setAlwaysOnTop() {} moveTop() { this.raised = (this.raised || 0) + 1; } setVisibleOnAllWorkspaces() {} focus() {} loadURL() {} reload() {}
        setIgnoreMouseEvents(ignore, options) { this.ignoreMouse.push(ignore); this.forwarding = Boolean(options?.forward); }
        setFocusable(value) { this.focusable = value; }
        getPosition() { return [this.bounds.x, this.bounds.y]; }
        setPosition(x, y) { this.bounds = { ...this.bounds, x, y }; }
        getBounds() { return { ...this.bounds }; }
        setBounds(bounds) { this.bounds = { ...this.bounds, ...bounds }; }
    }
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
    };
    return { electron, handlers, listeners, windows, screen };
}

// 按 Windows 载入：按像素穿透（setIgnoreMouseEvents）那条路只在 Windows/macOS 上走。
async function loadHandlers() {
    const fake = fakeElectron();
    const originalLoad = Module._load;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Module._load = function load(request, ...rest) {
        if (request === 'electron') return fake.electron;
        return originalLoad.call(this, request, ...rest);
    };
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const file = require.resolve('../modules/ipc/deskPetHandlers.js');
    delete require.cache[file];
    let handlers;
    try {
        handlers = require(file);
    } finally {
        Module._load = originalLoad;
        Object.defineProperty(process, 'platform', platform);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-life-'));
    const agentDir = path.join(root, 'Agents');
    for (const id of ['Nova', 'Coco']) {
        fs.mkdirSync(path.join(agentDir, id), { recursive: true });
        fs.writeFileSync(path.join(agentDir, id, 'config.json'), JSON.stringify({ name: id }));
    }
    const mainWindow = new fake.electron.BrowserWindow({});
    handlers.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir });
    const open = async (agentId = 'Nova') => {
        await fake.handlers.get('deskpet:toggle')({}, agentId);
        const pet = fake.windows.at(-1);
        pet.emit('ready-to-show');
        return pet;
    };
    const fromPet = (pet) => ({ sender: pet.webContents });
    return { handlers, fake, open, fromPet, root };
}

test('a second drag-start (lost pointerup) does not leave a timer chasing the cursor', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const pet = await open();
    const [x0, y0] = pet.getPosition();
    fake.screen.cursor = { x: x0 + 10, y: y0 + 10 };
    fake.listeners.get('deskpet:drag-start')(fromPet(pet), { x: x0 + 10, y: y0 + 10 });
    await sleep(40);
    fake.listeners.get('deskpet:drag-start')(fromPet(pet), { x: x0 + 10, y: y0 + 10 });
    fake.screen.cursor = { x: x0 - 90, y: y0 - 40 };
    await sleep(40);
    fake.listeners.get('deskpet:drag-end')(fromPet(pet));
    const dropped = pet.getPosition();
    assert.deepEqual(dropped, [x0 - 100, y0 - 50]);
    fake.screen.cursor = { x: 10, y: 10 };
    await sleep(80);
    assert.deepEqual(pet.getPosition(), dropped, '松手以后窗口不能再跟着光标走');
    handlers.closeAll();
});

test('a renderer reload or crash puts the window back to click-through and ends the drag', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const pet = await open();
    // 光标在角色上（不穿透），输入框开着，正在拖动。
    fake.listeners.get('deskpet:hit')(fromPet(pet), true);
    fake.listeners.get('deskpet:set-interactive')(fromPet(pet), true);
    fake.listeners.get('deskpet:drag-start')(fromPet(pet), { x: 5, y: 5 });
    assert.equal(pet.ignoreMouse.at(-1), false);
    pet.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    assert.equal(pet.ignoreMouse.at(-1), true, '重载后的页面从「没命中」开始，窗口必须回到穿透');
    assert.equal(pet.focusable, false, 'Windows 上输入框没开时窗口回到不可聚焦');
    const parked = pet.getPosition();
    fake.screen.cursor = { x: 900, y: 700 };
    await sleep(60);
    assert.deepEqual(pet.getPosition(), parked, '崩溃时的拖动要停下');
    // 页面重载开始时同样清零（刷新、自动恢复）。
    fake.listeners.get('deskpet:hit')(fromPet(pet), true);
    pet.webContents.emit('did-start-loading');
    assert.equal(pet.ignoreMouse.at(-1), true);
    handlers.closeAll();
});

test('closing the input bar makes the window click-through again even if the cursor never moved', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const pet = await open();
    // 快捷键打开输入框时光标不在角色上：页面最后报的是「没命中」，收起后不会再报一次
    fake.listeners.get('deskpet:set-interactive')(fromPet(pet), true);
    assert.equal(pet.ignoreMouse.at(-1), false);
    fake.listeners.get('deskpet:set-interactive')(fromPet(pet), false);
    assert.equal(pet.ignoreMouse.at(-1), true, '收起输入框后整块透明窗口不能继续挡着点击');
    handlers.closeAll();
});

test('a pet left on an unplugged display comes back to the primary one', async () => {
    const { handlers, fake, open } = await loadHandlers();
    fake.screen.displays = [
        { workArea: { x: 0, y: 0, width: 1600, height: 1000 } },
        { workArea: { x: 1600, y: 0, width: 1920, height: 1080 } },
    ];
    const pet = await open();
    pet.setBounds({ x: 2400, y: 300, width: 300, height: 500 });
    fake.screen.displays = [fake.screen.displays[0]];
    fake.screen.emit('display-removed');
    await sleep(500);
    const b = pet.getBounds();
    assert.ok(b.x + b.width <= 1600 && b.x >= 0, `x=${b.x} 应回到主屏`);
    assert.deepEqual([b.width, b.height], [360, 464], '尺寸恢复成桌宠窗口的固定大小');
    handlers.closeAll();
});

test('stream hooks never throw into the main chat path', async () => {
    const { handlers, open } = await loadHandlers();
    const pet = await open();
    pet.sendThrows = true;
    assert.doesNotThrow(() => handlers.onRequestStart('m1', { agentId: 'Nova' }));
    assert.doesNotThrow(() => handlers.onStreamPayload({ type: 'data', messageId: 'm1', context: { agentId: 'Nova' }, chunk: 'hi' }));
    assert.doesNotThrow(() => handlers.onFullResponse('m1', { agentId: 'Nova' }, { choices: [{ message: { content: 'hi' } }] }));
    const messages = [{ role: 'user', content: 'hi' }];
    assert.ok(Array.isArray(handlers.appendProtocolToMessages(messages, 'Nova')));
    handlers.closeAll();
});

test('agent ids that point at the Agents folder itself are refused', async () => {
    const { handlers, fake } = await loadHandlers();
    const toggle = fake.handlers.get('deskpet:toggle');
    for (const bad of ['.', '..', 'Nova/..', '..\\Nova']) {
        const result = await toggle({}, bad);
        assert.equal(result.success, false, bad);
    }
    assert.equal(fake.windows.length, 1, '只有主窗口，没有建出桌宠窗口');
    handlers.closeAll();
});

test('Windows: a pet pushed down by another topmost window comes back on top', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'setImmediate'] });
    const { open } = await loadHandlers();
    const pet = await open();
    const shown = pet.raised;
    // 别的程序把置顶取消了：马上补回
    pet.emit('always-on-top-changed', {}, false);
    t.mock.timers.tick(0);
    assert.equal(pet.raised, shown + 1);
    pet.emit('always-on-top-changed', {}, true);
    // 隔一阵补一次层级；藏起来时不动
    t.mock.timers.tick(10000);
    assert.equal(pet.raised, shown + 2);
    pet.hide();
    t.mock.timers.tick(10000);
    assert.equal(pet.raised, shown + 2);
    pet.close();
});

test('a fullscreen program hides the pet until it leaves fullscreen; the user can still call it back', async () => {
    const { handlers, open, fake } = await loadHandlers();
    const pet = await open();
    const states = () => fake.windows[0].sent.filter((m) => m.channel === 'deskpet:state-changed');
    const before = states().length;
    const full = { fullscreen: true, rect: { x: 0, y: 0, width: 1600, height: 1000 } };
    handlers._applyFullscreen(full);
    assert.equal(pet.isVisible(), false);
    assert.equal(states().length, before, 'the header toggle does not flip');
    handlers._applyFullscreen({ fullscreen: false, rect: null });
    assert.equal(pet.isVisible(), true);
    // 全屏期间用户自己把它叫出来：留着，退出全屏时也不再动它
    handlers._applyFullscreen(full);
    assert.equal(pet.isVisible(), false);
    await fake.handlers.get('deskpet:toggle')({}, 'Nova');
    assert.equal(pet.isVisible(), true);
    handlers._applyFullscreen({ fullscreen: false, rect: null });
    assert.equal(pet.isVisible(), true);
    handlers.closeAll();
});

test('click-through mode: the mouse passes the pet, hits are ignored, the talk bar still works', async () => {
    const { handlers, open, fake, fromPet } = await loadHandlers();
    const pet = await open();
    const item = () => handlers.trayMenuItems()[0].submenu.find((i) => i.label?.startsWith('只看不点'));
    assert.equal(item().checked, false);
    item().click({ checked: true });
    assert.equal(pet.ignoreMouse.at(-1), true);
    assert.equal(pet.forwarding, false, '不转发鼠标：页面碰不到悬停');
    assert.equal(pet.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.clickThrough, true);
    // 页面报命中也不变成可点
    fake.listeners.get('deskpet:hit')(fromPet(pet), true);
    assert.equal(pet.ignoreMouse.at(-1), true);
    // 输入框打开时可点，收起后回到穿透
    fake.listeners.get('deskpet:set-interactive')(fromPet(pet), true);
    assert.equal(pet.ignoreMouse.at(-1), false);
    fake.listeners.get('deskpet:set-interactive')(fromPet(pet), false);
    assert.equal(pet.ignoreMouse.at(-1), true);
    assert.equal(pet.forwarding, false);
    // 关掉：回到按像素穿透（转发鼠标，命中时可点）
    item().click({ checked: false });
    assert.equal(pet.forwarding, true);
    fake.listeners.get('deskpet:hit')(fromPet(pet), true);
    assert.equal(pet.ignoreMouse.at(-1), false);
    handlers.closeAll();
});

test('dropping the pet near a screen edge slides it flush; Alt or a far drop leaves it', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const pet = await open();
    const figure = { x: 40, y: 100, width: 200, height: 300 };
    const dropAt = (x, y, report) => {
        const [wx, wy] = pet.getPosition();
        fake.screen.cursor = { x: wx, y: wy };
        fake.listeners.get('deskpet:drag-start')(fromPet(pet), { x: wx, y: wy });
        fake.screen.cursor = { x, y };
        fake.listeners.get('deskpet:drag-end')(fromPet(pet), report);
    };
    // 角色左边离屏幕左边 15：滑过去贴齐；脚底离工作区底边也近：一起落到任务栏上
    const bottom = 1000 - figure.y - figure.height;
    dropAt(-25, bottom - 10, { figure });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [-40, bottom]);
    // 按着 Alt 松手：不吸
    dropAt(-25, bottom - 10, { figure, free: true });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [-25, bottom - 10]);
    // 离边很远：不动；出去了但不到四成（离边超过吸附距离）：也不动
    dropAt(500, 300, { figure });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [500, 300]);
    dropAt(-100, 300, { figure });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [-100, 300]);
    // 页面没报包围盒（老页面、后端没起来）：照旧放下
    dropAt(-25, 300);
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [-25, 300]);
    handlers.closeAll();
});

test('a pending tool approval reaches the pet of the agent that asked, and only main answers it', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const main = fake.windows[0];
    const nova = await open('Nova');
    const coco = await open('Coco');
    for (const pet of [nova, coco]) fake.listeners.get('deskpet:page-ready')(fromPet(pet));
    const sentTo = (win, channel) => win.sent.filter((m) => m.channel === channel).map((m) => m.payload);
    const offer = async (sender, payload) => {
        fake.listeners.get('deskpet:approval-offer')({ sender }, payload);
        await sleep(30);
    };
    // 别的窗口冒充主窗口：不理
    await offer(nova.webContents, { requestId: 'fake', maid: 'Nova', toolName: 'X' });
    assert.deepEqual(sentTo(nova, 'deskpet:approval'), []);
    await offer(main.webContents, { requestId: 'r1', maid: 'coco', toolName: 'PowerShellExecutor', command: 'dir', expiresInMs: 60000 });
    assert.deepEqual(sentTo(nova, 'deskpet:approval'), []);
    const [card] = sentTo(coco, 'deskpet:approval');
    assert.equal(card.requestId, 'r1');
    assert.equal(card.toolName, 'PowerShellExecutor');
    assert.ok(card.expiresAt > Date.now());
    // 认不出是谁、也没人刚聊过：不往桌宠上放
    await offer(main.webContents, { requestId: 'r2', maid: 'Someone', toolName: 'X' });
    assert.equal(handlers._pendingApprovals().has('r2'), false);
    // 不是这只桌宠的请求，它答不了；是它的就交回主窗口
    fake.listeners.get('deskpet:approval-answer')(fromPet(nova), { requestId: 'r1', approved: true });
    assert.deepEqual(sentTo(main, 'deskpet:approval-answer'), []);
    fake.listeners.get('deskpet:approval-answer')(fromPet(coco), { requestId: 'r1', approved: true });
    assert.deepEqual(sentTo(main, 'deskpet:approval-answer'), [{ requestId: 'r1', approved: true }]);
    // 页面重载：还在等的再给一次
    fake.listeners.get('deskpet:page-ready')(fromPet(coco));
    assert.equal(sentTo(coco, 'deskpet:approval').length, 2);
    // 主窗口说答完了：桌宠收起
    fake.listeners.get('deskpet:approval-settled')({ sender: main.webContents }, 'r1');
    assert.deepEqual(sentTo(coco, 'deskpet:approval-clear'), ['r1']);
    assert.equal(handlers._pendingApprovals().size, 0);
    // 桌宠关了：等着的审批不再留
    await offer(main.webContents, { requestId: 'r3', maid: 'Coco', toolName: 'X' });
    coco.close();
    assert.equal(handlers._pendingApprovals().has('r3'), false);
    handlers.closeAll();
});

test('the stop button on the pet asks the main window to interrupt that reply', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const main = fake.windows[0];
    const pet = await open('Coco');
    const requests = () => main.sent.filter((m) => m.channel === 'deskpet:interrupt-request').map((m) => m.payload);
    fake.listeners.get('deskpet:interrupt')(fromPet(pet), 'msg_1');
    assert.deepEqual(requests(), [{ agentId: 'Coco', messageId: 'msg_1' }]);
    // 不是桌宠发来的、没有消息 id 的：不理
    fake.listeners.get('deskpet:interrupt')({ sender: main.webContents }, 'msg_2');
    fake.listeners.get('deskpet:interrupt')(fromPet(pet), '');
    fake.listeners.get('deskpet:interrupt')(fromPet(pet), { id: 'x' });
    assert.equal(requests().length, 1);
    handlers.closeAll();
});

test('files sent from the pet reach the main window cleaned up', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const main = fake.windows[0];
    const pet = await open('Coco');
    const send = fake.handlers.get('deskpet:send');
    const pending = send(fromPet(pet), '', { files: [
        { path: '/home/u/a.png', name: '../../a.png', type: 'image/png' },
        { path: 'relative/b.txt', name: 'b.txt' },
        { data: new Uint8Array([1, 2, 3]), name: 'p.png', type: 'image/png' },
        { data: new Uint8Array(0), name: 'empty.png' },
    ] });
    const request = main.sent.find((m) => m.channel === 'deskpet:send-request').payload;
    assert.equal(request.text, '');
    assert.deepEqual(request.files.map((f) => [f.path || 'bytes', f.name]), [['/home/u/a.png', 'a.png'], ['bytes', 'p.png']]);
    fake.listeners.get('deskpet:send-result')({}, { requestId: request.requestId, result: { success: true } });
    assert.deepEqual(await pending, { success: true });
    // 没字也没文件：不往主窗口发
    assert.equal((await send(fromPet(pet), ' ', { files: [{ path: 'x' }] })).success, false);
    handlers.closeAll();
});

test('dragged well past a screen edge the pet tucks in, peeks out when wanted and tucks back', async () => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    const pet = await open();
    const figure = { x: 40, y: 100, width: 200, height: 300 };
    const dropAt = (x, y, report) => {
        const [wx, wy] = pet.getPosition();
        fake.screen.cursor = { x: wx, y: wy };
        fake.listeners.get('deskpet:drag-start')(fromPet(pet), { x: wx, y: wy });
        fake.screen.cursor = { x, y };
        fake.listeners.get('deskpet:drag-end')(fromPet(pet), report);
    };
    // 角色有一半在左边外面：收进去，只露 60（三成）
    dropAt(-140, 300, { figure });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [-40 - 140, 300]);
    const wantOut = (want) => fake.listeners.get('deskpet:want-out')(fromPet(pet), want);
    wantOut(true);
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [-40, 300], '探出来：角色贴着左边');
    wantOut(false);
    await sleep(300);
    assert.deepEqual(pet.getPosition(), [-40, 300], '人刚走开先不缩');
    await sleep(1200);
    assert.deepEqual(pet.getPosition(), [-180, 300], '过一会儿缩回去');
    // 右边也一样；按着 Alt 松手不藏
    dropAt(1600 - 40 - 100, 300, { figure, free: true });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [1460, 300]);
    wantOut(true);
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [1460, 300], '没藏就不动');
    dropAt(1600 - 40 - 100, 300, { figure });
    await sleep(200);
    assert.deepEqual(pet.getPosition(), [1600 - 60 - 40, 300]);
    handlers.closeAll();
});

test('a pet flung on release slides on and lands on the taskbar; a slow drop stays put', async (t) => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    t.after(() => handlers.closeAll());
    const pet = await open();
    const figure = { x: 40, y: 100, width: 200, height: 300 };
    const floorY = 1000 - figure.y - figure.height;
    const drag = async (path, report) => {
        const [wx, wy] = pet.getPosition();
        fake.screen.cursor = { x: wx, y: wy };
        fake.listeners.get('deskpet:drag-start')(fromPet(pet), { x: wx, y: wy });
        for (const [dx, dy] of path) {
            fake.screen.cursor = { x: wx + dx, y: wy + dy };
            await sleep(20);
        }
        fake.listeners.get('deskpet:drag-end')(fromPet(pet), report);
    };
    // 默认位置已经贴着任务栏了：先放到半空，再慢慢挪过去放下：原地不动
    pet.setPosition(pet.getPosition()[0], 300);
    await drag([[10, 0], [20, 0], [30, 0]], { figure });
    await sleep(100);
    const [sx, sy] = pet.getPosition();
    assert.ok(sy < floorY - 50, '放在半空也不掉');
    // 往左上快速一甩（默认位置在屏幕右边，往左才有地方滑）
    await drag([[0, 0], [-40, -10], [-80, -20], [-120, -30]], { figure });
    await sleep(1500);
    const [tx, ty] = pet.getPosition();
    assert.equal(ty, floorY, '落在任务栏上');
    assert.ok(tx < sx - 150, '带着速度往左滑了一段');
    assert.ok(pet.sent.some((m) => m.channel === 'deskpet:landed'));
    // 按着 Alt 甩：不甩
    await drag([[0, 0], [-40, -40], [-80, -80], [-120, -120]], { figure, free: true });
    await sleep(300);
    assert.notEqual(pet.getPosition()[1], floorY);
});

test('wandering: an idle pet on the taskbar strolls a little; touching it stops it in place', async (t) => {
    const { handlers, fake, open, fromPet } = await loadHandlers();
    t.after(() => handlers.closeAll());
    const pet = await open();
    const figure = { x: 40, y: 100, width: 200, height: 300 };
    const floorY = 1000 - figure.y - figure.height;
    pet.setBounds({ x: 600, y: floorY });
    const walks = () => pet.sent.filter((m) => m.channel === 'deskpet:walk').map((m) => m.payload.dir);
    // 默认关：页面来问也不走
    fake.listeners.get('deskpet:wander')(fromPet(pet), { figure });
    await sleep(60);
    assert.deepEqual(pet.getPosition(), [600, floorY]);
    assert.deepEqual(walks(), []);
    handlers._controls().update({ wander: true });
    assert.equal(pet.sent.filter((m) => m.channel === 'deskpet:prefs').at(-1).payload.wander, true);
    // 半空中不走
    pet.setBounds({ x: 600, y: 200 });
    fake.listeners.get('deskpet:wander')(fromPet(pet), { figure });
    assert.deepEqual(walks(), []);
    // 站在任务栏上：沿着走一段，高度不变，走完停下
    pet.setBounds({ x: 600, y: floorY });
    fake.listeners.get('deskpet:wander')(fromPet(pet), { figure });
    assert.equal(walks().length, 1);
    await sleep(200);
    const [x1, y1] = pet.getPosition();
    assert.notEqual(x1, 600);
    assert.equal(y1, floorY);
    // 光标碰到角色：停在原地
    fake.listeners.get('deskpet:hit')(fromPet(pet), true);
    assert.equal(walks().at(-1), null);
    const [x2] = pet.getPosition();
    await sleep(100);
    assert.equal(pet.getPosition()[0], x2);
    fake.listeners.get('deskpet:hit')(fromPet(pet), false);
    // 再走一次，页面说有动静了：停下；关掉溜达也停
    fake.listeners.get('deskpet:wander')(fromPet(pet), { figure });
    await sleep(50);
    fake.listeners.get('deskpet:wander')(fromPet(pet), { stop: true });
    assert.equal(walks().at(-1), null);
    fake.listeners.get('deskpet:wander')(fromPet(pet), { figure });
    handlers._controls().update({ wander: false });
    assert.equal(walks().at(-1), null);
    const [x3] = pet.getPosition();
    await sleep(100);
    assert.equal(pet.getPosition()[0], x3);
});
