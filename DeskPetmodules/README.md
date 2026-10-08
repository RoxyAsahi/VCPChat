# 桌宠（试验功能）

在聊天头部点爪印按钮，就会把当前 Agent 放到桌面上：透明、无边框、置顶，只有角色本身可以点，空白处鼠标直接穿透到下面的窗口。Agent 回复时桌宠会跟着换表情，思考和调用工具时显示专注状态。

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
3. **表情映射（可选）。** 在模型文件夹里放一个 `deskpet.json`，指定每种情绪用哪个表情和动作：
   ```json
   {
     "expressions": { "calm": "exp_01", "happy": "exp_02", "sleepy": "exp_03", "sad": "exp_05",
                      "shy": "exp_06", "surprised": "exp_07", "annoyed": "exp_08", "focused": "exp_01" },
     "motions": { "happy": "TapBody" }
   }
   ```
   上面这份就是 Mao 的映射。不写这个文件时，会按表情名去猜（含 smile、angry 之类的词）。

本项目不附带任何 Live2D 文件（Core 和模型都受 Live2D 的许可约束），需要自己下载。

### 2. 或者放差分立绘（可选）

没有 Live2D 模型时，桌宠会使用立绘，命名规则和侧栏首页立绘一样：

```
AppData\Agents\<AgentId>\portrait.png           默认立绘
AppData\Agents\<AgentId>\portrait.happy.png     各情绪的差分
```

情绪有 8 种：`calm focused happy shy surprised sleepy sad annoyed`。缺哪张就退回相近的，最后退回默认立绘。透明背景的 PNG 或 WebP 效果最好，点击只命中不透明的像素。

### 3. 打开和关闭

- **打开或收起：** 选中一个 Agent，点聊天头部的爪印按钮。按钮高亮表示这个 Agent 的桌宠开着。
- **移动：** 按住角色拖动，位置会记住。
- **关闭：** 右键角色选「关闭桌宠」，或者再点一次爪印按钮。桌宠不在任务栏里，也拿不到焦点，所以 Alt+F4 关不掉它。
- 关掉主窗口时，所有桌宠一起关闭。

## 情绪从哪里来

桌宠打开期间，发给这个 Agent 的请求会在 system prompt 末尾加一段说明，请模型在回复里写 `<!--emo:happy 0.8-->` 这样的标记。标记会从聊天显示里剥掉，只给桌宠用。

模型没写标记时，会按回复文字用规则推测一个情绪，桌宠角标上会注明「推测」。桌宠关着时，请求不会多加任何东西。

## 文件

- `modules/ipc/deskPetHandlers.js`：主进程部分，负责窗口、`vcp-deskpet://` 资源协议、提示词注入和流事件。
- `modules/deskpet/`：标签解析（emoTags）、情绪导演（petDirector）和规则分类器。
- `DeskPetmodules/`：桌宠页面，后端依次是 Live2D、立绘、头像。
- `vendor/live2d/`：untitled-pixi-live2d-engine 1.4.0（MIT）。
