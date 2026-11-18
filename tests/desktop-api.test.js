// 声明式 API（modules/desktopApi）的契约测试：参数校验、目录与调用、V桌面接口目录、
// IPC handler 索引，以及 DesktopRemote 插件与 preload 两个入口是否接上。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateParams, toJsonSchema } = require('../modules/desktopApi/schema');
const { createDesktopApiRegistry } = require('../modules/desktopApi/registry');
const ipcHandlerIndex = require('../modules/desktopApi/ipcHandlerIndex');
const { createDesktopApi, IPC_CHANNELS } = require('../modules/desktopApi');
const { isAllowedAppAction } = require('../modules/desktopApi/operations/desktop');
const { buildPayload } = require('../VCPDistributedServer/Plugin/DesktopRemote/desktop-remote');
const { describeApis } = require('../preloads/core/registry');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function op(overrides = {}) {
    return {
        id: 'test.thing.get',
        title: '测试',
        description: '读取测试数据。第二句。',
        access: 'read',
        callers: ['model', 'widget'],
        handler: async (params) => ({ echo: params }),
        ...overrides,
    };
}

test('参数校验：字符串参数按声明转成数字、布尔、对象', () => {
    const specs = {
        n: { type: 'number', description: 'n' },
        i: { type: 'integer', description: 'i' },
        b: { type: 'boolean', description: 'b' },
        o: { type: 'object', description: 'o' },
        a: { type: 'array', description: 'a' },
        d: { type: 'boolean', default: false, description: 'd' },
    };
    const out = validateParams(specs, { n: '1.5', i: '3', b: 'TRUE', o: '{"k":1}', a: '[1,2]' });
    assert.deepEqual(out, { n: 1.5, i: 3, b: true, o: { k: 1 }, a: [1, 2], d: false });
    assert.deepEqual(validateParams(specs, '{"n": 0}'), { n: 0, d: false }, '0 是合法值');
});

test('参数校验：缺必填、类型错、枚举外、未知参数都报 INVALID_PARAMS 并指出字段', () => {
    const specs = {
        id: { type: 'string', required: true, description: 'id' },
        kind: { type: 'string', enum: ['a', 'b'], description: 'kind' },
        n: { type: 'integer', min: 1, max: 3, description: 'n' },
    };
    const cases = [
        [{}, 'id', /缺少必填参数 id/],
        [{ id: 'x', kind: 'c' }, 'kind', /只能是 a \/ b/],
        [{ id: 'x', n: '2.5' }, 'n', /整数/],
        [{ id: 'x', n: 9 }, 'n', /不能大于 3/],
        [{ id: 'x', widgetID: 'y' }, 'widgetID', /未知参数 widgetID；可用参数：id, kind, n/],
    ];
    for (const [input, field, message] of cases) {
        assert.throws(() => validateParams(specs, input), (error) => error.code === 'INVALID_PARAMS' && error.field === field && message.test(error.message));
    }
});

test('参数描述能转成 JSON Schema', () => {
    const schema = toJsonSchema({
        id: { type: 'string', required: true, maxLength: 10, description: 'id' },
        any: { type: 'json', description: '任意' },
    });
    assert.deepEqual(schema, {
        type: 'object',
        properties: { id: { type: 'string', description: 'id', maxLength: 10 }, any: { description: '任意' } },
        required: ['id'],
        additionalProperties: false,
    });
});

test('接口定义写错时登记即报错', () => {
    const registry = createDesktopApiRegistry();
    assert.throws(() => registry.define(op({ id: 'Bad Id' })), /id/);
    assert.throws(() => registry.define(op({ access: 'admin' })), /access/);
    assert.throws(() => registry.define(op({ callers: ['plugin'] })), /callers/);
    assert.throws(() => registry.define(op({ ipc: { channel: 'x' } })), /handler 与 ipc/);
    assert.throws(() => registry.define(op({ params: { a: { type: 'string' } } })), /description/);
    registry.define(op());
    assert.throws(() => registry.define(op()), /重复登记/);
});

test('目录按调用方、前缀、关键词过滤；danger 接口不对任何调用方开放', () => {
    const registry = createDesktopApiRegistry();
    registry.defineAll([
        op({ id: 'desktop.widget.create', title: '创建挂件', access: 'write' }),
        op({ id: 'desktop.metrics.snapshot', title: '读取指标', callers: ['widget'] }),
        op({ id: 'vchat.app.launch', title: '打开应用', access: 'write', callers: ['model'] }),
        op({ id: 'system.files.wipe', title: '危险', access: 'danger' }),
    ]);
    const ids = (filter) => registry.list(filter).map((api) => api.id);
    assert.deepEqual(ids({ caller: 'model' }), ['desktop.widget.create', 'vchat.app.launch']);
    assert.deepEqual(ids({ caller: 'widget' }), ['desktop.metrics.snapshot', 'desktop.widget.create']);
    assert.deepEqual(ids({ caller: 'model', prefix: 'desktop' }), ['desktop.widget.create']);
    assert.deepEqual(ids({ caller: 'widget', query: '指标' }), ['desktop.metrics.snapshot']);
    assert.equal(registry.list({ caller: 'model' })[0].summary, '读取测试数据。');
    assert.throws(() => registry.describe('system.files.wipe', { caller: 'model' }), (error) => error.code === 'API_FORBIDDEN');
});

test('调用：成功返回信封，失败带错误码，不抛错', async () => {
    const registry = createDesktopApiRegistry({ logger: null });
    registry.defineAll([
        op({ params: { n: { type: 'number', required: true, description: 'n' } } }),
        op({ id: 'test.thing.fail', handler: async () => { throw new Error('boom'); } }),
        op({ id: 'test.thing.coded', handler: async () => { const e = new Error('桌面没开'); e.code = 'API_UNAVAILABLE'; throw e; } }),
        op({ id: 'test.thing.slow', timeoutMs: 20, handler: () => new Promise((resolve) => setTimeout(resolve, 200)) }),
        op({ id: 'test.thing.modelOnly', callers: ['model'] }),
    ]);
    assert.deepEqual(await registry.call('test.thing.get', { n: '2' }, { caller: 'model' }), { ok: true, id: 'test.thing.get', data: { echo: { n: 2 } } });
    const code = async (id, params, caller = 'widget') => (await registry.call(id, params, { caller })).error?.code;
    assert.equal(await code('test.thing.get', {}), 'INVALID_PARAMS');
    assert.equal(await code('test.thing.nope', {}), 'API_NOT_FOUND');
    assert.equal(await code('test.thing.modelOnly', {}), 'API_FORBIDDEN');
    assert.equal(await code('test.thing.get', { n: 1 }, 'stranger'), 'API_FORBIDDEN');
    assert.equal(await code('test.thing.fail', {}), 'API_FAILED');
    assert.equal(await code('test.thing.coded', {}), 'API_UNAVAILABLE');
    assert.equal(await code('test.thing.slow', {}), 'API_TIMEOUT');
});

test('ipc 型接口：按 args 排参数，解开 { success, data } 信封，再经 map 裁剪', async () => {
    const calls = [];
    const replies = {
        'ch-data': { success: true, data: { a: 1 } },
        'ch-rest': { success: true, widgets: [{ id: 'w', thumbnail: 'data:...' }] },
        'ch-fail': { success: false, error: '读不到' },
    };
    const registry = createDesktopApiRegistry({
        logger: null,
        invokeIpc: async (channel, args) => { calls.push([channel, args]); return replies[channel]; },
    });
    registry.defineAll([
        op({ id: 'test.ipc.data', handler: undefined, params: { x: { type: 'number', description: 'x' } }, ipc: { channel: 'ch-data', args: ({ x }) => [x, 'fixed'] } }),
        op({ id: 'test.ipc.rest', handler: undefined, ipc: { channel: 'ch-rest', map: (data) => data.widgets.map(({ thumbnail, ...rest }) => rest) } }),
        op({ id: 'test.ipc.fail', handler: undefined, ipc: { channel: 'ch-fail' } }),
    ]);
    assert.deepEqual((await registry.call('test.ipc.data', { x: '5' }, { caller: 'model' })).data, { a: 1 });
    assert.deepEqual(calls[0], ['ch-data', [5, 'fixed']]);
    assert.deepEqual((await registry.call('test.ipc.rest', {}, { caller: 'model' })).data, [{ id: 'w' }]);
    const failed = await registry.call('test.ipc.fail', {}, { caller: 'model' });
    assert.deepEqual(failed.error, { code: 'API_FAILED', message: '读不到' });
});

test('IPC handler 索引记录注册与撤销，合成事件带上 sender', async () => {
    ipcHandlerIndex.reset();
    const fake = { handlers: new Map(), handle(ch, fn) { this.handlers.set(ch, fn); }, removeHandler(ch) { this.handlers.delete(ch); } };
    ipcHandlerIndex.install(fake);
    fake.handle('echo', (event, a, b) => ({ desktopApi: event.desktopApi, sender: event.sender, sum: a + b }));
    assert.ok(fake.handlers.has('echo'), '原 handle 照常生效');
    assert.deepEqual(await ipcHandlerIndex.invoke('echo', [1, 2], { sender: 'win' }), { desktopApi: true, sender: 'win', sum: 3 });
    fake.removeHandler('echo');
    assert.equal(ipcHandlerIndex.has('echo'), false);
    await assert.rejects(ipcHandlerIndex.invoke('echo', []), /没有注册 handler/);
    ipcHandlerIndex.reset();
});

function fakeBridge(overrides = {}) {
    const calls = [];
    return {
        calls,
        getDesktopWindow: () => ({ isDestroyed: () => false }),
        queryDesktopRenderer: async (command, payload, options) => { calls.push(['rpc', command, payload, options]); return { status: { running: true } }; },
        setWallpaper: async (source) => { calls.push(['wallpaper', source]); return { type: 'image', source, filePath: source, opacity: 1 }; },
        createWidget: async (payload) => { calls.push(['create', payload]); return { widgetId: payload.widgetId || 'auto' }; },
        ...overrides,
    };
}

test('V桌面接口目录：每个接口都能登记，id 唯一，AI 与挂件都能看到', () => {
    const api = createDesktopApi({ bridge: fakeBridge(), invokeIpc: async () => null, logger: null });
    const modelIds = api.list({ caller: 'model' }).map((entry) => entry.id);
    const widgetIds = api.list({ caller: 'widget' }).map((entry) => entry.id);
    assert.ok(modelIds.length >= 13, `接口数 ${modelIds.length}`);
    assert.deepEqual(modelIds, widgetIds);
    for (const id of ['desktop.state.query', 'desktop.widget.create', 'desktop.widget.remove', 'desktop.wallpaper.set', 'desktop.metrics.snapshot', 'vchat.app.launch']) {
        assert.ok(modelIds.includes(id), `缺少 ${id}`);
    }
});

test('V桌面接口目录：ipc 型接口引用的通道在主进程都有 handler', () => {
    const source = read('modules/ipc/desktopHandlers.js') + read('modules/ipc/desktopMetrics.js');
    const operations = require('../modules/desktopApi/operations/desktop').createDesktopOperations();
    const channels = operations.filter((entry) => entry.ipc).map((entry) => entry.ipc.channel);
    assert.ok(channels.length > 0);
    for (const channel of channels) {
        assert.ok(source.includes(`ipcMain.handle('${channel}'`), `主进程没有 ${channel}`);
    }
});

test('V桌面接口目录：渲染端 RPC 命令在桌面画布都有实现', () => {
    const bridgeSource = read('Desktopmodules/api/ipcBridge.js');
    const opsSource = read('modules/desktopApi/operations/desktop.js');
    const commands = [...opsSource.matchAll(/queryDesktopRenderer\('([A-Za-z]+)'/g)].map((m) => m[1]);
    assert.ok(commands.length >= 5);
    for (const command of commands) {
        assert.ok(bridgeSource.includes(`case '${command}':`), `Desktopmodules/api/ipcBridge.js 没有处理 ${command}`);
    }
});

test('V桌面接口：行为与参数校验', async () => {
    const bridge = fakeBridge();
    const replies = { 'desktop-list-widgets': { success: true, widgets: [{ id: 'fav_1', name: '天气', thumbnail: 'data:image/png;base64,AAAA', pinned: true }] } };
    const ipcCalls = [];
    const api = createDesktopApi({ bridge, invokeIpc: async (channel, args) => { ipcCalls.push([channel, args]); return replies[channel] || { success: true, data: null }; }, logger: null });

    const favorites = await api.call('desktop.favorites.list', {}, { caller: 'model' });
    assert.deepEqual(favorites.data.widgets, [{ id: 'fav_1', name: '天气', pinned: true, dir: 'AppData/DesktopWidgets/fav_1' }], '不返回缩略图');

    const created = await api.call('desktop.widget.create', { builtinWidgetKey: 'cpu', x: '10', autoSave: 'false' }, { caller: 'model' });
    assert.equal(created.ok, true);
    assert.deepEqual(bridge.calls.at(-1), ['create', { builtinWidgetKey: 'cpu', x: 10, autoSave: false }]);
    assert.equal((await api.call('desktop.widget.create', {}, { caller: 'model' })).error.code, 'INVALID_PARAMS');
    assert.equal((await api.call('desktop.widget.create', { builtinWidgetKey: 'fan' }, { caller: 'model' })).error.code, 'INVALID_PARAMS');

    await api.call('desktop.widget.remove', { widgetId: 'w1' }, { caller: 'widget' });
    assert.deepEqual(bridge.calls.at(-1).slice(0, 3), ['rpc', 'RemoveWidget', { widgetId: 'w1' }]);

    const wallpaper = await api.call('desktop.wallpaper.set', { source: 'https://e.x/a.jpg' }, { caller: 'model' });
    assert.deepEqual(wallpaper.data, { type: 'image', source: 'https://e.x/a.jpg', filePath: 'https://e.x/a.jpg' });

    await api.call('desktop.metrics.snapshot', { includeProcesses: 'true' }, { caller: 'widget' });
    assert.deepEqual(ipcCalls.at(-1), ['desktop-metrics-get-snapshot', [{ includeProcesses: true, includeDocker: false, forceRefresh: false }]]);

    assert.equal((await api.call('vchat.app.launch', { appAction: 'open-notes-window' }, { caller: 'model' })).ok, true);
    const rejected = await api.call('vchat.app.launch', { appAction: 'open-system-tool:cmd.exe /c del' }, { caller: 'model' });
    assert.equal(rejected.error.code, 'INVALID_PARAMS');
    assert.equal(ipcCalls.at(-1)[1][0], 'open-notes-window', '被拒的动作没有发到主进程');
});

test('桌面没开时：状态查询返回 desktopOpen=false，不打开窗口', async () => {
    const bridge = fakeBridge({ getDesktopWindow: () => null });
    const api = createDesktopApi({ bridge, invokeIpc: async () => null, logger: null });
    const result = await api.call('desktop.state.query', {}, { caller: 'model' });
    assert.deepEqual(result.data, { desktopOpen: false, widgets: [], icons: [] });
    assert.equal(bridge.calls.length, 0);
});

test('appAction 白名单只放行已知应用与 Loom 应用', () => {
    assert.equal(isAllowedAppAction('open-music-window'), true);
    assert.equal(isAllowedAppAction('open-loom-app:my_app-1'), true);
    assert.equal(isAllowedAppAction('open-system-tool:control'), true);
    assert.equal(isAllowedAppAction('open-system-tool:powershell'), false);
    assert.equal(isAllowedAppAction('open-loom-app:../x'), false);
});

test('DesktopRemote 插件：新命令的载荷与别名', () => {
    assert.deepEqual(buildPayload({ command: 'ListAPIs', prefix: 'desktop.widget' }), { command: 'ListAPIs', prefix: 'desktop.widget' });
    assert.deepEqual(buildPayload({ command: 'describe_api', api_id: ' desktop.dock.query ' }), { command: 'DescribeAPI', apiId: 'desktop.dock.query' });
    assert.deepEqual(buildPayload({ command: 'CallAPI', apiId: 'desktop.widget.remove', params: '{"widgetId":"w"}' }), { command: 'CallAPI', apiId: 'desktop.widget.remove', params: { widgetId: 'w' } });
    assert.deepEqual(buildPayload({ command: 'callapi', api: 'desktop.state.query' }), { command: 'CallAPI', apiId: 'desktop.state.query', params: {} });
    assert.throws(() => buildPayload({ command: 'CallAPI' }), /apiId/);
    assert.throws(() => buildPayload({ command: 'CallAPI', apiId: 'x', params: '[1]' }), /JSON object/);
});

test('DesktopRemote 清单里的命令，主进程都能分发', () => {
    const manifest = JSON.parse(read('VCPDistributedServer/Plugin/DesktopRemote/plugin-manifest.json'));
    const handlerSource = read('modules/ipc/desktopRemoteHandlers.js');
    for (const { command } of manifest.capabilities.invocationCommands) {
        assert.ok(handlerSource.includes(`case '${command}':`), `desktopRemoteHandlers 没有分发 ${command}`);
        assert.equal(buildPayload({ command, apiId: 'desktop.state.query', widgetId: 'w', wallpaperSource: 'https://e.x/a.png', htmlContent: '<b>x</b>' }).command, command);
    }
});

test('preload：桌面窗口能调用 desktop-api 通道，且与 IPC 契约一致', () => {
    const byName = new Map(describeApis().map((entry) => [entry.name, entry]));
    const expected = { desktopApiList: IPC_CHANNELS.LIST, desktopApiDescribe: IPC_CHANNELS.DESCRIBE, desktopApiCall: IPC_CHANNELS.CALL };
    for (const [name, channel] of Object.entries(expected)) {
        const entry = byName.get(name);
        assert.ok(entry, `preload 缺少 ${name}`);
        assert.equal(entry.channel, channel);
        assert.deepEqual(entry.roles, ['desktop'], `${name} 只给桌面窗口`);
    }
    const widgetSandbox = read('Desktopmodules/core/widgetManager.js');
    for (const method of ['apis', 'describe', 'call']) {
        assert.ok(new RegExp(`${method}: function\\(`).test(widgetSandbox), `挂件 vcpAPI 缺少 ${method}`);
    }
});
