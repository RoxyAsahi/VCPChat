# 桌宠（试验功能）

在聊天头部点爪印按钮，就会把当前 Agent 放到桌面上：透明、无边框、置顶，只有角色本身和气泡可以点，空白处鼠标直接穿透到下面的窗口。

- **直接对话：** 双击角色（或右键「和 TA 说话」）弹出输入框，Enter 发送、Esc 收起。话经主窗口按正常流程发出，历史、话题都照常保存；主窗口当前不是这个 Agent 时会自动切过去。
- **回复气泡：** 回复边流出边显示在角色上方（情绪标记、思维链、工具调用不显示，代码块显示为 […]）。点气泡打开主窗口看完整内容。
- **表情：** 跟着回复换表情；思考、调用工具、出错时有对应状态；单击角色会做个开心的动作。
- **右键菜单：** 和 TA 说话、切换助手（原位置换成另一个 Agent）、打开主窗口、隐藏桌宠、关闭桌宠。

不放任何素材时，桌宠只显示 Agent 的头像，加上一个情绪圆环。下面任意一种素材都能让它更像样。

## Windows 上怎么试

### 1. 放 Live2D 模型（可选）

1. **Cubism Core。** 去 Live2D 官网下载 Cubism SDK for Web（必须是 **5.x**，例如 5-r.4）。从里面拿出 `Core/live2dcubismcore.min.js`，放到：
   ```
   <VCPChat>\AppData\deskpet\live2dcubismcore.min.js
   ```
   如果设置了 `VCPCHAT_APP_DATA_DIR`，就放在那个目录下的 `deskpet\` 里。注意不能用 6.x（SDK 5-r.5 及以后）：渲染引擎还不支持，桌宠会提示并自动改用立绘。
2. **模型。** 把整个模型文件夹（里面有 `*.model3.json`、`.moc3`、贴图等）放到：
   ```
   <VCPChat>\AppData\Agents\<AgentId>\deskpet\<模型文件夹>\
   ```
   官方示例模型里 Mao、Natori 带表情文件，适合试情绪；Hiyori 没有表情文件，只能靠参数叠加看出变化。
3. **表情映射（可选）。** 官方示例 Natori、Mao、Haru、Ren 已内置映射，放进去就能用（推荐 Natori：表情最全）。其他模型可以在模型文件夹里放一个 `deskpet.json`：
   ```json
   {
     "expressions": { "neutral": "Normal", "happy": "Smile", "shy": "Blushing", "sad": "Sad",
                      "angry": "Angry", "surprised": "Surprised" },
     "motions": { "happy": "TapBody" }
   }
   ```
   情绪键与侧栏差分立绘相同，共 12 个：`neutral calm happy excited shy affectionate curious surprised concerned sad tired angry`。没写的情绪按表情名去猜（含 smile、angry 之类的词）。

本项目不附带任何 Live2D 文件（Core 和模型都受 Live2D 的许可约束），需要自己下载。

### 2. 或者放差分立绘（可选）

没有 Live2D 模型时，桌宠会使用立绘，和侧栏首页立绘是同一套文件（在 Agent 设置里上传的差分这里也能用）：

```
AppData\Agents\<AgentId>\portrait.png           默认立绘
AppData\Agents\<AgentId>\portrait.happy.png     各情绪的差分（12 个情绪键）
AppData\Agents\<AgentId>\portrait.thinking.png  状态差分：thinking / tool / error
```

缺哪张就退回最相近的情绪，最后退回默认立绘。透明背景的 PNG 或 WebP 效果最好，点击只命中不透明的像素。

### 3. 打开和关闭

- **打开或收起：** 选中一个 Agent，点聊天头部的爪印按钮。按钮高亮表示这个 Agent 的桌宠开着；隐藏了的桌宠再点一次就回来。
- **移动：** 按住角色拖动，位置会记住。
- **关闭：** 右键角色选「关闭桌宠」，或者再点一次爪印按钮。桌宠不在任务栏里，Alt+F4 关不掉它。
- 关掉主窗口时，所有桌宠一起关闭。

## 情绪从哪里来

和侧栏差分立绘共用 `modules/emotion`：桌宠打开期间，发给这个 Agent 的请求会在 system prompt 末尾加一段说明（侧栏已经加过、或角色提示词里自己写了就不重复），请模型在回复里写 `<!--emo:happy 0.8-->` 这样的标记。标记会从聊天显示里剥掉。

模型没写标记时，会按回复文字用规则推测一个情绪，桌宠角标上会注明「推测」。桌宠关着时，请求不会多加任何东西。

还没做：TTS 口型同步（现在回复流出时是假口型）。

## 文件

- `modules/ipc/deskPetHandlers.js`：主进程部分，负责窗口、`vcp-deskpet://` 资源协议、提示词注入、把回复流转给桌宠、桌宠发言转给主窗口、右键菜单。
- `modules/emotion/`：情绪标签、规则兜底、情绪导演和差分挑图（与侧栏立绘共用）。
- `DeskPetmodules/`：桌宠页面，后端依次是 Live2D、立绘、头像；气泡和输入框。
- `vendor/live2d/`：untitled-pixi-live2d-engine 1.4.0（MIT）。
