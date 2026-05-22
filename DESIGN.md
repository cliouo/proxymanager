---
version: alpha
name: Heritage Atelier
description: |
  ProxyManager 的视觉身份 —— 温润书卷气工作台。暖米白纸张感配陶土
  点缀，Fraunces serif 担纲标题，Inter 处理高密度正文。像一份用心
  排版的内部技术手册，而非冷冰冰的 SaaS 控制台。

colors:
  # —— 暖白表面四档（按色阶提升一档作为分层，非墨线分隔） ——
  bg: '#FAF9F5'                # 主背景：纸张暖米白
  bg-sunk: '#F2F0E8'           # 下沉背景：sidebar、空状态、表格 hover
  bg-strong: '#E8E0D2'         # 强调暖米：选中 band、当前 tab、置顶区
  surface: '#FFFFFF'           # 卡面纯白
  surface-hover: '#FBFAF6'     # 卡面 hover 偏移
  border: '#E8E5DC'            # 暖灰发丝（= 色阶一档高光，非墨线）
  border-strong: '#D4CFC2'     # 强分隔暖灰
  border-active: '#C8553D'     # 焦点/选中边框：陶土红

  # —— Dark micro-surface（仅小范围使用：代码块/URL/YAML 预览） ——
  surface-dark: '#1F1E1B'      # 深棕墨：内联代码块、URL 复制框
  surface-dark-soft: '#2A2823' # 内嵌代码块的次级 dark

  # —— 前景层级（6 档） ——
  ink: '#141413'               # 最强对比墨：仅 H1 与品牌字
  fg: '#1F1E1B'                # 标题与关键正文
  fg-soft: '#423F39'           # 常规正文
  muted: '#6B6862'             # 辅助说明、时间戳、metadata
  muted-strong: '#8B867D'      # 占位、禁用文字
  on-primary: '#FFFFFF'        # 陶土按钮上的文字
  on-dark: '#FAF9F5'           # dark 微表面上的正文（米白，呼应 bg）
  on-dark-soft: '#A09D96'      # dark 微表面上的辅助文字、行号

  # —— 互动主轴 ——
  primary: '#C8553D'           # 陶土红：主按钮、外链、焦点
  primary-hover: '#B14A33'     # 陶土红按下/hover
  primary-soft: '#F4DCD3'      # 陶土红浅底：选中行、tag 背景
  primary-tint: '#FBF1EC'      # 极淡陶土：hover row、ring 外晕

  # —— 语义副色 ——
  plum: '#6B4B5C'              # 梅子：信息辅助、已撤销标记
  success: '#6F8B5C'           # 苔藓绿：启用、成功
  warn: '#B98947'              # 暖琥珀：警告、未保存
  danger: '#A8412E'            # 深红：破坏性操作

  # —— 状态点 ——
  dot-on: '#6F8B5C'
  dot-warn: '#B98947'
  dot-off: '#B8B3A7'
  dot-error: '#A8412E'

typography:
  # —— Serif 展示（记忆点 · letter-spacing 不可妥协） ——
  display:
    fontFamily: Fraunces
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.02em
    fontVariation: '"opsz" 144, "SOFT" 30'
  headline-lg:
    fontFamily: Fraunces
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: -0.015em
    fontVariation: '"opsz" 96, "SOFT" 30'
  headline-md:
    fontFamily: Fraunces
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: -0.01em
    fontVariation: '"opsz" 48, "SOFT" 50'

  # —— Sans 正文 ——
  title-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0.005em
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.08em
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: '"liga" 0'
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: '"liga" 0'

rounded:
  none: 0px
  sm: 4px      # Badge、状态点、tag
  md: 8px      # Input、次按钮、内联 URL 框
  lg: 12px     # 卡片、对话框、代码块
  xl: 16px     # 容器化大区块
  full: 9999px # 主按钮 pill

spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  '2xl': 32px
  '3xl': 48px
  '4xl': 72px
  gutter: 24px
  page-pad: 32px
  sidebar-w: 240px
  content-max: 1200px

components:
  # —— 按钮 ——
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    typography: '{typography.label-md}'
    rounded: '{rounded.full}'
    padding: '0 16px'
    height: 36px
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-primary-pressed:
    backgroundColor: '{colors.primary-hover}'

  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.fg}'
    typography: '{typography.label-md}'
    rounded: '{rounded.md}'
    padding: '0 14px'
    height: 36px
  button-secondary-hover:
    backgroundColor: '{colors.surface-hover}'

  button-ghost:
    backgroundColor: 'transparent'
    textColor: '{colors.muted}'
    typography: '{typography.label-md}'
    rounded: '{rounded.md}'
    padding: '0 10px'
    height: 32px
  button-ghost-hover:
    backgroundColor: '{colors.bg-sunk}'
    textColor: '{colors.fg}'

  button-danger:
    backgroundColor: 'transparent'
    textColor: '{colors.danger}'
    typography: '{typography.label-md}'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: 32px

  # —— 输入 ——
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.fg}'
    typography: '{typography.body-md}'
    rounded: '{rounded.md}'
    padding: '0 12px'
    height: 36px
  input-focus:
    backgroundColor: '{colors.surface}'

  # —— Surface（卡面）——
  # 注：本设计不提供「Card」原子组件。每页根据自己的信息架构组合
  # surface + border + shadow-card 自由布局。重复样式见下方 surface-* token。
  surface-elevated:
    backgroundColor: '{colors.surface}'
    borderColor: '{colors.border}'
    rounded: '{rounded.lg}'
    shadow: '0 1px 2px 0 rgba(20,20,19,0.04)'
  surface-emphasized:
    backgroundColor: '{colors.bg-strong}'
    rounded: '{rounded.lg}'
  surface-dossier-strip:
    backgroundColor: '{colors.bg-sunk}'
    width: 96px

  # —— Badge ——
  badge-neutral:
    backgroundColor: '{colors.bg-sunk}'
    textColor: '{colors.fg-soft}'
    typography: '{typography.label-md}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
  badge-accent:
    backgroundColor: '{colors.primary-soft}'
    textColor: '{colors.primary-hover}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
  badge-success:
    backgroundColor: '#E6EEDD'
    textColor: '{colors.success}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
  badge-warn:
    backgroundColor: '#F5E5C9'
    textColor: '{colors.warn}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'
  badge-danger:
    backgroundColor: '#F4D8D2'
    textColor: '{colors.danger}'
    rounded: '{rounded.sm}'
    padding: '2px 8px'

  # —— Sidebar ——
  sidebar:
    backgroundColor: '{colors.bg-sunk}'
    width: 240px
  sidebar-link:
    backgroundColor: 'transparent'
    textColor: '{colors.fg-soft}'
    typography: '{typography.body-md}'
    rounded: '{rounded.md}'
    padding: '6px 10px'
  sidebar-link-active:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.fg}'
  sidebar-link-hover:
    backgroundColor: '{colors.surface}'

  # —— 表格行 ——
  table-row:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.fg-soft}'
    typography: '{typography.body-sm}'
  table-row-hover:
    backgroundColor: '{colors.bg-sunk}'
  table-row-selected:
    backgroundColor: '{colors.primary-tint}'

  # —— Dark micro-surface（小处使用 dark） ——
  yaml-editor:
    # CodeMirror 6 单元；主题继承 Heritage Atelier。光标陶土红，
    # 当前行高亮 primary-tint，行号 gutter 用 bg-sunk + muted。
    backgroundColor: '{colors.surface}'
    gutterBg: '{colors.bg-sunk}'
    gutterFg: '{colors.muted}'
    caretColor: '{colors.primary}'
    activeLineBg: '{colors.primary-tint}'
    typography: '{typography.mono-md}'
  shiki-block:
    # 渲染只读高亮代码（YAML / JSON / bash）。Shiki + github-dark-default
    # 主题铺在 dark micro-surface 上。
    backgroundColor: '{colors.surface-dark}'
    backgroundColorInline: '{colors.surface-dark-soft}'
    textColor: '{colors.on-dark}'
    typography: '{typography.mono-md}'
    rounded: '{rounded.lg}'
    padding: 16px
  inline-url:
    backgroundColor: '{colors.surface-dark}'
    textColor: '{colors.on-dark}'
    typography: '{typography.mono-md}'
    rounded: '{rounded.md}'
    padding: '8px 12px'

  # —— 数据可视化原子 ——
  traffic-bar:
    height: 6px
    rounded: '{rounded.full}'
    trackColor: '{colors.bg-strong}'
    uploadColor: '{colors.plum}'
    downloadColor: '{colors.primary}'
  timeline-axis:
    width: 1px
    color: '{colors.border}'
    markerSize: 14px
  chain-node-front:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.fg}'
    borderColor: '{colors.border-strong}'
    rounded: '{rounded.md}'
    height: 28px
  chain-node-chain:
    backgroundColor: '{colors.primary-soft}'
    textColor: '{colors.primary-hover}'
    rounded: '{rounded.md}'
    height: 28px
  chain-node-backend:
    backgroundColor: '{colors.bg-strong}'
    textColor: '{colors.fg}'
    rounded: '{rounded.md}'
    height: 28px

  # —— 状态点（签名细节） ——
  status-dot:
    size: 6px
    rounded: '{rounded.full}'

  # —— 键盘提示 ——
  kbd:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.muted}'
    typography: '{typography.mono-sm}'
    rounded: '{rounded.sm}'
    padding: '1px 6px'

  # —— 过渡 / 加载 ——
  reveal:
    duration: 220ms
    timing: ease-out
    property: opacity # 仅 opacity，不用 transform（防亚像素抖动）
  reveal-slow:
    duration: 320ms
    timing: ease-out
    property: opacity
  route-progress:
    height: 2px
    duration: 800ms
    color: 'linear-gradient(90deg, {colors.primary-tint}, {colors.primary}, {colors.primary-hover})'
  placeholder-pulse:
    duration: 1400ms
    timing: ease-in-out
    iteration: infinite
    color: '{colors.bg-strong}'

motion:
  scale-press: 0.98
  scrollbar-gutter: stable    # 全局必须，防滚动条出现/消失推挤居中内容
  reduced-motion: respect     # @media (prefers-reduced-motion) 时所有动画 0ms
---

# ProxyManager · Heritage Atelier

## Overview

**温润书卷气的工作台**。ProxyManager 是个人代理订阅与配置管家 — 一个长时间盯着、偶尔
深度编辑的工具。视觉走的是「印刷品 + 工程师笔记本」的杂交线：暖米白纸张感打底，
正文走 Inter 的低对比阅读节奏，标题用 Fraunces 一记 serif 提味，主操作用陶土红
（Boston Clay 家族色）做唯一锚点。**代码、URL、YAML 这些技术内容用 dark micro-surface
单独承载** — 让"看技术内容"变成纸面上的一小块墨色卡片，有书房感而非控制台感。

它不试图扮成 SaaS 控制台；它扮成一份**用心排版的内部技术手册**。

- **品牌人格**：克制、温润、有手感。偏静态阅读 + 偶发深度操作。
- **目标用户**：单人或个人开发者，长时间在桌面端使用。
- **情绪基调**：纸张温度、墨迹精度、书卷气。绝不"硅谷亮蓝紫"。
- **密度策略**：卡片为主、表格为辅。读多于改。
- **字号优先级**：标题强 hierarchy（serif 抓眼），正文克制（sans 不抢戏）。
- **节奏机制**：暖米白主导 90% 面积 + 陶土点 5% + dark 微表面 5%。三种表面有明确分工，
  不跨页跳变 — 这是工具产品与 marketing 页的本质差别。

记忆点是 **Fraunces serif 标题** — 它是这个产品在视觉上唯一不可替代的部件。

## Colors

色板的根是「**纸张暖白 + 单一陶土点缀 + 小处墨色 dark**」。中性占 90% 屏幕面积，
陶土只出现在主操作 / 当前选中 / 外链 / 焦点环上，dark 仅出现在代码块、URL 复制框、
YAML 预览 — 让每种色块每次出现都"被注意到"。

**边框哲学（核心理念）**：所有边框颜色都是**色阶提升一档的暖灰**，而非墨线。`#E8E5DC`
不是分隔线，是「一档软高光」— 它告诉用户"这一块比下面那块抬起来了一点点"，而不是
"这是一条用尺子画出来的线"。这是温润与冷酷的分界。

### 暖白四阶（绝不使用冷灰）

- **Bg `#FAF9F5`**：主背景。纸张暖米白，是工作区的"纸"。
- **Bg-sunk `#F2F0E8`**：下沉背景。sidebar、空状态、表格行 hover。比 bg 深一档，
  暗示"这是底"。
- **Bg-strong `#E8E0D2`**：强调暖米。当前选中 tab、置顶 band、强调 callout。比 bg-sunk
  再深一档，用于"我希望你看到这一块"。
- **Surface `#FFFFFF`**：卡面纯白。浮在 bg 之上，承载具体内容卡片。Hover 时偏移至
  `#FBFAF6`（surface-hover）。

### 互动主轴

- **Primary `#C8553D` 陶土红**：唯一互动驱动色。主按钮、当前选中态、外链、焦点环。
  总面积应当低于 5%，让它具有"出现即被注意"的能力。
- **Primary-hover `#B14A33`**：按下/hover 时深一档。
- **Primary-soft `#F4DCD3`**：陶土浅底，badge 背景、选中行底色。
- **Primary-tint `#FBF1EC`**：极淡陶土，row hover 时的极轻底色 + 焦点环外晕。

### 语义副色（仅表达状态）

- **Plum `#6B4B5C` 梅子**：信息辅助、"已撤销"标记。绝不与 primary 同框做主对比。
- **Success / Warn / Danger（苔藓绿 #6F8B5C / 暖琥珀 #B98947 / 深红 #A8412E）**：
  仅用于语义状态。所有副色都从暖色谱里挑，避免冷蓝/亮紫破坏温度。

### 前景六档

- **Ink `#141413`**：最强对比墨。仅用于 H1（display / headline-lg）与品牌字。
- **Fg `#1F1E1B`**：深棕黑。常规标题与关键正文。
- **Fg-soft `#423F39`**：软棕黑。常规正文。
- **Muted `#6B6862`**：暖灰。辅助说明、时间戳、metadata。
- **Muted-strong `#8B867D`**：强暖灰。占位文字、禁用文字。
- **On-primary `#FFFFFF`** / **On-dark `#FAF9F5`** / **On-dark-soft `#A09D96`**：
  写在陶土红/dark 微表面上的文字。on-dark 是米白而非纯白 — 与主背景同色相，让 dark
  卡片"是从同一张纸上挖出来的"，不是另一种色块。

### Dark Micro-Surface（小处使用 dark）

整个产品**只在三类地方**出现 dark：

1. **代码块** — 内联 YAML / JSON 预览，dark-on-cream 的对比让代码像"墨水印在纸上"。
2. **URL 复制框** — Dashboard 上的订阅 URL、各 provider URL，dark 卡上铺 mono 字，
   像一张"机器可读的标签"。
3. **YAML 预览展开** — 规则集卡片里展开内容预览的 `<pre>` 区块。

不要在 sidebar、主表格、表单 中使用 dark — 那会让产品瞬间变成开发者 dashboard 而非
书卷气工作台。

### 对比度核查（WCAG AA 4.5:1 正文 / 3:1 大字）

| 前景 | 背景 | 比 | 用途 | 通过 |
|---|---|---|---|---|
| ink `#141413` | bg `#FAF9F5` | 18.0 : 1 | H1 / 品牌字 | AAA |
| fg `#1F1E1B` | bg `#FAF9F5` | 16.8 : 1 | 标题 / 关键正文 | AAA |
| fg-soft `#423F39` | bg `#FAF9F5` | 10.4 : 1 | 正文 | AAA |
| muted `#6B6862` | bg `#FAF9F5` | 4.9 : 1 | 辅助文字 | AA |
| primary `#C8553D` | bg `#FAF9F5` | 4.6 : 1 | 大字 / icon | AA Large |
| on-primary `#FFFFFF` | primary `#C8553D` | 4.5 : 1 | 主按钮文字 | AA |
| on-dark `#FAF9F5` | surface-dark `#1F1E1B` | 14.8 : 1 | 代码块文字 | AAA |

### Design Tokens

```yaml
colors:
  bg: '#FAF9F5'
  bg-sunk: '#F2F0E8'
  bg-strong: '#E8E0D2'
  surface: '#FFFFFF'
  surface-hover: '#FBFAF6'
  border: '#E8E5DC'
  border-strong: '#D4CFC2'
  border-active: '#C8553D'
  surface-dark: '#1F1E1B'
  surface-dark-soft: '#2A2823'
  ink: '#141413'
  fg: '#1F1E1B'
  fg-soft: '#423F39'
  muted: '#6B6862'
  muted-strong: '#8B867D'
  on-primary: '#FFFFFF'
  on-dark: '#FAF9F5'
  on-dark-soft: '#A09D96'
  primary: '#C8553D'
  primary-hover: '#B14A33'
  primary-soft: '#F4DCD3'
  primary-tint: '#FBF1EC'
  plum: '#6B4B5C'
  success: '#6F8B5C'
  warn: '#B98947'
  danger: '#A8412E'
```

## Typography

字体策略是 **三家三角**：Fraunces 做记忆点，Inter 做正文骨架，JetBrains Mono 做技术体。

- **Fraunces（serif · 标题专属）**：所有 `display`、`headline-lg`、`headline-md` 走 Fraunces。
  启用可变轴 `opsz`（光学尺寸，越大越浓重）+ `SOFT`（笔画柔度，越大越温润）— 这两轴的
  细微调整是 Fraunces 的精髓，让标题不像"博客标题"而像"印刷品标题"。
  **绝不用 Fraunces 写正文。** 它的目的是让人记住，写正文会让密度变成噩梦。
- **Inter（sans · 正文与 UI）**：所有 `body-*`、`label-*` 走 Inter。启用
  `cv02`/`cv03`/`cv04`/`cv11`/`ss01` 字符变体，让 Inter 的 `a`/`g`/`l` 更接近 Geometric Grotesque，
  与 Fraunces 的有机笔触形成对话。
- **JetBrains Mono（mono · 技术体）**：所有 URL、YAML、key、token id、字节数走 mono。
  关闭连字（`'liga' 0`）— 工程师不想看到 `=>` 变成箭头。

### 硬约束（不可妥协）

1. **Display 字号一律使用 `fontWeight: 500`，绝不到 700**。Fraunces 加粗会丧失"印刷品"
   质感，变成"博客标题"。所有标题靠**字号 + Fraunces 笔触**而非字重撑场。
2. **负字距是 serif 标题的生死线**。`display` 用 `-0.02em`，`headline-lg` 用 `-0.015em`，
   `headline-md` 用 `-0.01em`。没有负字距 Fraunces 就读成"博客字体"，整体设计垮掉。
3. **靠字号梯度做层级，而非字重**。需要更强的层级时，**先升字号，再考虑字重**。如果
   `headline-md` 不够，跳到 `headline-lg`，不要把 `body-md` 加粗到 600。
4. **单屏最多 3 个字号同时出现**。靠字重 + 颜色做层级，而非更多 size。

### 字号梯度（9 档）

| Token | 字号 | 字重 | 用途 |
|---|---|---|---|
| `display` | 40 / 1.1 | 500 | 仅登录页 logo 区 |
| `headline-lg` | 28 / 1.15 | 500 | 页面 H1（"总览"、"基础配置"等） |
| `headline-md` | 20 / 1.25 | 500 | 区块标题、对话框标题、master-detail detail H2 |
| `title-sm` | 14 / 1.4 | 600 | 表格列头加粗、小标题 |
| `body-lg` | 15 / 1.55 | 400 | 关键正文（说明区、对话框） |
| `body-md` | 14 / 1.55 | 400 | 常规正文 |
| `body-sm` | 13 / 1.5 | 400 | 辅助正文 |
| `label-md` | 12 / 1.3 | 500 | Badge、按钮、表单 label |
| `label-caps` | 11 / 1 | 600 | UPPERCASE 章节铭牌（如 sidebar "场景"） |
| `mono-md` | 12 / 1.55 | 400 | URL、YAML、token id |
| `mono-sm` | 11 / 1.5 | 400 | 行号、kbd 内文字 |

### Design Tokens

```yaml
typography:
  display:
    fontFamily: Fraunces
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: -0.02em
    fontVariation: '"opsz" 144, "SOFT" 30'
  headline-lg:
    fontFamily: Fraunces
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: -0.015em
    fontVariation: '"opsz" 96, "SOFT" 30'
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  label-caps:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0.08em
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: '"liga" 0'
```

## Layout

布局模型是 **固定 Sidebar + 流式工作区**，桌面优先，移动端不是核心目标但要可用。

- **栅格**：Sidebar `240px` 固定 + 工作区流式（min `0`，max `1200px`）。无第二层
  sidebar、无固定 right rail。
- **间距基线**：4px。日常使用 8 的倍数（`sm 8 / md 12 / lg 16 / xl 24 / 2xl 32`）。
  4px 仅作微调（badge 上下 padding、行高补偿）。
- **页面内边距**：工作区左右 padding `32px`（`page-pad`），上 padding `32px`，
  下 padding `48px`（让滚动到底不顶到边）。
- **卡片内边距**：标准 `20px` 全周。卡头/卡身分割时上下各 `14px`。
- **区块间距**：垂直 `xl(24px)` 是默认；同主题相邻可下沉到 `lg(16px)`；语义跨越用 `2xl(32px)`。
- **断点**（见 Responsive Behavior 章节）。
- **对齐哲学**：**所有可点击元素的水平基线对齐**。卡头里 title + button 的 baseline 对齐
  是这个设计最容易被偷懒的地方 — 一旦错位，"印刷品质感"立刻塌掉。

### Design Tokens

```yaml
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  '2xl': 32px
  '3xl': 48px
  gutter: 24px
  page-pad: 32px
  sidebar-w: 240px
  content-max: 1200px
```

## Elevation & Depth

**Tonal Layers 优先，阴影克制**。这是浅色 + 暖色调最容易翻车的地方 — 一不小心就堆出
PowerPoint 阴影。规则：

1. **首选用背景色阶分层**。四层暖白背景（`bg-sunk` → `bg` → `bg-strong` → `surface`）
   能表达 90% 的层级。Sidebar 在最下（`bg-sunk`），主区在中（`bg`），强调 band 用
   `bg-strong`，卡片浮于其上（`surface`）。
2. **阴影只用于"真的浮起来"的元素**。卡片用单层极轻阴影 `0 1px 2px rgba(0,0,0,0.04)`；
   对话框/弹窗用双层阴影 `0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -12px rgba(0,0,0,0.12)`；
   绝不用 `0 4px 12px` 那种"中等阴影" — 它两边不靠。
3. **永远不要给卡片同时加阴影和实色 1px 边框**。两者择其一。本设计选「边框 + 一档极轻
   阴影」的组合（边框是骨、阴影是气）。
4. **Hover 抬升用色变 + 边框色变**，不用 `transform: translateY`。`translateY` 在密集列表里
   会触发布局 jitter；色变零成本零副作用。
5. **聚焦环**：所有键盘可达元素的 `:focus-visible` 使用
   `0 0 0 2px {primary-tint}, 0 0 0 3px {primary}` 双层 ring。陶土色 ring 是签名细节之一。
6. **Dark micro-surface 不加阴影**。ShikiBlock / InlineUrl 已经因为颜色反差自带提升感，
   再加阴影会变成"产品截图"而非"印刷标签"。

### Z 轴顺序

| 层 | z-index | 元素 |
|---|---|---|
| Base | 0 | 工作区背景 |
| Surface | 10 | 卡片、表格 |
| Sticky | 20 | 表头、固定 toolbar |
| Sidebar | 30 | 侧边栏 |
| Overlay | 40 | Dropdown、Tooltip |
| Modal | 50 | Dialog |
| Toast | 60 | 通知 |

## Shapes

形态语言是 **「文档化方圆混合」**：

- **正文 / 卡片 / 代码块 / 对话框**：12px 圆角（`rounded.lg`）。够软像书页，不软像泡泡。
- **输入框 / 次按钮 / 内联 URL 框**：8px（`rounded.md`）。
- **Badge / 状态标 / 表格内 select**：4px（`rounded.sm`）。小元素配小圆角，保持精度。
- **主按钮**：**pill / 9999px**。是这个产品唯一的形态记忆点之二（之一是 Fraunces 标题）。
  pill 主按钮在浅色 + serif 标题的画面里，像「圆形邮票盖在一封信上」。
- **状态点**：6px 圆形（`rounded.full`，size `6px`）。表格行/列表项**左侧**出现的点，
  替代部分 badge — 用纯几何说"这一项是启用的"比用文字快得多。
- **图标**：使用 16-20px 线性图标。线宽 1.5px，圆角端点（round）。
  绝不使用填充图标 — 与 serif 标题的开放笔触相冲。
- **分割线**：1px `border-color`。绝不用 dashed/dotted — 一旦虚线，就 PowerPoint 了。

**混搭规则**：主按钮独占 pill，其他可点元素都用 8/12px。永远不要让两个 pill 同框出现。

### Design Tokens

```yaml
rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 12px
  xl: 16px
  full: 9999px
```

## Components

### Button

| 变体 | 形态 | 何时用 |
|---|---|---|
| `primary` | pill · 陶土红填充 | 一屏最多 1 个 — 是「保存」「创建」「确认」 |
| `secondary` | 12px 圆角 · 白底 + 发丝边 | 「校验」「编辑」「刷新」「取消」 |
| `ghost` | 8px 圆角 · 透明底 · 暖灰文字 | 「展开/收起」「sidebar 退出」 |
| `danger` | 8px 圆角 · 透明底 · 深红描边 | 「删除」 |

**全部按钮**：
- `transition: all 150ms ease`
- `active:scale-[0.98]`（**签名微交互**，全站统一）
- `focus-visible` 双层 ring（见 Elevation）
- 高度 36px（md）或 32px（sm，仅次按钮/ghost）

### Page Composition（不再提供 Card 原子）

**重要的设计取向**：本设计**没有**通用的 `Card / CardHeader / CardTitle / CardBody` 原子。
每页根据自己的信息架构组合，避免「所有页面都长得像一种壳」的 SaaS 同质化。

通用的"卡面"看法是一个组合：

```jsx
<div className="rounded-xl border border-[var(--color-border)]
                bg-[var(--color-surface)] shadow-[var(--shadow-card)]">
  ...自由布局...
</div>
```

- 圆角 `lg / 12px`，边框 `border`，背景 `surface`（白），阴影 `0 1px 2px rgba(20,20,19,0.04)`
- **强调态**：背景换成 `bg-strong`（暖米深一档），用在"当前重点"语义上
- **永远不要嵌套同色卡片**。需要层级时用背景色阶反转（`surface` → `bg-sunk` 内嵌区）
- Hover（仅可点）：边框 `border-strong` 或 `primary/30`；不用 box-shadow 加深
- Padding 完全由内容决定 — 一份"档案卡"（订阅源）和一份"目录条"（场景）有截然不同的留白节奏

参考：每页具体的卡面 / 容器形态见 **Page Patterns** 章节。

### YamlEditor（CodeMirror 6 · 全屏专用）

`/base` 基础配置的主角。**唯一**承担 YAML 深度编辑职责的组件。

- 引擎：CodeMirror 6 + `@codemirror/lang-yaml`
- Tab=2 空格，自动缩进，括号匹配
- 语法高亮：YAML key 用 `ink` 浓墨且 600 字重；string 用 `fg-soft`；
  number/boolean/keyword 用 `primary` 陶土；注释用 `muted-strong` 斜体
- 光标颜色 `primary`，选区底色 `primary-soft`
- 行号 gutter：背景 `bg-sunk`、字色 `muted`、当前行高亮 `primary-tint`
- 折叠 marker 用 `▾ / ▸` 小符号
- 快捷键：`⌘S` 保存、`⌘F` 搜索、`Mod+/` 注释行
- **不嵌在 Card 里**。它直接占满主区，由外层全屏 layout 包裹（见 Page Patterns: /base）

### ShikiBlock（dark · 只读高亮预览）

替代旧 `code-block`。承担 **所有只读高亮代码** 展示（规则集 YAML 展开、dev-echo 响应、
Dashboard 文档块等）。

- 引擎：`shiki/core` + `@shikijs/engine-javascript`（**不用 wasm**，避免 200 grammar 全包）
- 主题：`github-dark-default`，渲染在 `surface-dark` 上
- 仅显式加载用到的 4 种语言：`yaml / json / bash / typescript`
- `inline=true` 变体用 `surface-dark-soft`（嵌在卡里的次级 dark）
- `maxHeight` 可控；超高时容器内 vertical scroll
- **不加阴影、不加边框**。颜色对比即提升感

### InlineUrl（dark · URL 标签 + 白纸按钮对照）

- 背景 `surface-dark`，文字 `on-dark`，字体 `mono-md`
- 圆角 `md / 8px`，padding `8px 12px`
- 默认右侧紧贴一个 `button-secondary` "复制" 按钮，组成「dark 标签 + 白纸按钮」对照
- `bare` 变体省略复制按钮（用在已有上下文复制目标的场景）

### Badge

5 个 tone：`neutral / accent / success / warn / danger`。共有规则：
- 高度 20px，padding `2px 8px`
- 圆角 4px（不要 pill — pill 留给主按钮）
- 字号 `label-md` 12px，字重 500

### Input / Select / Textarea

- 高度 36px（textarea 取消高度限制）
- 背景 `surface`（白），边框 `border`，圆角 `md / 8px`
- 聚焦：边框转 `primary`，背景保持白，外加双层 ring
- Placeholder 用 `muted-strong`
- 禁用：opacity 40%，cursor not-allowed

### Sidebar Link

- 默认：透明背景 + `fg-soft` 文字
- Hover：白卡浮起（`surface` 背景）+ `fg` 文字
- Active（当前页）：白卡 + `fg` 文字 + **左侧 2px `primary` 竖条**作为锚定
- 圆角 `md / 8px`，padding `6px 10px`
- 图标 16px，置于文字左侧 8px

### Table Row

- 高度 40px（紧凑），padding `8px 12px`
- 默认背景 `surface`，hover 转 `bg-sunk`（**反向变深**，符合「翻动纸张」隐喻）
- 选中行用 `primary-tint`（极淡陶土）
- 行分隔线：1px `border`
- 行左侧**可选状态点**：6px 圆形，位于第一列前 4px gap，替代 enabled/disabled badge

### Status Dot

签名细节。出现位置：表格行最左、卡片标题旁。颜色：`dot-on` 苔藓绿、`dot-warn` 暖琥珀、
`dot-off` 灰、`dot-error` 深红。不要给状态点加 ring / glow / 动画 — 它是「印刷品上的
标点」，静默存在。

### Kbd

键盘提示。背景 `surface`（白）+ `border` + 圆角 `sm`，字号 `mono-sm`。用于
shortcut hint：`⌘K`、`Esc`、`Enter`。

### TrafficBar（订阅源主图）

- 高度 6px，圆角 `full / 9999px`，track 用 `bg-strong` 暖米
- 上传段用 `plum` 梅紫，下载段用 `primary` 陶土，两段拼接显示比例
- 上方一行文字：`↑ 字节量 · ↓ 字节量 / 总额`，最右端百分比，全部 `tabular-nums`
- 下方可选铭牌：`到期 YYYY-MM-DD`，用 `label-caps` UPPERCASE
- 用在订阅源档案卡（`Dossier`）右侧主区底部

### Timeline · TimelineGroup · TimelineEvent

`/history` 操作历史的视觉骨架。**完全替代了"日历表格"模式**。

- `TimelineGroup`：日期分组容器
  - 顶部 Fraunces `headline-md` 日期（"今天 / 昨天 / 5 月 21 日"）+ flex-1 横分隔线
  - 内部一条 1px 暖灰垂直时间轴（`left-[7px]`）
- `TimelineEvent`：一行一事件
  - marker 是一个 14px 字符 glyph，**精确居中在时间轴上**
  - glyph 系统全部为圆点系：`● 新增 / ◐ 修改 / ● 删除（红） / ○ 撤销`
    — **绝不混用 `✕`**（会跟左下角的「删除」`✕` 图标语义打架，且非圆形破坏节奏）
  - 行内布局：`时间 (w-12) · 操作人 (w-16 mono) · 内容描述 · 撤销 (hover 才显示)`
  - 行 hover 转 `bg-sunk`，圆角 `md`
  - 撤销态用 `opacity-50` 表达"软删除/历史化"
- 间距：事件之间 `space-y-1`（4px），日期组之间 `space-y-3`（12px）

### ChainDiagram（链式代理可视化）

`/scenarios/chained-proxy` 的图形语言。用「**节点-箭头-节点**」替代字符串描述。

- `ChainNode`：单个节点，三种 tone：
  - `front`（前置入口）：白底 + 暖灰强边
  - `chain`（链路 group）：`primary-soft` 陶土浅底
  - `backend`（后端出口）：`bg-strong` 暖米强底
  - `pool`（池成员）：白底 + 暖灰轻边
- `ChainArrow`：mono `─→` 字符，`muted` 色，不可选
- `ChainPool`：N 个候选 front + 虚线边框 + 池名铭牌（`label-caps`）
- `ChainRow`：一行 = 一条链路完整路径，右侧 action 按钮区
- 所有节点统一高度 28px，`rounded.md`，行内 flex wrap

### Reveal · Placeholder（内容到达过渡）

- `Reveal when={dataLoaded}`：包裹会"晚到"的内容块。数据为 null 时 `null`，
  数据到达后开始 `pm-reveal` 220ms opacity 缓入
- `Placeholder rows={n}`：纸张感占位 —— **不是骨架灰条**，是 `bg-strong` 暖米色条 + 
  错位宽度 + 轻微脉动（`pm-pulse` 1400ms ease-in-out infinite）
- 两者配合解决「点开 → 空白 1 秒 → 突然出现内容」的问题
- 使用约定：页面 header 永远立刻渲染（不等数据），数据依赖的 body 才走 Reveal

### RouteProgress（顶部路由切换条）

- 路由 pathname 变化时短暂闪过 800ms
- 2px 高度，从左到右一道 `linear-gradient(primary-tint → primary → primary-hover)` 横扫
- `position: fixed; top: 0`，z-index 70（高于一切常规层）
- 第一次挂载不触发，避免页面初始即闪
- 只服务 navigation 反馈；与 page-load 进度无关（那是 Reveal 的职责）

### Signature Interactions

- **按下缩放（统一全站）**：所有按钮、链接、可点卡片、sidebar link 都有 `active:scale-[0.98]`，
  transition 150ms。这是用户手指与产品的唯一触感反馈。
- **聚焦环（陶土双层）**：键盘焦点出现陶土色双层 ring。鼠标焦点不显示（用 `:focus-visible`）。
- **悬停色微移**：所有 hover 仅过渡背景色（150ms），**不**用 transform / box-shadow 变化。

## Loading & Transitions

页面在「点击 → 渲染 → 数据 → 就位」的几次状态翻转里如何呈现自己。这一节不是 polish，
是工具产品体面的基本功。

### 三层过渡系统

1. **RouteProgress（路由切换层）** — `pathname` 一变就出现 800ms 顶部陶土条。
   告诉用户"我点的链接已经被收到"，不必等下一帧的实际渲染。
2. **pm-reveal（页面挂载层）** — `(authed)/layout.tsx` 的内容容器用 `key={pathname}`
   重挂载，触发 `pm-reveal` 220ms 淡入。**仅 opacity，绝不带 transform**。
3. **Reveal + Placeholder（数据到达层）** — 每个数据依赖的 page，header 永远立刻
   渲染，body 用 Placeholder 暖米脉动条占位，数据到达后切换到 `<Reveal>` 包裹的真
   实内容（再走一次 220ms opacity fade-in）。

### 硬规则

| 规则 | 原因 |
|---|---|
| **过渡只用 opacity，禁止 transform** | `translateY` 收尾时 Retina / 非整数 DPR 屏会做亚像素重排，与父层滚动条出现/消失叠加 → 居中内容横向闪 1-2px。本设计曾踩过这个坑 |
| **`scrollbar-gutter: stable` 是非负零项** | 应用在 `html` / `main` / 所有 `overflow-y-auto` 容器。滚动条出现/消失时不挤压内容宽度。例外：`.surface-dark` 内部不强制（小代码块右侧留 10px 空白会很丑） |
| **占位用暖米脉动，不用灰矩形骨架** | 灰骨架是 SaaS 默认相。`bg-strong` 错位条 + `pm-pulse` 1400ms 既存在感又不抢戏 |
| **加载时 header 永远立刻渲染** | 用户需要立刻看到"我在哪一页"。空白页 1 秒比加载到一半的页更慌 |
| **尊重 `prefers-reduced-motion`** | 全部 keyframe 在 reduced-motion 介质下自动 0ms |

### Design Tokens

```yaml
motion:
  scale-press: 0.98
  reveal-duration: 220ms
  reveal-slow-duration: 320ms
  route-progress-duration: 800ms
  placeholder-pulse-duration: 1400ms
  scrollbar-gutter: stable
```

## Page Patterns

非规范章节。每页根据自己的 ONE JOB 选定布局原型。**没有一个页面是另一个的复制粘贴。**

### 1. Dashboard `/` — Hero URL + 侧栏数字

- ONE JOB：用户登录后第一眼看到、能立刻复制走的订阅 URL
- 主区 `<section>`：dark micro-surface URL 大卡 + 复制 / 二维码主操作
- 右侧 220px 栏：四个 Fraunces 32px 大数字（锚点 / 策略 / 规则 / 订阅），各点击直达详情
- 底部 `<section>`：快捷入口 chip 行（base / rule editor / history / API docs）
- **不用** 4 张并列 stat 卡 — 那是 SaaS 默认相

### 2. /base — 全屏 YAML 工作台

- `-mx-8 -mt-8 -mb-12 h-[calc(100vh)]` 吸收 layout padding，全屏铺满
- 顶部 sticky 工具栏 56px：`H1 + etag + 未保存点 + 行/字节数 + ⌘S 提示 + [校验] [保存]`
- 状态条（可选）：成功 / 错误 / 信息一行，跨主区横铺
- 主区 grid `1fr_280px`：
  - 左：CodeMirror 6 占满，行号 gutter + 当前行陶土底高亮
  - 右（xl+ 可见）：Inspector 列出锚点 / 策略 / 孤立规则 + 编辑器键盘提示

### 3. /rule-sets · /collections — Master-Detail 抽屉

- 同样 `-mx-8 -mt-8 -mb-12 h-[calc(100vh)]` 全屏
- 顶部条：`H1 + 计数 + [+ 新增]`
- 主区 grid `280px_1fr`：
  - 左 nav：列表项每条一行 `状态点 + 名称(mono) + 元数据小字 + 时间`
    - 选中项 `surface` 白卡 + `border-l-[2px] primary`
  - 右 detail：单条目铺开（serif H2 + 字段块 + dark micro-surface 内容预览）
- 编辑态接管整个 detail 区域；不弹模态、不内嵌膨胀

### 4. /subscriptions — Dossier 档案卡

- 列表式，每条订阅一张 `grid grid-cols-[96px_1fr]` 卡
- 左 96px 状态条（`bg-sunk`）三段：
  1. Fraunces 22px 大序号 `01/02/…` + `NO.` 铭牌
  2. StatusDot + 启用 / 异常文字
  3. `mt-auto` 顶到底的 IconButton 列（40×40 透明底）：刷新 / 启停 / 删除
- 右主区：serif 标题 + 元数据 / Provider URL（InlineUrl）/ 上游 URL / 标签 / **TrafficBar**

### 5. /history — Vertical Timeline

- 按日期分组（`今天 / 昨天 / 5 月 21 日`）—— 每组 Fraunces serif label + 横线
- 每个日期组里一条 1px 暖灰垂直时间轴 + 圆点系 glyph marker
- 事件行：`时间 · 操作人 · 内容 chips`，hover 才显示「撤销」文字按钮
- **不用表格**。timeline 表达时间感比表格强 10 倍

### 6. /scenarios — 图书馆目录

- 极简列表，每条一行 `grid grid-cols-[3rem_1fr]`：
  - 左：Fraunces 24px 序号 `01`
  - 右：Fraunces 24px 标题 + mono id 边注 + 描述软字
- 行间用 1px border 分隔，无卡片；hover 整行变 `bg-sunk` + 序号转陶土
- 像一本书的目录页，不像 SaaS 卡片墙

### 7. /scenarios/rule-anchor-append — 全宽数据电子表格

- `-mx-8 -mt-8 -mb-12 h-[calc(100vh)]` 全屏
- 工具栏拆**两行**：
  - 上行：`H1 + 计数 + + 新增规则`
  - 下行：`FilterChip × 3`（暖米沙底，内嵌 Select，无重复边框）+ 搜索框 + `清空筛选`
- 主区：full-bleed `<table>`，无 Card 包裹
- 第一列 `#` 行号 + 第二列「锚点」**双 sticky 列**
- 每行删除按钮 `opacity-0` 默认隐藏，`group-hover` 显示

### 8. /scenarios/chained-proxy — 节点-箭头-节点

- 两 `<section>`：固定链路 + 链路池，各自带 `+ 新建`
- 固定链路一行一图：`[front] ─→ [chain group] ─→ [backend]`
- 链路池一行一图：`[front 多个虚线圈起] ─→ [chain] ─→ [backend]`
- 用 ChainDiagram 原子组合，**不写字符串**

### 9. /scenarios/dev-echo — REPL 终端

- 上下两段：`▸ request payload (dark textarea, JSON)` / `◂ response (dark ShikiBlock)`
- 按钮组：`POST · ping` / `POST · mark`，右下角 mono 字「scenario: dev-echo」
- 调试工具有终端的形状，不混杂用 Card

### 10. /login — 极简信封

- Fraunces 40px 大品牌字 + 一句铭牌 + 一张白卡 + pill 主按钮
- 单列居中，最大 360px 宽

## Do's and Don'ts

**Do**

- ✅ 把 primary 陶土红用在一屏唯一最重要的操作上。其他操作走 secondary / ghost。
- ✅ 所有标题使用 Fraunces；正文使用 Inter；技术内容使用 JetBrains Mono。三家清晰分工。
- ✅ 卡片之间用背景色阶（surface 浮在 bg 上、bg-sunk 在 sidebar）表达层级。
- ✅ 所有交互元素带 `active:scale-[0.98]`。这是统一的触感语言。
- ✅ 状态用 6px 圆点 + 颜色，**优先于** 文字 badge。屏幕安静的代价是细节精确。
- ✅ 表格行 hover 是 **变深**（→ bg-sunk），不是变白 — 与"翻动纸张"的隐喻一致。
- ✅ 所有边框颜色都来自暖色谱（`#E8E5DC` / `#D4CFC2`），绝不用冷灰 `#E0E0E0`。
- ✅ 主按钮独占 pill 形态。其他所有可点元素 8/12px 圆角。
- ✅ 用 `tabular-nums` 处理所有数字（计数、字节、TTL、时间戳）— 让数字成列。
- ✅ 技术内容（代码 / URL / YAML）使用 dark micro-surface。让"看技术"变成印刷标签。
- ✅ Dark 卡上的文字用 `on-dark` (#FAF9F5，米白) 而非纯白 — 与 bg 同色相，让 dark 卡
  "像从同一张纸挖出来"。
- ✅ 边框 = 色阶提升一档，不是墨线分隔。这是温润与冷酷的分界。
- ✅ **每页有自己的信息架构**。不要把所有页面都套同一个 Card+Header+Body 的壳 — 那是 SaaS 同质化的起点。
- ✅ 数据依赖的内容用 `<Reveal>` + `<Placeholder>`，不要让用户对着空白页等 1 秒。
- ✅ 滚动容器一律 `scrollbar-gutter: stable`（dark micro-surface 内部除外）。
- ✅ 全屏页（编辑器 / master-detail）用 `-mx-8 -mt-8 -mb-12 h-[calc(100vh)]` 模板吸收 layout padding。
- ✅ Timeline marker 用圆点系（`● ◐ ○`），不与「删除」的 `✕` 图标语义打架。

**Don't**

- ❌ 不要让 primary 陶土红出现在装饰元素（背景、分隔线、icon 默认色）。它只服务于操作。
- ❌ 不要用 Fraunces 写正文。它有性格，但性格不能写满全屏。
- ❌ 不要把 Fraunces 加粗到 700。所有 display 一律 500。靠字号梯度做层级，不靠字重。
- ❌ 不要丢掉 serif 标题的负字距。`-0.02em` 是生死线，丢了就成"博客标题"。
- ❌ 不要把卡片同时加阴影 + 实色边框 + hover 上浮三件事。三选一。
- ❌ 不要在密集列表里用 `translateY` 做 hover — 会触发 layout jitter。
- ❌ 不要用纯灰 `#E0E0E0` / `#D9D9D9` 做边框 — 一秒钟变 PowerPoint。
- ❌ 不要混搭 pill 和 8px 圆角的按钮在同一行。两个 pill 同框 = 记忆点稀释。
- ❌ 不要用填充图标。线性 + 1.5px 线宽 + 圆角端点是图标语言。
- ❌ 不要用紫蓝渐变、purple-to-blue、毛玻璃、霓虹外发光 — 任何 2023 SaaS 默认装饰都禁止。
- ❌ 不要在单屏出现 3 个以上字号同时存在。
- ❌ 不要把语义副色（苔藓绿、暖琥珀、深红、梅子）用于非语义场景。
- ❌ 不要用渐变背景做卡片底色。如果想要"高级感"，靠纸张白 + 边框就够了。
- ❌ 不要在 toast/dialog 之外的位置使用阴影 > `0 1px 2px`。中等阴影是最劣等的选择。
- ❌ 不要把 dark micro-surface 大面积铺开（sidebar / 主表格 / 表单）。dark 只能小处出现。
- ❌ 不要在 dark micro-surface 上加阴影或边框 — 颜色反差已经给了提升感，再加是冗余。
- ❌ **不要把通用 Card / CardHeader / CardTitle / CardBody 当默认壳**。已退役。每页定制自己的容器形态。
- ❌ **不要在过渡动画里用 transform**（只用 opacity）。`translateY(4px → 0)` 在 Retina 屏会导致内容横向闪 1-2px。
- ❌ **不要把 `display: contents` 与动画并用**。浏览器对此组合行为不一致；动画会"失踪"或表现异常。
- ❌ **不要在小代码块 / inline URL 框里强制 `scrollbar-gutter: stable`**。右侧留 10px 空白会很丑。让 `.surface-dark` 走 `scrollbar-gutter: auto`。
- ❌ 不要在 Timeline 上混用 `✕` 字符 marker —— 它会跟「删除」按钮的 `✕` 视觉打架。删除事件也用 `●`（红色）。

## Responsive Behavior

非规范章节。工具产品的响应式不像 marketing 页那样浪 — 重点是"在不同宽度下仍然能看完
表格 / 卡片不丢内容"。

### 断点

| 名称 | 宽度 | 关键变化 |
|---|---|---|
| Mobile | < 768px | Sidebar 折叠为顶部抽屉；卡片 1 列；表格保留 horizontal scroll；H1 28→22px |
| Tablet | 768–1024px | Sidebar 仍展开但内容区 padding 收紧到 24px；多列网格降为 2 列 |
| Desktop | 1024–1440px | 标准：sidebar 240px + 主区流式（max 1200px）；多列网格 2-4 列 |
| Wide | > 1440px | 主区域居中，最大 1200px；两侧呼吸更宽 |

### 折叠策略

- Sidebar 在 < 768px 时折叠为顶部固定抽屉（点击 logo 展开）。不退化为底部 tab bar。
- 多列网格（Dashboard 的 Stat、Scenarios 列表）按 `lg:grid-cols-4 / md:grid-cols-2 / grid-cols-1` 阶梯。
- 表格在窄屏不允许折叠为卡片列表 — 保留 horizontal scroll。表格的横向密度是它的价值。
- Dark micro-surface（ShikiBlock / InlineUrl / YamlEditor）在窄屏内部允许 horizontal scroll，不要 wrap。
- 卡片 hover 状态在 touch 设备下不生效，只保留 active:scale。

### 触控目标

- 主按钮高度 36px（pill 形态视觉等价 40px）。
- 次按钮高度 36px。
- 状态点 6px — 不可触控，仅视觉。它依附于行的整体可点击区域。
- 表格行整行可点（如有 action），高度 40px。

## Iteration Guide

非规范章节。给后续维护 DESIGN.md 的人留入口。

1. **一次只动一个 token**。改 `primary` 是大动作；改 `bg-sunk` 是局部调整。改之前先在
   一个真实页面（订阅源 / 操作历史）上试一个截图。
2. **新增 token 必须先证明"现有的不够用"**。如果一个新颜色能被现有 token 表达
   （含半透明），就不要新增。
3. **变体用相邻 key 而不是嵌套结构**。例：`button-primary-hover` 是 `button-primary` 的
   兄弟而非属性。
4. **永远不在 prose 里写裸 hex**。所有色值都走 `{colors.xxx}` 引用。Hex 只允许出现在
   YAML front matter 与对比度核查表。
5. **想加新组件？先问"它会出现在几个页面"**。少于 2 个页面就不要写进 components。
   一次性视觉直接在 prose 里描述。
6. **强调？先升字号，再升字重**。优先用 `headline-md` 替代 `body-md + bold`。这是
   serif 系统的核心纪律。
7. **Dark micro-surface 是节制资源**。整个产品的 dark 总面积应当 < 10%。每加一个
   dark 组件前，先问"它真的需要变 dark 吗"。
8. **Components 之间互相引用**。`dialog` 可以引用 `card`，`split-view-sidebar` 可以引用
   `sidebar`。token 引用网越密，未来改动越省。

## Known Gaps

非规范章节。已知未覆盖的部分。

- **Fraunces / Inter / JetBrains Mono 的字体加载策略**：当前通过 `next/font/google` 自托管。
  CJK 部分由系统字体（PingFang SC / Noto Sans SC）兜底，Fraunces 中文 fallback 到
  `Noto Serif SC` — 这意味着中文标题在 macOS 上是 PingFang，在没装思源宋体的 Windows
  上会回退到系统默认 serif，外观不完全一致。
- **Dialog / Toast / Tooltip 三件套未定义**。当前产品没有这些组件，但聚焦环和阴影规则
  已经预留了 Modal / Toast 的 z-index 层。需要时再补 components。
- **空状态插画语言未定**。目前所有空态都是 muted 文字 — "还没有 X，先到 Y 页新增"。
  如果未来要加插画，需要锁定线性 / 单色 / 暖色调三个约束。
- **暗色主题未做**。整个 DESIGN.md 假设浅色主题，dark micro-surface 是局部使用。如果
  未来要做暗色主题，需要重新映射整套 color token 而非简单反色。
- **图标库未选**。当前 sidebar 用 Unicode 几何符号（◐ ⌬ ⊟）。如果改为 SVG 图标库，
  推荐 lucide-react（线性 + 1.5px 线宽 + 圆角端点，符合本设计）。
- **国际化 fontVariation**：Fraunces 的 `opsz` / `SOFT` 轴只在 Latin 字符生效。中文部分
  无法应用这些光学调整 — 中文标题会比英文标题"更平"，这是已知不可调和的缺陷。

### 这一轮已解决（仅记录）

- ~~Dialog / Toast / Tooltip 三件套未定义~~ — Dashboard 现有 QR Modal 模板（`fixed inset-0`
  + `bg-ink/30 backdrop-blur-sm` + 居中 `surface` 卡 + `shadow-modal`），后续 Dialog 沿用。
  Toast / Tooltip 仍待定义。
- ~~动画 / 微动效未定义~~ — 见 Loading & Transitions 章节。三层过渡系统就位
  （RouteProgress / pm-reveal / Reveal+Placeholder）。
- ~~Mobile sidebar 折叠抽屉~~ — 仍未实现。当前在窄屏 sidebar 仍占 240px，内容区被挤。
  已知项；优先级低（产品定位是桌面端）。

### 这一轮新发现的硬约束（已写入 Don'ts）

- **过渡动画不可用 transform，只能 opacity**。否则 Retina 屏会有 1-2px 横向闪现。
- **滚动条 gutter 必须 `stable`**。否则居中内容在滚动条出现/消失时会被挤位移。
- **`display: contents` 不可与动画并用**。退化为正常 wrapper 元素。
- **Timeline glyph 全圆点系**，禁止与 `✕` 混用。

### 仓库 / 依赖陷阱（曾经爆过 50G 内存）

- Next.js + 多 lockfile 检测：根目录与 `web/` 都有 `package-lock.json` 时，Turbopack
  会把仓库根当 workspace root，沿着错误拓扑递归扫描依赖树。**修复**：`next.config.ts`
  显式锁 `turbopack.root = __dirname` + `outputFileTracingRoot`。
- Shiki 必须用 `shiki/core` + 显式 `@shikijs/langs/*` 按需 import + `@shikijs/engine-javascript`，
  绝不用 `import('shiki')` meta 包 — 后者会让打包器把 ~200 个 grammar 都列为可加载入口，
  dev 模式爆内存。
