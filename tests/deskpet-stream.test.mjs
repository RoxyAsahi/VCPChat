import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

// 假的 electron：只记录主进程对窗口和 IPC 做了什么。
function fakeElectron() {
    const handlers = new Map();
    const listeners = new Map();
    const windows = [];
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            this.options = options;
            this.sent = [];
            this.visible = false;
            this.destroyed = false;
            this.webContents = Object.assign(new EventEmitter(), { send: (channel, payload) => this.sent.push({ channel, payload }) });
            windows.push(this);
        }
        isDestroyed() { return this.destroyed; }
        isVisible() { return this.visible; }
        showInactive() { this.visible = true; }
        hide() { this.visible = false; }
        close() { this.destroyed = true; this.emit('closed'); }
        setAlwaysOnTop() {} moveTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {}
        setFocusable() {} focus() {} loadURL() {} getPosition() { return [0, 0]; } setPosition() {}
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
        screen: {
            getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }),
            getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1600, height: 1000 } }],
            getCursorScreenPoint: () => ({ x: 0, y: 0 }),
            on() {},
        },
    };
    return { electron, handlers, listeners, windows };
}

async function loadHandlers() {
    const fake = fakeElectron();
    const originalLoad = Module._load;
    Module._load = function load(request, ...rest) {
        if (request === 'electron') return fake.electron;
        return originalLoad.call(this, request, ...rest);
    };
    const file = require.resolve('../modules/ipc/deskPetHandlers.js');
    delete require.cache[file];
    let handlers;
    try {
        handlers = require(file);
    } finally {
        Module._load = originalLoad;
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-'));
    const agentDir = path.join(root, 'Agents');
    fs.mkdirSync(path.join(agentDir, 'Nova'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'Nova', 'config.json'), JSON.stringify({ name: 'Nova' }));
    const mainWindow = new fake.electron.BrowserWindow({});
    handlers.initialize({ mainWindow, projectRoot: path.resolve('.'), appDataRoot: root, agentDir });
    // 等情绪提示词模块异步载入
    for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (handlers.getSystemPromptAppend('none', '') === '' && handlers._promptReady?.()) break;
    }
    return { handlers, fake, mainWindow };
}

test('stream events reach only the open pet, as plain text', async () => {
    const { handlers, fake } = await loadHandlers();
    const toggle = fake.handlers.get('deskpet:toggle');
    const opened = await toggle({}, 'Nova');
    assert.equal(opened.success, true);
    const pet = fake.windows.at(-1);
    pet.emit('ready-to-show');
    assert.deepEqual(opened.openAgents, []); // 窗口还没显示
    handlers.onRequestStart('m1', { agentId: 'Nova' });
    handlers.onStreamPayload({ type: 'data', messageId: 'm1', context: { agentId: 'Nova' }, chunk: { choices: [{ delta: { content: '<!--emo:happy-->你好' } }] } });
    handlers.onStreamPayload({ type: 'data', messageId: 'x', context: { agentId: 'Other' }, chunk: { choices: [{ delta: { content: 'no' } }] } });
    handlers.onStreamPayload({ type: 'end', messageId: 'm1', context: { agentId: 'Nova' } });
    const stream = pet.sent.filter((s) => s.channel === 'deskpet:stream').map((s) => s.payload);
    assert.deepEqual(stream, [
        { type: 'start', messageId: 'm1' },
        { type: 'data', messageId: 'm1', text: '<!--emo:happy-->你好' },
        { type: 'end', messageId: 'm1' },
    ]);
    handlers.closeAll();
});

test('the tag prompt is added only while the pet is open and not already present', async () => {
    const { handlers, fake } = await loadHandlers();
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
    assert.equal(handlers.appendProtocolToMessages(messages, 'Nova'), messages);
    await fake.handlers.get('deskpet:toggle')({}, 'Nova');
    const withPrompt = handlers.appendProtocolToMessages(messages, 'Nova');
    assert.match(withPrompt[0].content, /<!--emo:/);
    const already = [{ role: 'system', content: '我会写 <!--emo:happy--> 标记' }];
    assert.equal(handlers.appendProtocolToMessages(already, 'Nova'), already);
    handlers.closeAll();
});

test('text typed on the pet is handed to the main window and the result comes back', async () => {
    const { handlers, fake, mainWindow } = await loadHandlers();
    await fake.handlers.get('deskpet:toggle')({}, 'Nova');
    const pet = fake.windows.at(-1);
    const pending = fake.handlers.get('deskpet:send')({ sender: pet.webContents }, '  早上好  ');
    const request = mainWindow.sent.find((s) => s.channel === 'deskpet:send-request').payload;
    assert.equal(request.agentId, 'Nova');
    assert.equal(request.text, '早上好');
    fake.listeners.get('deskpet:send-result')({}, { requestId: request.requestId, result: { success: true } });
    assert.deepEqual(await pending, { success: true });
    assert.deepEqual(await fake.handlers.get('deskpet:send')({ sender: pet.webContents }, '   '), { success: false, error: '没有内容' });
    handlers.closeAll();
});

test('hiding a pet keeps it alive and the header toggle brings it back', async () => {
    const { handlers, fake } = await loadHandlers();
    const toggle = fake.handlers.get('deskpet:toggle');
    await toggle({}, 'Nova');
    const pet = fake.windows.at(-1);
    pet.emit('ready-to-show');
    pet.hide();
    const again = await toggle({}, 'Nova');
    assert.equal(pet.isDestroyed(), false);
    assert.equal(pet.isVisible(), true);
    assert.deepEqual(again.openAgents, ['Nova']);
    const closed = await toggle({}, 'Nova');
    assert.equal(pet.isDestroyed(), true);
    assert.deepEqual(closed.openAgents, []);
    handlers.closeAll();
});
