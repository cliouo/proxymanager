# ProxyManager 设计规范 v2 — "Signal Console"

> 本文件取代旧版「Heritage Atelier」设计规范。AI 实现 UI 时以本文件 + 对应原型 HTML 为准；
> 原型是视觉与交互的唯一参照（open-design 项目「Web Prototype」：`v2/*.html` + `css/v2.css` + `js/v2.js`）。
>
> **落地修正**：原型 `css/v2.css` 的 `:root` 默认是**浅色「Daylight Console」**，深色走
> `:root[data-theme="dark"]`。本仓库实现以 CSS 为准：**默认浅色**，三态切换 light / dark / system
> （next-themes，`attribute="data-theme"`、`storageKey="pm-theme"`）。token 见 `web/app/globals.css`，
> 组件类见 `web/app/styles/v2-components.css`。

## 0. 一句话定位

深石墨 / 浅天光双画布上的单人运维工作台：等宽字体承载数据，电光青只给"当前与主操作"，
AI 紫只给助手身份。克制、致密、像一台校准过的仪器。

## 1. 设计原则（按优先级）

1. **只画真实能力。** 本产品是配置组装器，不连接节点。禁止出现延迟数字、测速按钮、
   节点在线状态等运行时信息；健康检查参数（url/interval/tolerance）是写给客户端的
   静态字段，文案必须如实表述（如"由客户端运行时测定"）。
2. **等宽即数据。** 节点名、组名、YAML、URL、计数、时间戳一律 `--font-mono`；
   叙述性文案用系统 sans。用户应当能凭字体区分"数据"与"界面"。
3. **强调色预算。** 每屏电光青 `--accent` 不超过：当前导航项 + 主按钮 + 一处当前态。
   AI 紫 `--ai` 只允许出现在助手相关元素（fab、抽屉、历史里的 ✦ 标记）。
4. **写操作可追溯。** 任何修改：保存前有未保存点（`--warn`），保存后 toast 确认，
   可撤销的写入操作历史；AI 写操作必须先出 diff 确认卡。
5. **引用完整性可见。** 删除被引用资源时禁用按钮并说明被谁引用；重命名提示级联范围。

## 2. Token 层

CSS 变量（`web/app/globals.css` 的 `:root`，由 css/v2.css 原样移植）：

```css
/* 浅色 Daylight（默认） / 深色 Signal（:root[data-theme="dark"] 覆盖） */
--bg / --surface / --surface-2 / --surface-3   /* 画布与三层表面 */
--fg / --fg-2 / --muted / --faint              /* 前景四档 */
--border / --border-2
--accent / --accent-dim / --accent-on          /* 电光青；浅色压深为 #0c84c4 */
--ok / --warn / --danger / --ai （各配 *-dim） /* 语义色；AI 紫浅色 #7c5fd6 */
--code-bg / --code-fg / --code-gut / --cm-*     /* 代码面与 YAML 五色高亮 */
--scrim                                          /* 抽屉/弹窗遮罩 */
--font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
--r-sm 6px / --r-md 10px / --r-lg 14px / --side-w 228px
```

Tailwind 4 接入：`globals.css` 用 `@theme inline` 把上表逐一映射到 `--color-bg`、`--color-surface`…，
组件里写 `bg-surface text-fg-2 border-border`，随 `data-theme` 实时翻转。
不要让 Tailwind 默认调色板（gray/blue/violet）直接出现在 className 里。
原型组件类（`.btn .panel .pill .side .tbl .stat .chain …`）已移植到 `web/app/styles/v2-components.css`，可直接复用。

### 深 / 浅双主题

同一套语义 token，浅色与深色只是整体翻转值，**组件 className 不需要任何 `dark:` 变体**。

- 浅色为默认 `:root`；深色写在 `:root[data-theme="dark"] { … }` 覆盖块。
- 写死的高亮描边一律改 `color-mix(in srgb, var(--accent) 32%, transparent)`，自动跟随主题。
- 主题持久化 `localStorage['pm-theme']`；切换器三态 light / dark / system。
- **防闪烁**：next-themes 在绘制前注入脚本套用偏好；根 `<html suppressHydrationWarning>`。
- 验收：浅色模式下不得有残留深块（编辑器/终端卡/diff 必须跟着变浅）；黑色 `box-shadow` 可保留。

## 3. 排版

- 正文 14px/1.55 系统 sans；页面标题仅 topbar 内 15px/600，**不做大标题**。
- 分区标题：10–11px mono 全大写 + `.14em` 字距 + `--faint`（贯穿全产品的"刻度"语言）。
- 数据列表行内主体 13–13.5px；元信息 11–12px mono `--faint`。
- 数字一律 `tabular-nums`。

## 4. 布局骨架

- 左侧固定侧边栏 228px（品牌块 / 分组导航 / 版本脚注），
  内容区 topbar 54px 粘性 + `max-width 1240px`（数据密集页可放宽）。
- 阴影只用于浮层（toast/modal/抽屉）；面板层级靠 1px 边框 + 表面色阶，不用投影。

### 响应式四档体系（落地时按此实现，勿只做一档）

| 档位 | 宽度 | 侧边栏 | 关键重排 |
|---|---|---|---|
| 桌面 | >1200px | 228px 固定 | 完整双列 / Master-Detail |
| 平板横屏 / 窄笔记本 | 961–1200px | **68px 图标轨道，悬停/聚焦展开覆盖层** | 右侧栏收窄 |
| 平板竖屏 | 601–960px | 抽屉（汉堡键 + scrim，ESC 可关） | 双列→单列；Master-Detail 列表变**横向滑动卡带**；统计 2 列 |
| 手机 | ≤600px | 抽屉 | topbar/tabs/筛选 chips 横向滚动；AI 抽屉全屏；链路图竖排；数据表 `.tbl-wrap` 横滚；长 mono 文本 break-all |

- 触屏（`@media (pointer: coarse)`）独立处理：按钮 38px、输入 42px 且 `font-size:16px`（防 iOS 聚焦缩放）、开关 44×26、hover 才显示的行内操作改为常显、`.kbd` 隐藏。
- 安全区：`viewport-fit=cover` + `env(safe-area-inset-bottom)`（toast、抽屉输入区、侧边栏脚注）。
- 验收口径：360 / 390 / 600 / 768 / 820 / 1024 / 1366px 全部无水平滚动；信息不丢——窄屏禁止 `display:none` 砍掉功能。

## 5. 组件契约（与原型类名对应）

| 组件 | 类名 | 要点 |
|---|---|---|
| 面板 | `.panel / .panel-head / .panel-body` | 1px `--border`，圆角 `--r-lg` |
| 按钮 | `.btn (.primary/.danger/.ghost/.sm/.ai)` | inset 1px 描边代替外阴影 |
| 状态丸 | `.pill (.ok/.warn/.err/.idle/.acc/.ai)` | 自带圆点；`.plain` 去点 |
| 筛选芯片 | `.chip (.on)` | 可多选，与搜索框联动过滤 |
| 分段单选 | `.seg .opt (.on)` | 类型/视角切换 |
| 开关 | `.switch[aria-pressed]` | 开 = accent 填充 |
| 输入 | `.input (.mono)` | focus = accent 描边 + 3px dim 光环 |
| 表格 | `.tbl` | th 粘性 mono 大写；行 hover 显操作 |
| 代码块 | `.codebox` + `.cm-*` | YAML 高亮五色 |
| 编辑器 | `.editor`(gutter 行号) | 未保存点 `.unsaved-dot` + ⌘S |
| 时间轴 | `.tl-day / .tl-item` | glyph 按操作类型着色，AI 操作 ✦ 紫 |
| 链路图 | `.chain / .chain-node / .chain-arrow` | hover 流动虚线动画 |
| 成员芯片 | `.mem (.in/.group/.builtin/.dead)` | 组=胶囊形；dead=环引用禁用 |
| 抽屉助手 | `.ai-drawer` 等 | 全局注入，写操作 diff 确认卡 |
| 主题切换 | `.theme-ctl / .theme-toggle / .theme-pop` | 三态 light/dark/system |
| 分发抽屉 | `.dist-*` | 公开订阅链接，令牌按需显示 |

## 6. 关键页面契约（原型 → 路由）

| 原型 | 路由 | 不可省略的细节 |
|---|---|---|
| v2/dashboard.html | /dashboard | 订阅 URL 终端卡 + 资源大数 + 告警（**新功能，待实现**） |
| v2/base.html | /base | 全屏工作台、行号、@anchor 注入位、etag |
| v2/config.html | /config | 只读产物 + 渲染摘要双 tab |
| v2/subscriptions.html | /subscriptions | 单订阅/聚合双 tab、流量条（订阅自带数据） |
| v2/pipeline.html | /pipeline | 算子排序 + 前后对照预览 |
| v2/rule-sets.html | /rule-sets | Master-Detail、behavior 元数据、引用计数 |
| v2/proxy-groups.html | /proxy-groups | 列表页：section 分区 + rank 拖拽 + kind 筛选芯片 |
| v2/proxy-group-detail.html | /proxy-groups/[id] | 5 类型参数面板、成员来源四视角、正则实时命中、环引用置灰、引用关系侧栏、删除引用锁 |
| v2/rules.html | /rules | 锚点/类型筛选 + 实时搜索 |
| v2/chained-proxy.html | /chained-proxy | 链路图两区 |
| v2/history.html | /history | 按日时间轴、hover 撤销、AI ✦ 标记 |
| v2/assistant-settings.html | /assistant | OpenAI 兼容接入、连通测试 |
| v2/profiles.html | /profiles | 配置文件总览 + 绑定（**新功能，待实现 UI**） |
| v2/profile-settings.html | /profiles/[id] | 单配置文件绑定与设置（**新功能**） |
| v2/login.html | /login | 单字段 ADMIN_KEY、sessionStorage 说明 |

策略组语义对齐 `web/schemas/proxyGroup.ts`：kind 是编辑视角不锁字段；
single-sub 绑定在渲染时接管 filter；保存时做 dialer-proxy 环检测；
重命名级联规则 policy / 组成员 / dialer-proxy；被引用时删除阻止。

## 7. 反模式（出现即打回）

- 任何形式的延迟/测速/在线状态 UI
- 紫色渐变大背景、emoji 图标、左边框强调卡
- 一屏多个青色实心按钮；AI 紫用在助手以外
- 暖色画布混入；外阴影做层级
- 占位假数据冒充真实统计（空态就老实画空态）

## 8. 实现现状（v2 迁移）

- **已落地（设计系统底座）**：token 层 + 双主题切换 + 应用外壳（侧边栏 / topbar / 四档响应式骨架）。
  见 `web/app/globals.css`、`web/app/styles/v2-components.css`、`web/components/Sidebar.tsx`、
  `web/components/Topbar.tsx`、`web/components/theme/*`、`web/app/(authed)/layout.tsx`。
- **过渡期**：旧内容页经 `globals.css` 里的 legacy 别名块自动套 v2 配色，逐页从对应原型重皮后删除别名。
- **待办**：内容页逐页重皮；Dashboard 与 Profiles 为新功能（含 UI 与后端接线）。
