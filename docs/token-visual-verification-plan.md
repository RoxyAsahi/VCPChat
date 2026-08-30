# Token 视觉验证计划 - 2026-08-24

## 目标

验证 VCPChat 的 CSS token 系统是否在视觉上等价于 DeepSeek Harness 的设计系统。

## 验证环境

**两个并排运行的应用:**
1. DeepSeek Harness: `http://localhost:5173` (或类似端口)
2. VCPChat: `http://localhost:7281` (或类似端口)

## 验证方法

### 步骤 1: 打开设置面板

**Harness**: 点击左侧边栏底部的设置按钮
**VCPChat**: 点击底部设置按钮

### 步骤 2: 浏览器开发者工具检查

打开两个应用的 DevTools，使用 Elements 面板的 Computed 选项卡。

## 关键检查点

### 1. Panel Background (面板背景)

**Harness 检查:**
```javascript
// 在 Harness DevTools Console
const panel = document.querySelector('[class*="panel"]')
const bg = getComputedStyle(panel).backgroundColor
console.log('Harness panel background:', bg)
// 预期: 深色模式下应该是 elevated surface，不是纯黑
```

**VCPChat 检查:**
```javascript
// 在 VCPChat DevTools Console
const panel = document.querySelector('.vcp-harness-settings-panel')
const bg = getComputedStyle(panel).backgroundColor
console.log('VCPChat panel background:', bg)
// 当前: var(--vcp-ui-bg-1) = oklch(0.18 0.015 230 / 0.92)
```

**验证标准:**
- 两者的 RGB 值应该视觉上接近
- 不应该一个是纯黑一个是灰色
- L=18% 的 oklch 应该对应 Harness 的 layer-2 elevation

### 2. Nav Cell Active Background (激活状态背景)

**Harness 检查:**
```javascript
// 点击第一个导航项使其 active
const activeCell = document.querySelector('[class*="navCell"][class*="active"]')
const activeBg = getComputedStyle(activeCell).backgroundColor
console.log('Harness active background:', activeBg)
// 预期: #EBEEF2 或类似，RGB 约 (235, 238, 242)
```

**VCPChat 检查:**
```javascript
const activeCell = document.querySelector('.vcp-harness-settings-nav-cell.active')
const activeBg = getComputedStyle(activeCell).backgroundColor
console.log('VCPChat active background:', activeBg)
// 当前: var(--vcp-ui-fill-2) = 12% white mix
```

**验证标准:**
- **关键差异**: Harness 使用固定颜色 #EBEEF2 (L≈94%)
- VCPChat 使用 12% white on L=18% background ≈ L=30%
- 这是 **64 个亮度单位的差距** (94 vs 30)!

**可能的问题**: VCPChat 的 active state 可能比 Harness 暗得多！

### 3. Nav Cell Hover Background (悬停状态背景)

**Harness 检查:**
```javascript
// 悬停在非 active 的导航项上
const hoveredCell = document.querySelector('[class*="navCell"]:hover')
const hoverBg = getComputedStyle(hoveredCell).backgroundColor
console.log('Harness hover background:', hoverBg)
```

**VCPChat 检查:**
```javascript
// 同样悬停
const hoveredCell = document.querySelector('.vcp-harness-settings-nav-cell:hover')
const hoverBg = getComputedStyle(hoveredCell).backgroundColor
console.log('VCPChat hover background:', hoverBg)
// 当前: var(--vcp-ui-fill-0) = 5% white mix
```

### 4. Panel Shadow (面板阴影)

**Harness 检查:**
```javascript
const panel = document.querySelector('[class*="panel"]')
const shadow = getComputedStyle(panel).boxShadow
console.log('Harness shadow:', shadow)
// 预期: 类似 "0px 8px 24px rgba(0, 0, 0, 0.15)"
```

**VCPChat 检查:**
```javascript
const panel = document.querySelector('.vcp-harness-settings-panel')
const shadow = getComputedStyle(panel).boxShadow
console.log('VCPChat shadow:', shadow)
// 当前: var(--vcp-ui-shadow-lg) = 0 16px 48px oklch(0 0 0 / 0.42)
```

**验证标准:**
- 阴影的 spread 和 opacity 应该视觉上相似
- VCPChat 的 shadow-lg (16px 48px) 可能比 Harness 的 lv3 (8px 24px) 更强

### 5. Text Color (文本颜色)

**Harness 检查:**
```javascript
const navLabel = document.querySelector('[class*="navLabel"]')
const textColor = getComputedStyle(navLabel).color
console.log('Harness text color:', textColor)
// 预期: --dsw-alias-label-primary
```

**VCPChat 检查:**
```javascript
const navLabel = document.querySelector('.vcp-harness-settings-nav-copy')
const textColor = getComputedStyle(navLabel).color
console.log('VCPChat text color:', textColor)
// 当前: var(--vcp-ui-text-0) = oklch(0.96 0.008 230) ≈ L=96%
```

## 截图对比

### 暗色模式对比

**操作:**
1. 确保两个应用都在暗色模式
2. 打开设置面板
3. 截图整个面板
4. 并排放置对比

**重点观察:**
- 面板背景的明暗程度
- active 导航项的明显程度
- hover 时的反馈清晰度
- 阴影的深度和扩散

### 亮色模式对比

**操作:**
1. 切换到亮色模式
2. 重复上述截图
3. 检查对比度是否足够

## RGB 颜色转换表

### Harness 关键颜色 (Light Mode)

| Token | 值 | RGB | L* |
|-------|-----|-----|-----|
| `--dsw-specific-sidebar-nav-item-active` | #EBEEF2 | rgb(235, 238, 242) | ~94% |
| `--dsw-alias-bg-layer-2` | #FFFFFF | rgb(255, 255, 255) | 100% |
| `--dsw-alias-label-primary` | #1C2024 | rgb(28, 32, 36) | ~10% |

### VCPChat 关键颜色 (Dark Mode)

| Token | 计算值 | 近似 RGB | L* |
|-------|--------|----------|-----|
| `--vcp-ui-bg-1` | oklch(0.18 0.015 230 / 0.92) | rgb(~38, ~40, ~50) | 18% |
| `--vcp-ui-fill-2` | 12% white on bg-1 | rgb(~53, ~56, ~68) | ~30% |
| `--vcp-ui-text-0` | oklch(0.96 0.008 230) | rgb(~240, ~243, ~248) | 96% |

### 重要发现

⚠️ **Active State 亮度差距巨大:**
- Harness active (light): L=94% (接近白色)
- VCPChat active (dark): L=30% (深灰色)

这意味着即使结构完全相同，**视觉效果会完全不同**！

## 修复建议

### 方案 1: 提升 Active State 亮度

在 `styles/ui-system/tokens.css` 中定义专用 token:

```css
/* 在暗色模式下 */
--vcp-ui-nav-active: oklch(0.40 0.015 230); /* 提升到 L=40% */

/* 或者更激进 */
--vcp-ui-nav-active: oklch(0.50 0.015 230); /* L=50%，更接近 Harness */
```

然后在 `settings.css` 中使用:
```css
.vcp-harness-settings-nav-cell.active {
    background: var(--vcp-ui-nav-active);
    font-weight: 500;
}
```

### 方案 2: 使用 Harness 的固定颜色

直接使用与 Harness 相同的颜色值（暂时牺牲 token 系统的灵活性）:

```css
.vcp-harness-settings-nav-cell.active {
    background: oklch(0.94 0.008 230); /* 直接对应 #EBEEF2 */
    font-weight: 500;
}
```

### 方案 3: 同时提升 Panel 和 Active 亮度

如果 panel 背景太暗导致 active state 不明显，可以提升整体亮度层级：

```css
/* Panel 从 bg-1 (L=18%) 提升到 bg-2 (L=25%) */
.vcp-harness-settings-panel {
    background: var(--vcp-ui-bg-2);
}

/* Active 使用更高的 fill level */
.vcp-harness-settings-nav-cell.active {
    background: var(--vcp-ui-fill-3); /* 如果有的话 */
}
```

## 验证清单

完成后，用户应该确认:

- [ ] Panel 背景的明亮度与 Harness 视觉接近
- [ ] Active 导航项一眼就能看出是哪个
- [ ] Hover 反馈明显但不喧宾夺主
- [ ] 阴影深度给予足够的浮起感
- [ ] 文本对比度清晰易读
- [ ] 切换主题时（如果支持）所有状态都正常
- [ ] 不同浏览器（Chrome/Firefox/Edge）表现一致

## 测试脚本

**保存为 `verify-tokens.js` 并在两个应用的 console 中运行:**

```javascript
// Token 验证脚本
function verifySettingsTokens() {
    const panel = document.querySelector('[class*="panel"], .vcp-harness-settings-panel')
    const activeCell = document.querySelector('[class*="active"], .active')

    if (!panel || !activeCell) {
        console.error('找不到设置面板或激活的导航项')
        return
    }

    const panelBg = getComputedStyle(panel).backgroundColor
    const activeBg = getComputedStyle(activeCell).backgroundColor
    const shadow = getComputedStyle(panel).boxShadow

    console.log('=== Settings Panel Tokens ===')
    console.log('Panel Background:', panelBg)
    console.log('Active Cell Background:', activeBg)
    console.log('Panel Shadow:', shadow)

    // 转换为 RGB 方便对比
    const rgbPanel = panelBg.match(/\d+/g)?.map(Number)
    const rgbActive = activeBg.match(/\d+/g)?.map(Number)

    console.log('Panel RGB:', rgbPanel)
    console.log('Active RGB:', rgbActive)

    // 简单的亮度估算 (相对亮度)
    if (rgbPanel && rgbActive) {
        const panelLuminance = (rgbPanel[0] + rgbPanel[1] + rgbPanel[2]) / 3
        const activeLuminance = (rgbActive[0] + rgbActive[1] + rgbActive[2]) / 3
        console.log('Panel 平均亮度:', panelLuminance.toFixed(1))
        console.log('Active 平均亮度:', activeLuminance.toFixed(1))
        console.log('对比度:', (activeLuminance / panelLuminance).toFixed(2))
    }
}

verifySettingsTokens()
```

## 下一步

1. 等待两个应用启动完成
2. 在浏览器中打开设置面板
3. 运行验证脚本
4. 根据结果决定是否需要调整 token 值
5. 如果需要修复，实施上述方案之一
