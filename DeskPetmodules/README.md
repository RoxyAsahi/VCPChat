# 桌宠（试验功能）

在聊天头部点爪印按钮，就会把当前 Agent 放到桌面上：透明、无边框、置顶，只有角色本身和气泡可以点，空白处鼠标直接穿透到下面的窗口。

- **直接对话：** 双击角色（或右键「和 TA 说话」）弹出输入框，Enter 发送、Esc 收起。话经主窗口按正常流程发出，历史、话题都照常保存；主窗口当前不是这个 Agent 时会自动切过去。TA 还在回复时发的话先排着，这条说完自动发出（气泡下方小字会写「说完就发」）。头顶上方放不下时，输入框出现在窗口底部，不挡脸。
- **回复气泡：** 回复边流出边显示在角色头顶（情绪标记、思维链、工具调用不显示；Markdown 记号整理成纯文字，代码块显示为 [代码]，图片显示为 [图片]）。回复结束后按长短停留 8 到 30 秒，鼠标停在气泡上时不收。点气泡打开主窗口看完整内容。
- **表情：** 跟着回复换表情；思考、调用工具、出错时有对应状态；单击角色会做个开心的动作（双击只打开输入框，不触发这个动作）。
- **闲着时：** 光标停住后视线自己四处看；隔十几秒做个小动作（歪头、伸懒腰、哼歌、东张西望）。3 分钟没人理就打哈欠、眼皮发沉、时不时点一下头，再过 1 分钟睡着（闭眼低头，头顶飘 z）。光标在窗口里晃一晃会慢慢醒；单击、拖动、来了回复或主动说话时惊醒。睡着时摸头不会醒，只在梦里笑一下。
- **互动：** 单击身体是开心，点头顶会害羞；光标在头上来回蹭是摸头；连点三下不耐烦（💢），戳到第六下晕了（💫），连点时第二下打开的空输入框会自己收回去。拖起来会慌，左右拖时身子跟着甩，放下时落地一顿。
- **免打扰：** 桌宠设置里开了免打扰时，不自己做小动作、不打哈欠、不冒小符号，只安静地呼吸眨眼、到点打盹；被碰到时照常反应。
- **省电：** 空闲 30 秒后降帧，睡着再降一档（10 帧，软件渲染 5 帧）；小动作按当前帧率演，被碰到才回到高帧率；隐藏桌宠时完全停止渲染，闲时计时也停；没有显卡、用软件渲染时帧率再降一档并关掉抗锯齿。
- **正在做什么：** 回复里调工具时，气泡下面有一条小卡片，比如「🔍 正在搜索 · 明天上海天气」，做完打勾、失败标红。
- **主动搭话：** AI 用「AI 主动创建话题」插件开了新话题时，开着的桌宠会把第一句话说出来，点气泡直接切到那个话题；用 VCP 闹钟插件设的闹钟到点时，桌宠（藏起来的也会出来）说出提醒事项。闹钟原本的弹窗照旧。
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

### 1b. 或者放网格立绘（可选，不需要 Cubism Core）

只有一张立绘、没有 Live2D 模型时，可以把图切成几块（底图、眼皮、睫毛、嘴型、腮红）做成 `*.puppet.json`，由 `puppet.js` 逐帧挪网格顶点：呼吸、眨眼、头和眼睛跟着光标、说话口型、按情绪换眼型嘴型和腮红。参数名与 Live2D 一致，情绪映射和 Live2D 共用。

```
<VCPChat>\AppData\Agents\<AgentId>\deskpet\<文件夹>\nova.puppet.json（及同目录的贴图）
```

Nova 的这一套由 `scripts/deskpet/build-nova-puppet.py` 从 `assets/nova_button_light.png` 生成（自动抠图，眼睛和嘴的位置手工标定）。同时放了 Live2D 模型和 Core 时优先用 Live2D。

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

## 闲时动作和模型

各种形象都有闲时表现，按能用的东西逐级退化：

- **Live2D：** 每个动作都是一组叠在标准参数上的曲线（`ParamAngleX/Y/Z`、`ParamEyeLOpen`、`ParamMouthOpenY` 等，模型没有的参数自动跳过），所以只有 Idle、TapBody 两组动作的官方示例也能打哈欠、打盹、睡觉。模型自己有对应动作组时会一起放（参数曲线只轻轻叠一点）：按组名认 `TapHead`、`Angry`、`Shake`、`Surprised`、`Yawn`、`Stretch`、`Wake`、`Landing` 等，也可以在 `deskpet.json` 的 `motions` 里写，键是动作名：
  ```json
  { "motions": { "yawn": "Sleepy", "headTap": "TapHead", "annoyed": "Shake", "startle": "Flick" } }
  ```
  动作名：`lookAround tilt stretch hum yawn nod wake startle poke headTap pat sleepPat annoyed dizzy landed`。睡着时换成「疲惫」的表情（`tired`）。
- **网格立绘：** 和 Live2D 用同一套参数曲线。
- **差分立绘、头像：** 用整张图的歪头、下沉、挤压、抖动演同样的动作；睡着时换 `portrait.tired.png`（没画就不换，只靠歪头下沉和 z）；头像睡着时角标换成 😪。

头顶的小符号（💢 💫 💕 ♪ ❗ 和睡着时的 z）所有形象都有。

## 情绪从哪里来

和侧栏差分立绘共用 `modules/emotion`：桌宠打开期间，发给这个 Agent 的请求会在 system prompt 末尾加一段说明（侧栏已经加过、或角色提示词里自己写了就不重复），请模型在回复里写 `<!--emo:happy 0.8-->` 这样的标记。标记会从聊天显示里剥掉。

模型没写标记时，会按回复文字用规则推测一个情绪，桌宠角标上会注明「推测」。桌宠关着时，请求不会多加任何东西。

还没做：TTS 口型同步（现在回复流出时是假口型）。

## 文件

- `modules/ipc/deskPetHandlers.js`：主进程部分，负责窗口、`vcp-deskpet://` 资源协议、提示词注入、把回复流转给桌宠、桌宠发言转给主窗口、右键菜单。
- `modules/emotion/`：情绪标签、规则兜底、情绪导演和差分挑图（与侧栏立绘共用）。
- `DeskPetmodules/`：桌宠页面，后端依次是 Live2D、网格立绘（`puppet.js`）、差分立绘、头像；气泡和输入框（`bubbleText.js` 把回复整理成气泡里的纯文字）。
- `DeskPetmodules/petLife.js`：闲时的时机（小动作、视线游走、犯困、睡着、醒来、连点、摸头）；`lifeMotion.js`：把阶段和动作变成参数曲线、拖动摆动和跳起高度。
- `vendor/live2d/`：untitled-pixi-live2d-engine 1.4.0（MIT）。
