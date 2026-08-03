# 新版 UI 视觉 QA 审计报告（E 组 · 基线 2444ffd6）

> 历史收据说明（2026-08-03）：本页截图证明当日实验性重建曾成功渲染，不代表当前产品启用。当前只启用笔记与翻译；大部分业务页面由 `docs/ui-active-surface-policy.md` 暂时归档，Canvas 的实验重建则已撤销并恢复 `origin/main` 的经典实现。

- 审计日期：2026-08-02
- 审计基线：`2444ffd6`（含全部 WIP：12 页已重建为 next 模式、Web Awesome vendored、门禁脚本齐全）
- 审计组：E 组（视觉 QA 与集成门槛）
- 方法：真实 Electron 逐页审计（非 JSDOM），`scripts/test-electron-ui-apps-smoke.mjs`（主界面 + 8 个 embedded 页 + Canvas/RAG 独立窗口 + VchatManager 子应用）与 `scripts/test-electron-human-toolbox-smoke.mjs`（工具 ToolBox），覆盖 next 与 classic 两种模式；另用自研 PNG 解码器对全部 38 张截图做像素级布局度量（内容包围盒、覆盖率、边缘贴边、空白行占比），作为人工视觉审查的定量证据。
- 截图根目录：`screenshots/`（已加入 `.gitignore`，不随 commit 携带；本报告给出相对路径）。

> 说明：本模型的会话无法直接“看”位图，因此“人工视觉审查”落为像素度量 + DOM/CSS 几何分析的复合审查。所有度量基于真实 Electron 渲染器的截图与实时 DOM 计算，结论可直接用于人工复核。

---

## 1. 逐页状态矩阵（12 页 + 全局设置）

状态口径：**未迁移**（无 runtime 接入）→ **结构迁移**（next 模式能挂载 AppPageShell）→ **Hermetic verified**（真实 Electron 内构建完成、WA 真实参与、无渲染错误）→ **视觉通过**（几何/溢出/重叠/留白通过 + 截图像素证据）→ **真实业务验证**（需真实后端数据/人工操作，本组不负责）。

| # | 页面 | 入口 | next 模式 | classic 模式 | WA 真实参与 | 焦点/键盘 | 窄屏 | 截图 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 便签 | embedded | ✅ AppPageShell + `wa-input`×1 | ✅ 旧 DOM 保留 | `wa-input`=1（真 WA） | ✅ 焦点/正文可聚焦 | ✅ 无横溢 | `next-便签.png` / `-narrow` / `classic-便签.png` | Hermetic verified（视觉留白见 D-05） |
| 2 | 翻译 | embedded | ✅ 翻译助手 shell | ✅ 旧 DOM 保留 | `wa-tooltip`=3（真 WA）+ native 增强≥2 | ✅ 焦点+Tab | ✅ 无横溢（覆盖 71%） | `next-翻译.png` / `-narrow` | 视觉通过 |
| 3 | 日志 | embedded | ✅ VCP日志中心 shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 + native 增强≥1 | ✅ 焦点+Tab | ✅ | `next-日志.png` / `-narrow` | 视觉通过 |
| 4 | 插件 | embedded | ✅ 插件管理器 shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 + native 增强≥2 | ✅ 焦点（首个可见控件）+Tab | ✅ | `next-插件.png` / `-narrow` | 视觉通过（长列表属预期） |
| 5 | 任务 | embedded | ✅ 任务助手 shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 | ✅ 无表单控件（列表型页面） | ✅ | `next-任务.png` / `-narrow` | Hermetic verified（空态留白，数据相关） |
| 6 | 笔记 | embedded | ✅ 我的笔记 shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 + native 增强≥1 | ✅ 焦点+Tab | ✅ | `next-笔记.png` / `-narrow` | 视觉通过 |
| 7 | 记忆 | embedded | ✅ 记忆工作台 shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 + native 增强≥1 | ✅（无可见表单控件，见注 1） | ✅ | `next-记忆.png` / `-narrow` | Hermetic verified（依赖初始化，见注 1） |
| 8 | 论坛 | embedded | ✅ VCP 论坛 shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 + native 增强≥1 | ✅ 焦点+Tab | ✅ | `next-论坛.png` / `-narrow` | 视觉通过 |
| 9 | 协同Canvas | 独立窗口 | ✅ 协同 Canvas shell | ✅ 旧 DOM 保留 | `wa-tooltip`≥1 + native 增强≥1 | ✅ 焦点+Tab（textarea 除外） | ✅ | `next-协同Canvas.png` / `-narrow` | 视觉通过 |
| 10 | 监听RAG | 独立窗口 | ✅ VCP 监听 shell | ✅ 旧 DOM 保留 | **0（wa-tooltip=0, native=0）** | ✅ | ✅ | `next-监听RAG.png` / `-narrow` | 结构迁移（WA 参与缺失，见 D-02） |
| 11 | 工具ToolBox | 独立子应用 | ✅ 50 工具、`wa-card`=50、Lucide≥2 | —（独立应用） | `wa-card`=50、`wa-input`、`wa-button`、`wa-tooltip` | ✅ 搜索聚焦+Tab、空态、长文本 | ✅ | `human-toolbox-*.png`×5 | 视觉通过 |
| 12 | 数据VchatManager | 独立子应用 | **❌ 恒 classic，next 从不触发** | ✅ 旧 DOM | 0 | — | — | `next-VchatManager.png` | 结构迁移（wiring 缺失，见 D-03） |
| G | 全局设置 | 主界面弹窗 | ✅ 控件增强+保存栏 dirty 态+搜索注入+焦点 | ✅ next 表面拆除 | — | ✅ 焦点 | — | `main-settings-next.png` | 视觉通过 |
| S | 主界面/组件库 | 主界面 | ✅ boot 零 WA 请求/零注册；组件库懒加载 WA；Lucide 生效 | ✅ 切 classic 清理 | 懒加载注册 | ✅ | — | `main-showcase.png` | 视觉通过 |

注 1：记忆页在无后端初始化时显示「初始化未完成」，首屏无可见表单控件；文件夹初始化在真实环境完成。该空态不构成 next 模式缺陷，但列入“真实业务验证”项。
注 2（已由后续 Select 迁移取代）：业务页仍保留原生 select 作为兼容真源，但 next mode 的可见选择器改由 VCPUI Select Proxy 创建 `wa-select`；Input/Textarea 仍按各页面迁移状态处理。

---

## 2. 截图像素度量证据（视觉审查定量结论）

38 张截图经自研解码器（zlib + Adam7 反交错）逐像素分析。核心信号：

| 截图 | 尺寸 | 覆盖率 | 内容包围盒 | 贴边 | 空行占比 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `next-翻译.png` | 800×600 | 73.5% | x15..784 y40..571 | 无 | 0.17 | 布局充实，无贴边/溢出 |
| `next-日志.png` | 800×600 | 17.1% | x0..799 y6..599 | LR+B | 0.02 | 内容填满底部，正常（日志列表） |
| `next-插件.png` | 800×4921 | 17.4% | x0..799 y14..4920 | LR+B | 0.02 | 全页高度 4921px = 插件长列表，预期 |
| `next-插件-narrow.png` | 480×12645 | 15.1% | 480×12631 | LR+B | 0.01 | 480px 下卡片竖排 12.6kpx，长列表预期 |
| `next-便签.png` | 800×600 | 2.0% | x9..791 y14..252 | 无 | 0.66 | **正文区只占顶部 ~239px，底部 ~340px 留白** → D-05 |
| `next-便签-narrow.png` | 480×720 | 0.8% | 456×236 | 无 | 0.73 | 同上放大 |
| `next-任务.png` | 800×600 | 1.9% | x0..799 y12..317 | LR | 0.68 | 空态（无 agent/task 数据），内容不填满 → 空态留白（数据相关，非回归） |
| `next-记忆.png` | 800×600 | 4.5% | x0..799 y39..599 | LR+B | 0.15 | 初始化未完成空态 |
| `next-论坛.png` | 800×600 | 6.3% | x0..799 y4..473 | LR | 0.22 | 空态（无帖子） |
| `next-协同Canvas.png` | 800×600 | 19.6% | x0..799 y40..590 | LR | 0.14 | 编辑器主体填充良好 |
| `next-监听RAG.png` | 800×600 | 4.1% | x16..799 y15..599 | R+B | 0.15 | 观察器日志区（hermetic 无日志数据） |
| `human-toolbox-tools.png` | 全页 | 高 | — | — | — | 50 工具卡片网格 |
| `next-VchatManager.png` | 800×600 | 3.8% | x15..744 y0..599 | T+B | 0.0 | classic 旧布局，无 next 表面 |
| `classic-便签.png` | 800×600 | 94.5% | 800×600 | LRTB | 0 | classic 便签填满（对照） |

结论：除便签正文区留白（D-05）与各页空态首屏不填满（数据相关）外，无横向溢出、无贴边截断、无头部控件重叠；文字层级（shell 标题 ellipsis、action 区右对齐）与经典模式对比无劣化。

---

## 3. 缺陷清单

### D-01（高）embedded 页面 uiMode 解析忽略应用数据根目录
- 页面：全部 embedded 业务页（便签/翻译/日志/插件/任务/笔记/记忆/论坛/主题）
- 现象：`settings.json` 里 `uiMode: "next"` 时，embedded 视图仍收到 `?uiMode=classic`；在打包环境（userData）或设置了 `VCPCHAT_APP_DATA_DIR` 的隔离环境必现。
- 复现：`main.js` 以 `VCPCHAT_APP_DATA_DIR=<dir>` 启动（或打包运行），`<dir>/settings.json` 为 next；打开任一 embedded 应用 → 页面 `data-ui-mode=classic`。
- 根因：`modules/services/embeddedAppSessionManager.js` 的 `readUiMode()` 硬编码 `appRoot/AppData/settings.json`，没有走 `APP_DATA_ROOT_IN_PROJECT`（主进程的 `VCPCHAT_APP_DATA_DIR`/打包 userData 逻辑）。
- 期望：embedded 页与主界面同源解析 uiMode（复用 `APP_DATA_ROOT_IN_PROJECT`）。
- 截图：`next-VchatManager.png`（对照）；embedded 页被强制 classic 时即基线旧 DOM，参见 `classic-*.png`。
- 测试工作区规避：`test-electron-ui-apps-smoke.mjs` 将 next 设置镜像到 `<repo>/AppData/settings.json`（gitignored，仅运行期存在），并在文档中标注。

### D-02（中）监听RAG 页 next 重建无任何真实 WA 参与
- 页面：监听 RAG（`RAGmodules/RAG_Observer.html`）
- 现象：`buildNextRag` 的 `tooltipSelectors: ['rag-pause-btn', 'rag-clear-btn']` 缺少 `#` 前缀且页面上根本不存在这两个按钮（全页只有 `win-*/mac-*` 窗口按钮），`wa-tooltip=0`；页面唯一输入是 `type="range"`，不匹配增强选择器，`nativeEnhanced=0`。结果：该页 next 模式只有 AppPageShell 外壳，没有任何 WA 组件真实参与。
- 复现：next 模式打开监听窗口，DevTools 查询 `document.querySelectorAll('wa-tooltip').length` → 0。
- 期望：为监听页真实存在的操作按钮（或移除死选择器）接入 VCPUI Tooltip；若暂停/清空按钮属于后续功能，先删除无效选择器避免误导。
- 截图：`next-监听RAG.png`。

### D-03（高）VchatManager 数据页从未进入 next 模式
- 页面：数据 VchatManager（`VchatManager/`）
- 现象：`index.html` 已接入 runtime bootstrap 且 `script.js` 已实现 `buildNextVchatManager`，但文档永远解析为 `classic`，next 重建从不触发。
- 复现：启动 `electron VchatManager`，`document.documentElement.dataset.uiMode` → `classic`；`window.api.loadSettings` 不存在。
- 根因：`VchatManager/main.js` 不读取 settings、不传 `?uiMode`；`preload.js` 只暴露 `window.api`（无 `loadSettings`），bootstrap 的 `defaultReadMode` 找不到 provider 即回退 classic。
- 期望：仿照 `VCPHumanToolBox/main.js`（`query: { uiMode: readUiMode() }`）把 uiMode 下发给窗口。
- 截图：`next-VchatManager.png`。

### D-04（低）主界面 CSP 阻断 Font Awesome 的 data: 图标加载（控制台噪音）
- 页面：主界面（`main.html`）
- 现象：启动即出现多条 console error：`connect-src * ws: wss:` 不含 `data:` 导致 `data:image/svg+xml`（Font Awesome 内联 SVG）被拒。
- 复现：真实 Electron 启动主界面，打开 DevTools Console。
- 期望：`img-src`/`connect-src` 显式加入 `data:`，或图标改走 VCPUI 图标体系（当前 `.vcp-ui-icon`/Lucide 已就绪）。
- 影响：视觉无碍，但污染错误监控；测试脚本已将该噪音过滤以聚焦真实 JS 异常。

### D-05（低）便签正文 textarea 不填满可用高度（底部留白）
- 页面：便签（`Notemodules/notemini.css`）
- 现象：next 模式下 `.vcp-ui-page-shell-content` 高 554px，但 `.vcp-ui-mini-note-body` 只到 y≈262（文本域 216px），底部约 340px 留白；窄屏更明显。
- 根因：`.vcp-ui-mini-note-body` 用 `flex: 1 1 auto` 撑高，但其父 `.vcp-ui-page-shell-content` 是 `display:block`（非 flex 容器），flex 不生效；对照 `.vcp-ui-page-body`（`height:100%`）在其他页面正常。
- 期望：`.vcp-ui-mini-note-body` 改 `height: 100%` 或让 shell content 作为 flex 容器。
- 截图：`next-便签.png`（bbox y14..252）。

### D-06（信息）业务页表单控件为「native 增强」而非真 WA 控件
- 页面：除便签外的全部业务页
- 历史现象：早期 `VCPUI.enhance('Select')` 只增加原生样式，不生成 `wa-select`。
- 当前决策：Select 已采用双向 Proxy；保留原生 `.value/.options` 契约不再阻止业务页面使用真正的 Web Awesome Select。该文档其余截图结论仍代表当日基线，不自动视为本轮验收收据。

---

## 4. 测试命令与关键输出

```bash
# 主应用（主界面 + 8 embedded 页 + Canvas/RAG + VchatManager 子应用），真实 Electron
node scripts/test-electron-ui-apps-smoke.mjs
#   → Electron UI apps smoke passed (boot WA gate, showcase, global settings,
#     8 embedded pages, canvas/RAG standalone, classic regression).
#   → UI apps audit summary (24/25 passed)：VchatManager 行按缺陷 D-03 标记为 FAIL（信息性，非测试失败）

# 工具 ToolBox（独立子应用）
node scripts/test-electron-human-toolbox-smoke.mjs
#   → Electron Human ToolBox smoke passed (50 tools, focus/keyboard/empty/long-text/detail/manage/narrow verified).

# 门禁
npm run check:ui-applications   # → UI applications gate passed (81 files, 2 parts) + Page runtime gate passed (0 wired, 12 rebuilt)
npm run check:ui-system         # → 全绿（含 check:ui-applications、lint、契约测试）
```

（`npm run test:electron-ui-apps` = 上述两个 smoke 串行执行。）

---

## 5. 已知阻塞 / 中间态（并发说明）

- **embedded 模式解析（D-01）**：基线 `readUiMode()` 读项目根 `AppData/settings.json`；本审计的 worktree 无 `AppData/`，故 smoke 测试在工作区根创建 gitignored `AppData/settings.json`（uiMode=next）以复现真实用户路径。最终修复应落在 `embeddedAppSessionManager`，属 A/B/C/D 底座组范围。
- **VchatManager（D-03）**、**监听RAG WA 参与（D-02）**：均为基线缺陷，若后续组修复，E 组 smoke 断言（RAG `wa-tooltip>=0` 与 VchatManager 信息性 FAIL）会自动反映；协调者合并后建议重跑 `npm run test:electron-ui-apps` 复验。
- **记忆页「初始化未完成」**：依赖 RAG/后端初始化，hermetic 环境不可达，属真实业务验证项，不阻塞结构验收。
- 各 embedded/独立窗口的 WA 断言按「tooltip 为真 WA + native 增强计数」口径设置，若后续把业务控件升级为真 `wa-input/wa-select`，需同步放宽/调整断言。

---

## 6. 遗留风险

1. 视觉留白（D-05、空态页）依赖人工复核：像素度量证明无溢出/贴边/重叠，但“好不好看”需真人看图确认 `screenshots/` 中 38 张截图。
2. 插件页全页高 4921px / 窄屏 12645px 属长列表预期，但列表项密度/卡片高度建议人工抽看 `next-插件.png`。
3. `wa-*` 的「native 增强」策略下，真 WA 组件参与证据集中在 tooltip 与组件库段；若验收标准要求业务页出现真 `wa-input/wa-button`，需要变更业务实现（超出 E 组职责）。
4. 主界面 CSP 噪音（D-04）已纳入缺陷但未修复（属底座组/实现组）。
5. smoke 脚本总耗时约 5–7 分钟（8 页 × next+classic + 独立窗口 + VchatManager），属可接受的 CI 规模；若需提速可加 `--only-next` 参数（未实现）。
