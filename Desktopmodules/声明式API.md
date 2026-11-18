# V桌面声明式 API：设计与施工计划

> 2026-11-18 起。目标是把 VChat 前端 IPC、后端插件指令、数据存储逐步封装成**同一张声明式接口目录**：AI 一句话就能发现并调用，桌面挂件用同一套 ID 调用，新能力只需登记一次。

## 一、为什么要做

现在桌面能力分散在三套互不相通的接口里：

| 接口 | 规模（2026-11-18 上游 main） | 谁在用 | 问题 |
|---|---|---|---|
| preload IPC（`preloads/api/*.js`） | 38 个领域、567 条（407 查询、67 命令、93 订阅） | 各窗口页面 | 只对页面开放；AI 和挂件拿不到；没有参数说明 |
| DesktopRemote 插件命令 | 7 条 | AI | 每加一条命令要改 4 处：插件清单、`desktop-remote.js` 取参、`desktopRemoteHandlers.js` 分发与 Markdown 报告、`Desktopmodules/api/ipcBridge.js` 渲染端 RPC |
| 挂件沙箱 `vcpAPI` / `musicAPI` / `widgetFS` | 十来个函数 | 挂件 | 手写注入，每加一个能力改沙箱模板；没有权限级别 |
| 后端插件（VCPToolBox + 本地分布式服务器） | 97 个插件 310 条命令；本地 33 个插件 261 条命令 | AI | 挂件只能拿 `vcpAPI.fetch` 碰 admin_api，调不到工具 |

声明式目录要解决的就是：**一处登记，三方可见（AI、挂件、以后的聊天气泡/Canvas），统一校验、统一权限、统一错误。**

## 二、设计

### 2.1 接口定义

每个接口是一段数据（`modules/desktopApi/operations/*.js`）：

```js
{
    id: 'desktop.widget.remove',          // 领域.对象.动作
    title: '关闭挂件',
    description: '从桌面上关闭一个挂件。只关闭画布上的实例，不删除收藏目录。',  // 第一句即目录摘要
    access: 'write',                      // read | write | danger
    callers: ['model', 'widget'],         // 谁能调用
    params: { widgetId: { type: 'string', required: true, maxLength: 200, description: '…' } },
    returns: '{ widgetId, removed }',
    timeoutMs: 10000,
    handler: ({ widgetId }, { bridge }) => bridge.queryDesktopRenderer('RemoveWidget', { widgetId }),
}
```

已有 `ipcMain.handle` 实现的能力不用再写 handler，直接引用通道：

```js
ipc: {
    channel: 'desktop-list-widgets',
    args: (params) => [...],              // 参数排成通道的位置参数
    map: (data) => ({ ... }),             // 裁剪返回值，例如去掉缩略图 data URL
}
```

`modules/desktopApi/ipcHandlerIndex.js` 在启动最早期记下每个 `ipcMain.handle` 的实现，`{ success, data, error }` 信封会自动解开。这样把一条现有 IPC 开放出来，只需要写说明和参数，是“繁琐但不难”的那部分力工活里最省的形态。

### 2.2 参数

类型只有 `string / number / integer / boolean / object / array / json`，外加 `required / default / enum / min / max / maxLength / pattern`。

- **宽松转换**：VCP 工具参数几乎都是字符串，`"12"`→12、`"true"`→true、JSON 文本→对象，按声明自动转。
- **严格字段**：未声明的参数直接报错并列出可用参数名（例如把 `widgetId` 写成 `widgetID`），不会被悄悄忽略。
- 描述可直接转成 JSON Schema（`DescribeAPI` / `vcpAPI.describe` 返回的就是它）。

### 2.3 访问级别与调用方

| access | 含义 | 现在的规则 |
|---|---|---|
| `read` | 只读 | 按 `callers` 开放 |
| `write` | 改变桌面或打开窗口 | 按 `callers` 开放；AI 调用仍经过 VCPToolBox 的工具审核 |
| `danger` | 删除数据、执行命令、写文件 | 目录里不显示，任何调用方都不能用，等第五批的用户确认机制 |

调用方：`model`（AI 经 DesktopRemote）、`widget`（桌面挂件）。`desktop-api:*` 通道只认桌面窗口自己的 webContents，别的窗口调用一律拒绝。

### 2.4 三个入口

**AI**（DesktopRemote 插件新增三条命令，原有 7 条保持兼容）：

```
ListAPIs     [prefix] [query]   → 目录表：apiId、access、参数名、摘要
DescribeAPI  apiId              → 完整说明 + 参数 JSON Schema + 返回值 + 示例
CallAPI      apiId [params]     → JSON 结果；参数错误会说明哪个字段错了
```

先看目录再按需取说明，不把所有接口说明一次塞进上下文；工具清单只多 3 条命令，以后接口再多也不会涨。

**挂件**：

```js
const apis = await vcpAPI.apis({ prefix: 'desktop.metrics' });
const info = await vcpAPI.describe('desktop.metrics.snapshot');
const snap = await vcpAPI.call('desktop.metrics.snapshot', { includeProcesses: true });
// 失败抛 Error，error.code 为 API_NOT_FOUND / API_FORBIDDEN / INVALID_PARAMS / API_FAILED / API_TIMEOUT / API_UNAVAILABLE
```

**主进程代码**：`require('./modules/desktopApi').getDesktopApi().call(id, params, { caller })`，返回 `{ ok, id, data }` 或 `{ ok: false, id, error: { code, message, field? } }`，从不抛错，可原样跨进程传回。

## 三、第一批（已完成）

| 接口 | access | 实现 |
|---|---|---|
| `desktop.state.query` | read | 渲染端 RPC `QueryDesktop`；桌面没开返回 `desktopOpen: false` |
| `desktop.dock.query` | read | 渲染端 RPC `QueryDock` |
| `desktop.widget.source` | read | 渲染端 RPC `ViewWidgetSource` |
| `desktop.favorites.list` | read | IPC `desktop-list-widgets`，去掉缩略图，补 `dir` |
| `desktop.layout.load` | read | IPC `desktop-load-layout` |
| `desktop.metrics.snapshot` | read | IPC `desktop-metrics-get-snapshot` |
| `desktop.metrics.capabilities` | read | IPC `desktop-metrics-get-capabilities` |
| `desktop.style.status` | read | 渲染端 RPC `GetStyleAutomationStatus` |
| `desktop.widget.create` | write | 与 DesktopRemote `CreateWidget` 共用 `createWidget()` |
| `desktop.widget.remove` | write | 新增渲染端 RPC `RemoveWidget` |
| `desktop.wallpaper.set` | write | 与 `SetWallpaper` 共用 `setWallpaper()` |
| `desktop.style.set` | write | 渲染端 RPC `SetStyleAutomation` |
| `vchat.app.launch` | write | IPC `desktop-launch-vchat-app`，`appAction` 白名单（内置应用、五个系统工具、`open-loom-app:<id>`） |

文件：`modules/desktopApi/{schema,registry,ipcHandlerIndex,index}.js`、`modules/desktopApi/operations/desktop.js`；测试 `tests/desktop-api.test.js`。

## 四、分步施工计划

每一批独立成 PR，按对实际使用的影响排序。

### 第二批：后端插件接入（“IPC 直接对接后端插件”）

- 目录从插件清单生成，不手写：VCPToolBox 的 `/admin_api/plugins`（`invocationCommands`）与本地分布式服务器 `pluginManager.getAllPluginManifests()`，每条命令登记为 `vcp.<插件>.<命令>`，说明取清单 `description`，参数从调用示例里解析出名字（类型一律 `json`，交给插件自己校验）。
- 调用：远端插件走 `/v1/human/tool`（Bearer，`processToolCall` 自带工具审核），本地插件直接 `pluginManager.processToolCall`。
- 默认只给 `widget` 开放清单里标了只读的命令；其余 `write`，挂件调用需在第五批的授权里放行。
- 清单变化（插件启停、热重载）时刷新目录，并通知已打开的挂件。

### 第三批：VChat 前端 IPC 批量开放

- 在 `preloads/core/define.js` 的条目上加 `.expose({ id, title, access, params })`，开放与否写在领域文件里、和 IPC 定义挨着，不再另起一张表。
- 生成器把 `describeApis()` 里带 `expose` 的条目转成 `ipc` 型接口；守卫测试检查：开放条目都有说明和参数描述、通道在主进程有 handler、`danger` 不开放、依赖 `event.sender` 的通道不开放。
- 先开只读领域：音乐（状态、播放控制）、笔记与备忘列表/读取、助手与话题列表、主题、设置读取；再开写操作。

### 第四批：数据与存储

- 聊天记录（rust_chat_data_service）、笔记、备忘、RAG 观察数据的只读查询接口，统一分页（`offset` / `limit` / `nextOffset`）与大小上限。
- 挂件私有文件 `widgetFS` 也挂进目录，补文件锁或按 `widgetId` 分文件。

### 第五批：权限与确认（取代原“三期 Widget API Provider”规划）

- `danger` 接口启用：调用时在桌面弹确认卡，用户点允许才执行；AI 侧沿用 VCPToolBox 审核。
- 挂件级授权：`meta.json` 里声明 `permissions`（接口 ID 或前缀），未声明的写接口拒绝；收藏时展示所需权限。
- 调用审计：最近 N 次调用（调用方、接口、耗时、结果码）可在桌面调试面板查看。
- 同一套目录注入聊天气泡与 Canvas 沙箱，`chat` 调用方默认只读。

### 第六批：事件与流式

- 订阅类 IPC（93 条）开放为事件：`vcpAPI.on('music.state', fn)`，随挂件销毁自动退订。
- 流式结果（AI 推理、长任务进度）用同一信封分段推送。

### 收尾

- 原 7 条 DesktopRemote 命令改为目录接口的别名，主进程只剩一套实现。
- 由目录生成接口文档（本文第三节的表），加新鲜度检查，文档和代码不会走散。

## 五、已知限制

- 挂件之间仍没有安全隔离，`_realWindow.desktopAPI` 对挂件可见；第一批的 `callers` 与 `access` 是声明式约束，真正的挂件级授权在第五批。
- `ipc` 型接口的合成事件以桌面窗口为 sender；依赖调用方窗口身份的通道不能这样开放。
- 渲染端 RPC 类接口需要桌面窗口已打开（`desktop.state.query` 除外，它会如实返回 `desktopOpen: false`）。
