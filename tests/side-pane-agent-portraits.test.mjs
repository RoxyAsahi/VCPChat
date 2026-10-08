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
