// 侧栏首页立绘的主进程部分：按 Agent 目录里的 portrait 文件给出立绘地址，拒绝越出 Agent 目录的 id。
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const handlers = new Map();
const originalLoad = Module._load;
Module._load = function loadWithElectronMock(request, parent, isMain) {
    if (request === 'electron') {
        return { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} } };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const agentHandlers = require('../modules/ipc/agentHandlers.js');
Module._load = originalLoad;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-portraits-'));
const agentDir = path.join(root, 'Agents');
fs.mkdirSync(agentDir);
agentHandlers.initialize({ AGENT_DIR: agentDir, USER_DATA_DIR: path.join(root, 'UserData'), settingsManager: {} });
const getPortraits = (id) => handlers.get('get-agent-portraits')({}, id);

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('an agent with portrait files gets the default, the light version and other variants', async () => {
    const dir = path.join(agentDir, 'Nova');
    fs.mkdirSync(dir);
    for (const name of ['avatar.png', 'portrait.png', 'portrait.light.webp', 'portrait.Smile.jpg', 'portrait.txt', 'portrait..png']) {
        fs.writeFileSync(path.join(dir, name), 'x');
    }
    fs.mkdirSync(path.join(dir, 'portrait.dir.png'));

    const portraits = await getPortraits('Nova');
    assert.deepEqual(Object.keys(portraits).sort(), ['default', 'light', 'smile']);
    assert.match(portraits.default, /^file:\/\/.*\/Nova\/portrait\.png\?v=\d+$/);
    assert.match(portraits.light, /\/portrait\.light\.webp\?v=\d+$/);
});

test('an agent without a default portrait, a missing agent and unsafe ids get null', async () => {
    const dir = path.join(agentDir, 'Coco');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'avatar.png'), 'x');
    fs.writeFileSync(path.join(dir, 'portrait.light.png'), 'x');
    fs.writeFileSync(path.join(root, 'portrait.png'), 'x');

    assert.equal(await getPortraits('Coco'), null);
    assert.equal(await getPortraits('missing'), null);
    for (const id of ['..', '.', '../Agents/Nova', '', null, 42]) {
        assert.equal(await getPortraits(id), null, String(id));
    }
});

const png = { type: 'image/png', buffer: new Uint8Array([1, 2, 3]).buffer };
const save = (id, variant, data) => handlers.get('save-agent-portrait')({}, id, variant, data);
const remove = (id, variant) => handlers.get('remove-agent-portrait')({}, id, variant);

test('saving a portrait replaces the same variant in any extension and leaves the others', async () => {
    const dir = path.join(agentDir, 'Saver');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'portrait.webp'), 'old');
    fs.writeFileSync(path.join(dir, 'portrait.light.png'), 'light');

    const result = await save('Saver', 'default', png);
    assert.equal(result.success, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['portrait.light.png', 'portrait.png']);
    assert.deepEqual(Object.keys(result.portraits).sort(), ['default', 'light']);

    await save('Saver', 'Smile', { type: 'image/jpeg', buffer: png.buffer });
    assert.ok(fs.existsSync(path.join(dir, 'portrait.smile.jpg')));

    const removed = await remove('Saver', 'default');
    assert.equal(removed.success, true);
    assert.equal(removed.portraits, null, '没有默认立绘就不算有立绘');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['portrait.light.png', 'portrait.smile.jpg']);
});

test('saving rejects unknown agents, bad variants, unsupported types and empty or oversized images', async () => {
    fs.mkdirSync(path.join(agentDir, 'Strict'));
    assert.ok((await save('../Strict', 'default', png)).error);
    assert.ok((await save('Missing', 'default', png)).error);
    assert.ok((await save('Strict', '../x', png)).error);
    assert.ok((await save('Strict', 'default', { type: 'image/svg+xml', buffer: png.buffer })).error);
    assert.ok((await save('Strict', 'default', { type: 'image/png', buffer: new ArrayBuffer(0) })).error);
    assert.ok((await save('Strict', 'default', { type: 'image/png', buffer: new ArrayBuffer(20 * 1024 * 1024 + 1) })).error);
    assert.deepEqual(fs.readdirSync(path.join(agentDir, 'Strict')), []);
    assert.ok((await remove('..', 'default')).error);
});
