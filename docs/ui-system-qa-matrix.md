# 新版 UI Electron QA 矩阵

本表只记录已经在真实 Electron 渲染器中执行过的检查。`partial` 不得作为发布完成的依据。

| Surface | Verified | Remaining |
| --- | --- | --- |
| Shell、侧栏、输入区 | 新版字体、Material Symbols、焦点、无横向溢出；经典模式输入圆角回归 | 最小窗口人工截图复查 |
| 内部应用 | UI 组件库打开后切到经典 UI，会清理 Host、标签、展示页根节点和 Feedback Host | 组件库长时间打开的内存采样 |
| Web Awesome 对照 | 3.11.0 本地 `dist-cdn` 构建可注册；Button/Input/Select/Tooltip/Dialog 已真实渲染，Dialog 打开、Tooltip open、主题强调色映射和宽屏双列无溢出已验证 | 深色、compact、窄窗口完整截图；打包后资源解析 smoke |
| 全局设置 | 浅色默认尺寸、深色 700×500；双栏、滚动与保存栏均无横向溢出 | 每个分区保存、错误与键盘 Escape |
| 业务弹窗 | 头像裁剪、创建群组、模型、转发、正则、筛选规则与编辑器均可首开，均为 8px 作用域外壳 | 实际规则编辑与提交 |
| 全局搜索 | Ctrl+F 首开、输入聚焦、Escape、模式切换清理、空态 | 带真实结果的分页和跳转 |
| Agent/Group 设置 | 真实 Agent 选择、设置页、折叠区段；新旧模式样式隔离 | 保存、删除、校验、真实 Group 数据 |
| 消息与富内容 | 壁纸透出；消息、代码、工具摘要、思考链、桌面推送、日记、表格；700px 表格不溢出 | 真实长流、错误、工具调用、媒体和最小窗口 |

所有本地验证前后均运行：

```bash
npm run check:ui-system
git diff --check
```

组件或页面只有在对应剩余项全部完成，并有新的 Electron 截图审查证据时，才可将 `partial` 升为 `migrated`。
