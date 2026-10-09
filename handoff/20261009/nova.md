# Nova Live2D 交接（2026-10-09）

> 原件在 Roxy 电脑：C:\Users\CHENXI\Documents\Codex\HANDOFF-nova-20261009.md。补充：#63 QA 第三轮已通过（N1-N3 确认修好），已交给 #34 合并；#34 head 418fc36b。

## 1. 路径

| 用途 | 路径 |
|---|---|
| 工作根目录 | `C:\Users\CHENXI\Documents\Codex\nova-live2d\fullbody\` |
| 源素材（Codex 拆层 PNG / PSD） | `nova-live2d\fullbody\v2-src\`：`NovaMaid-Parts`、`正常比例女仆修正版`、`NovaTech` 等 |
| Codex 原始交付（**只读**，不能改） | `C:\Users\CHENXI\Documents\Codex\2026-10-08\wo\`，其中 `outputs\` 下有 `NovaChibi-Parts`、`NovaMaid-Parts`、`NovaTech`，以及几个 zip |
| 各服装的 PSD2Live 工作目录 | `fullbody\work-v2\{chibi,tech,maid}\` |
| PR 工作树（VCPChat） | `C:\Users\CHENXI\Documents\Codex\2026-10-09\nova-builtin-v2`；模型资源在 `assets\deskpet\nova\{chibi,tech,maid}\` |
| PSD2Live（源码 + GUI，Kotlin/Java） | `nova-live2d\psd2live\`（gradle 运行 `io.github.psd2live.MainKt`）<br>MCP 代理是 `nova-live2d\psd2live\mcp_proxy.py`，token 从 Java prefs 读取 |
| Python venv | `nova-live2d\venv\Scripts\python.exe`（运行时加 `-I`） |
| 测试用桌宠 | `C:\Users\CHENXI\Documents\Codex\deskpet-demo`（电子应用）<br>数据目录：`deskpet-demo-appdata` |
| Cubism Core | `deskpet-demo-appdata\deskpet\live2dcubismcore.min.js`（**不能提交**） |
| **禁止触碰** | `daily-deskpet`，以及 `2026-10-02\audit-state\appdata-real`（日常桌宠正在用它运行） |
| 草稿目录 | `C:\Users\CHENXI\AppData\Local\Temp\claude\C--Users-CHENXI-Documents-Codex\ca8e633e-9059-40e6-bd60-9430ed554d7a\scratchpad\`<br>里面有 `cdp\`（截图脚本）和 `modelwt\`（模型分支的工作树）<br>脚本已经复制进模型分支的 `fullbody/tools/cdp` 和 `fullbody/tools/helpers` |

### PSD2Live 工程文件

- **Q 版**：`work-v2\chibi\chibi_final7.psd2live`，是最终版，对应 #63 的 cb31a8b4。导出在 `work-v2\chibi\export\`。
- **科技服**：目前**没有保存 .psd2live**。
  - 工程是从 `work-v2\tech\nova_tech.psd` 导入的。这个 PSD 是 `tools/build_tech_hd.py` 生成的 1024×1536 高清重建版，26 层，层名和 Codex 的一致。
  - 导出在 `work-v2\tech\export\nova_tech.*`。
  - 状态记录：`work-v2\tech\_state.json`（project c84d2ab5-09ec-41ed-a873-06e58aa686e6）。
  - 没有手工 keyform 修改，重新导入就能完全复现（见第 5 节）。
- **女仆**：只有 `work-v2\maid\nova_maid.psd` 和 `layer_plan.json`，还没做过 PSD2Live。

## 2. 分支和 sha（远端 fork = github.com/RoxyAsahi/VCPChat）

- **#63** `claude/nova-chibi-v2` @ **cb31a8b48**
  - 内容：Q 版，含 N1–N3 修复。base 是 `claude/project-thread-njw5ge`。
  - **禁止 force-push。**
- **`claude/nova-psd2live-model`** @ **49e5fc288**
  - 内容：工具、验收截图、修改前后对比图。
  - `builtin-v2/shots/chibi/...` 下有 Q 版的验收图和 before_after。
  - 新增：
    - `builtin-v2/shots/tech/before/`：科技服修改前的基线，64 帧中的关键帧和全部 sheet；
    - `builtin-v2/work/tech/`：导入状态和导出的 json；
    - `fullbody/tools/helpers`、`fullbody/tools/cdp`。
  - 本地工作树：scratchpad 下的 `modelwt`，分支 `claude/nova-psd2live-model-local`。
- **新 WIP 分支** `claude/nova-tech-maid-wip` @ **c09e10e9d**（已推送到 fork，从 cb31a8b48 分出）
  - 只提交了高清科技服的 `NovaTech.moc3` 和 `texture_00.png`。
  - **D 项还一个都没修**，也还没开 PR。
- 规则：
  - 不能推到 `pr/side-pane-workbench`。
  - 一律新开分支，开 draft PR。
  - PR 正文开头要有 attribution 块，结尾要有 Claude Code 标记。
  - 开完 PR 后把 RoxyAsahi 设为 assignee 和 reviewer。

## 3. 已完成

**Q 版（#63）**
- 11 个表情、8 个手势。
- 已修复：D2、D3（Q 版）、D12、D13、D14。
- review 修复 N1、N2、N3：
  - **N1/N2**：每个表情下都能正常口型同步和眨眼。
    - 表情嘴在 MouthOpenY 0.1→0.3 之间淡出，同时中性的说话嘴淡入。
    - 眼白在 EyeOpen 0.45→0.3 之间淡出，睫毛保持眼皮的弧线。
    - 用的脚本是 `tools/p2l_expr_eyes_mouth.py`。
  - **N3**：后发两侧不再做 alpha 渐变，保持完全不透明，见 `tools/fix_chibi_backhair.py`。
- **N4 按设计保留为瞬切**：交叉淡化会出现双手臂，已写进 README 的已知问题。
- 测试：deskpet 的 asset/outfit/builtin 测试 21/21 通过。

**科技服**
- 已完成高清重建（`build_tech_hd.py`），并做了 RGB bleed 防止白边。
- 修改前的基线验收截图已拍好。

## 4. 剩余工作

### 科技服 / 女仆 PR

**D1 闭眼（科技服、女仆）**
- 现象：上下睫毛呈 V 形，中间露出一条蓝色虹膜。
- 要求：EyeOpen=0 时，眼皮皮肤加睫毛弧线完全盖住虹膜和眼白。
- 做法参照 Q 版：
  - `tools/p2l_closed_lid.py`：把 EyeOpen 0.3 时的睫毛形状 copy 到 0，眼白在 0.45→0.3 之间淡出。
  - 科技服和女仆可能还需要单独加一层眼皮肤色。
- 女仆还有一个问题：锯齿状的皮肤眼皮画在刘海上面，要把它的绘制顺序调到刘海下面（参照 `p2l_hair_order.py`）。

**D3 后发随 AngleZ 刚性旋转（三套都有）**
- 现象：头发离开肩膀；女仆的发丝后面露出灰紫色的 inpaint 残留。
- 做法二选一：
  - 后发根部跟头走、发梢跟身体走（拆 deformer 或加权 warp）；
  - 或者降低后发对 AngleZ 的耦合。
- 同时把 inpaint 区域清理掉。参照 Q 版 `fix_chibi_backhair.py` 的填色思路。

**D4 眼球超出眼白（科技服、女仆）**
- 现象：EyeBallY ±1 时虹膜超出眼白 2–4px。
- 做法：做 iris→eyewhite 的 clipping mask，或者缩小 EyeBall 的范围。

**D5 张嘴是六边形色块（科技服）**
- 现象：MouthOpenY≥0.5 时，张开的嘴是一块硬边的六边形唇色。

**D6 白黑噪点（女仆）**
- 现象：眼睛、睫毛、刘海、耳环周围有白黑噪点；张嘴时嘴周围有一圈浅色圆角框的残影。

**D7 白边（科技服）**
- 现象：下巴有浅色轮廓线；睫毛 mesh 带着一块肤色矩形，压在刘海上形成硬边。

**D8 表情区分度（科技服、女仆）**
- 现象：Angry/Sad/Happy 几乎一样（眉毛被刘海挡住，MouthForm 变化很小）。
- Shy.exp3 用了 ParamCheek，但模型里没有这个参数。
- 应用还会驱动 ParamEyeLSmile/RSmile、ParamCheek、ParamBrowLAngle/RAngle，三套模型都没有。
- 要做的：
  - 加上这些参数：笑眼变形、腮红叠加层开关、眉毛角度；
  - 让各表情明显不同。

**其他**
- 女仆下巴修正。
- 科技服要锐利，但不能有白边。高清重建已经做了，还要验证 D7。

### 低优先级（Q 版）
- **D9**：视线。
- **D10**：身体角度。
- **D11**：鞋子接缝。
- （QA 第三轮新增的低项 N5、N6 见 /mnt/project-files/deskpet/nova-qa/defects.md「第 3 轮」。）

### 收尾
- 恢复 deskpet-demo 的资源：

  ```bash
  git -C deskpet-demo checkout -- assets/deskpet/nova
  ```

  目前 deskpet-demo 里 chibi 是修改状态，tech 已经恢复到 HEAD。
- 删除 `deskpet-demo` 里未跟踪的 `outfit_switch.mjs`。
- 只停掉 deskpet-demo 的 electron，不要动 daily-deskpet。
- 删除 scratchpad 下的 `modelwt` 工作树。

## 5. 科技服 / 女仆做到哪了

- WIP 分支已有高清科技服的 moc3 和贴图。注意：export 里的 physics3/cdi3 和已提交的版本可能不同，最终 PR 要从 `work-v2\tech\export` 一起复制。
- 修改前基线已拍：
  - 截图在 scratchpad 的 `before_tech\`，也在模型分支的 `builtin-v2/shots/tech/before/`；
  - 关注帧：
    - D1：`p_eyes_closed`；
    - D4：`p_eyeball_ul` / `p_eyeball_dr`；
    - D5：`m_open0.5_form0` / `m_open1_form0`；
    - D3：`p_angZ_m` / `p_angZ_p`；
    - D8：`e_*`。
- 女仆的基线还没拍。
- PSD2Live 当前打开的是 Q 版工程（已保存）。下一步：
  1. 重新导入科技服工程；
  2. 先保存成 `work-v2\tech\tech_hd.psd2live`；
  3. 从 D1 开始修。

## 6. 构建和导出步骤

前提：PSD2Live GUI 已经在运行（MCP 端点由 `mcp_proxy.py` 自动发现）。所有 Python 命令都用 `venv\Scripts\python.exe -I`，在 `fullbody\` 目录下执行。

**1. 重建高清 PSD（只有科技服需要）**

```bash
python -I tools/build_tech_hd.py <wo/outputs/NovaTech-Parts> <Codex NovaTech.psd> work-v2/tech/nova_tech.psd
```

**2. 导入、分类、导出**

```bash
python -I tools/p2l_v2.py work-v2/<variant> work-v2/<variant>/export [preset ...]
```

- 它会调用 `project_import_psd`，并把 atlas 设成 2048。
- `layer_plan.json` 决定每层的 role/side/type/parameter/switch_id。
- 最后导出 `nova_<variant>.*`。

**3. 打开已有工程**

```bash
python -I tools/p2l_open.py <file.psd2live>
```

**4. 保存并导出**

```bash
python -I tools/p2l_save_export.py <save.psd2live> <export dir>
```

**5. 修改 keyform**

接口：`from p2l_mcp import Client; from p2l_v2 import run`，调用方式是 `run(c, 'keyform_apply', {'changes': [...]}, pid, state)`，返回新的 state。

change 的四种 op：
- `{'op':'set','target':'mesh:X','key':{param:val,...},'channels':{'opacity':v}}`：支持多维 key；
- `{'op':'seed','target':..,'key':{..}}`：先建出一个 key 点；
- `{'op':'copy','target':..,'from':{..},'key':{..}}`：把一个 key 的形状复制到另一个 key；
- `{'op':'delete','target':..,'parameter':p,'channel':'opacity'}`。

注意事项：
- 每批最多 64 个 change。
- 查询对象：

  ```python
  c.call('workspace_inspect', {'scope':'objects','target':'mesh:X'})
  ```

  返回 axes、forms、channels。
- 列表查询用 `scope objects/layers`，`limit` 不超过 64，并配合 `offset` 翻页。
- 写好的例子：`p2l_closed_lid.py`、`p2l_expr_eyes_mouth.py`、`p2l_mouth_hide.py`、`p2l_hair_order.py`、`p2l_sleepy_lid.py`、`p2l_cloth.py`。

**6. 后处理**

- **Q 版**：

  ```bash
  python -I tools/finalize_chibi_v2.py work-v2/chibi/export <worktree>/assets/deskpet/nova/chibi
  ```

  它负责表情、手势、deskpet.json。然后再跑：

  ```bash
  python -I tools/fix_chibi_backhair.py <...>/NovaChibi.2048/texture_00.png
  ```

  完整流程见 `fullbody/tools/helpers/deploy_chibi.sh`。
- **科技服 / 女仆**：
  - 把 export 里的 moc3、physics3、cdi3、texture 复制到 `assets/deskpet/nova/<outfit>/`，文件名用 `NovaTech.*` / `NovaMaid.*`。
  - `finalize_outfits.py` 会给 `_y` 摆动加上 ParamBreath 输入。

**7. 验收截图**

1. 把资源复制到 `deskpet-demo\assets\deskpet\nova\<outfit>\`。
2. 启动 demo：

   ```powershell
   Start-Process deskpet-demo\node_modules\electron\dist\electron.exe -ArgumentList '.','--remote-debugging-port=9377' -WorkingDirectory deskpet-demo
   ```

3. 切换服装。在 scratchpad 的 `cdp\` 目录下执行：

   ```bash
   node cdp.mjs 9377 "桌宠设置" -e "deskPetSettingsAPI.setOutfit('_Agent_1760530265093_1760530265093','builtin:nova-tech')"
   ```

   可选值：`builtin:nova-chibi` / `builtin:nova-tech` / `builtin:nova-maid`。要重新加载同一套服装，先切到别的服装再切回来。
4. 拍图：

   ```bash
   node accept.mjs <outDir>
   ```

   会拍 64 帧：头部角度、眼、嘴、表情加张嘴、手势、物理。参数在 afterMotionUpdate 里锁定。
5. 生成 sheet 和特写：

   ```bash
   python -I sheet2.py <outDir> 0.55 0.5 0.85
   ```

6. 局部放大：

   ```bash
   python face.py <dir> <out.png> x0 y0 x1 y1 scale names...
   ```

   截图带 alpha，会合成到绿底上，方便看透明漏洞。
7. 跑测试（在 PR 工作树里）：

   ```bash
   NODE_PATH=C:/Users/CHENXI/Documents/Codex/deskpet-demo/node_modules node --test tests/deskpet-assets.test.mjs tests/deskpet-builtin-nova.test.mjs tests/deskpet-outfits.test.mjs tests/deskpet-expression-map.test.mjs
   ```

8. 每次推送都要在模型分支的 `builtin-v2/shots/<outfit>/` 下附上修改前后对比图，并列出修了哪些 D 项。
