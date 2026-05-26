# 评分体系：proxymanager /subscriptions 重设计

被评对象：本次合并 `/subscriptions` + `/collections` 的页面 + URL token 遮蔽 + 2 列网格 + 双 tab 的成果。

## 评分单元（满分 100 = 7 维度加总）

### A. Heritage Atelier 设计语言贴合度 — 20 分
- A1 (5)：所有颜色走 `var(--color-*)` token，无裸 hex（容差：错误/警示底色已知是 `#F4D8D2/40` 半透明，可接受）
- A2 (5)：字体三家分工 — Fraunces 仅用于 h1/h2，Inter 默认正文，mono 仅用于 URL/字节/技术内容
- A3 (5)：暖白四阶 + 陶土 < 5% 面积；陶土只承载主操作 + 当前选中态
- A4 (5)：边框 = 暖灰色阶提升一档；圆角节奏（pill 仅主按钮、卡 lg/12、Input md/8、Badge sm/4）

### B. UX：合并心智 + 信息密度 — 20 分
- B1 (6)：tab 切换有清晰主从结构，count 可见，状态切换无信息丢失
- B2 (6)：列表 2 列网格在桌面成立、密度合理（卡 ~95-110px 高度可同屏多看）
- B3 (4)：Collection 卡作为"快览 + 入口"职责清晰，编辑按钮跳转 master-detail 不突兀
- B4 (4)：sidebar 收回单条目入口后心智模型连贯（Sub-Store 的"订阅+聚合一页管"）

### C. 代码质量 — 20 分
- C1 (6)：TypeScript 类型严谨，无 `any` 滥用，interface/type 清晰
- C2 (5)：组件职责清晰（容器 vs 展示），无重复逻辑
- C3 (5)：复用基元（Button / Badge / InlineUrl / StatusDot）被一致使用
- C4 (4)：无死代码、无注释残骸、import 顺序整洁

### D. 正确性与鲁棒性 — 15 分
- D1 (5)：增/删/改/启停/刷新链路无 race、不丢 setBusyId
- D2 (4)：URL mask 切换不影响复制（复制始终拷完整 URL）
- D3 (3)：tab 切换不破坏 editingId / adding 的状态
- D4 (3)：错误状态 surface 到位（network、validate）

### E. 隐私 / 安全 — 10 分
- E1 (4)：URL token 默认不出现在 DOM（mask 路径替换在渲染前完成）
- E2 (3)：用户主动揭示是显式 opt-in，组件级 state，不持久化
- E3 (3)：复制按钮拷的是原文，但拷贝触发是用户动作

### F. 可访问性 / 响应式 — 10 分
- F1 (3)：所有 IconButton 有 aria-label / title；tab 按钮可键盘 focus
- F2 (3)：375px 移动宽度卡片可读、不溢出、按钮组不挤压（grid 自动退化 1 列）
- F3 (2)：焦点环、disabled cursor、reduced-motion 兼容
- F4 (2)：色对比通过 WCAG AA（陶土 on 暖白 / 米白 on dark 已在 DESIGN.md 核查过）

### G. 打磨 / 性能 — 5 分
- G1 (2)：无布局抖动（mask/reveal 切换、tab 切换无回流闪烁）
- G2 (2)：useMemo 等性能 hook 用得克制且合理（CollectionCard.members）
- G3 (1)：动效遵循 opacity-only / 220ms 规则

## 终止规则

- 单次评分 = sum(A..G)
- min(Judge S, Judge C) ≥ 95 即终止
- 否则按低分维度优化后重评

## 评委输出格式（强制）

```
SCORE: <total>/100
BREAKDOWN:
  A: x/20  — 一句话
  B: x/20  — 一句话
  C: x/20  — 一句话
  D: x/15  — 一句话
  E: x/10  — 一句话
  F: x/10  — 一句话
  G: x/5   — 一句话
TOP_ISSUES:
  1. <最影响分数的问题，附 file:line>
  2. ...
  3. ...
NICE_TO_HAVE:
  - <可选优化>
```

## 评委范围

- Judge S（subagent）：UX / 设计 / 用户路径 / 浏览器表现 — 偏重 A/B/F/G
- Judge C（codex-cli）：代码 / 类型 / 边界 / 隐私实现 — 偏重 C/D/E

但两位都给全 100 分，最终取 **min**。
