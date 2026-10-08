// 侧栏首页立绘的主进程部分：按 Agent 目录里的 portrait 文件给出立绘地址，大图换成缓存里的缩小图，拒绝越出 Agent 目录的 id。
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('a large portrait is served as a cached display-size copy, small ones and unreadable files as they are', async () => {
    const sharp = require('sharp');
    const dir = path.join(agentDir, 'Big');
    fs.mkdirSync(dir);
    const solid = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 200, g: 120, b: 160, alpha: 0.8 } } });
    await solid(4000, 6000).png().toFile(path.join(dir, 'portrait.png'));
    await solid(600, 900).avif().toFile(path.join(dir, 'portrait.light.avif'));
    fs.writeFileSync(path.join(dir, 'portrait.broken.png'), 'not an image');

    const first = await getPortraits('Big');
    const cached = fileURLToPath(first.default.replace(/\?v=\d+$/, ''));
    assert.equal(path.dirname(cached), path.join(root, 'PortraitCache'));
    const meta = await sharp(cached).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.hasAlpha], ['webp', 1600, 2400, true]);
    assert.match(first.light, /\/Big\/portrait\.light\.avif\?v=\d+$/);
    assert.match(first.broken, /\/Big\/portrait\.broken\.png\?v=\d+$/);
    assert.deepEqual(await getPortraits('Big'), first);

    // 换了原图：生成新的缩小图，旧的删掉
    await solid(5000, 5000).png().toFile(path.join(dir, 'portrait.png'));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'portrait.png'), later, later);
    const second = await getPortraits('Big');
    assert.notEqual(second.default, first.default);
    assert.equal(fs.existsSync(cached), false);
    assert.equal((await sharp(fileURLToPath(second.default.replace(/\?v=\d+$/, ''))).metadata()).width, 1600);
});
