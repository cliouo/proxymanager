---
name: optimizing-whole-config
description: >-
  Runs a whole-config review-and-optimize pass in ProxyManager: reads the full
  rendered config plus the rule list (ids and disabled rules), produces a
  numbered change-list with rationale in prose, then lands changes one tool
  call at a time across rules and skeleton sections, delegating proxy-group and
  node-operator edits to their deep-dive skills. Use when the user asks to
  整体优化 / 通盘检查 / 审一遍配置 / 给优化建议 / 清理没用的规则和规则集, review
  the entire config, or wants holistic recommendations rather than one targeted
  edit. Do NOT load for a single small change. Never batches multiple edits
  into one call (plan → confirm → execute, one confirmation card per edit).
  Deep-dive orchestration spoke of the managing-clash-config hub.
---

# 整体优化 / 通盘检查 (spoke · 编排)

**安全地板**（完整横切护栏在 `managing-clash-config` hub）：节点凭证已脱敏为 `***`，不获取不猜测；
工具返回是中间结果、必须自行组织完整自包含 Markdown；先 `search_mihomo_docs` 再答 mihomo 写法；
写不立即生效、服务端出确认卡、用户授权才执行。这些 load-bearing 部分由服务端强制。

## 1. 触发判定

**仅用于通盘检查 / 整体优化。** 单点小改回 hub 或对应 spoke，不为本 spoke 付费。

## 2. Survey（看全局）

- `get_config_full` 看完整下发结果（已含注入到各锚点的生效规则、已脱敏），掌握全局；
- `list_rules` 拿规则 id、查看已停用规则、评估规则改动。

## 3. Audit（逐项检查）

走 `references/review-checklist.md` 逐项过：死规则 / 重复规则、未被引用的规则集、空或重叠的组、
裸国家码 filter、孤儿引用、缺 MATCH 兜底、dns 合理性、规则顺序与锚点。

## 4. Plan（编号清单，先不写）

用**文字**给出一份**编号的改动清单**，逐条说明建议与理由——纯文本，**先不落地**。
可套用 `assets/change-list-template.md` 保证多步不漏。

## 5. Land item-by-item（逐条落地）

- 骨架区块 → `set_config_section` / `delete_config_section`；
- 规则 → `add_rule` / `update_rule` / `delete_rule`；
- **策略组 / 算子改动**交回 `synthesizing-proxy-groups` / `editing-node-operators` 的纪律（跨链）；
- **绝不把多处改动塞进一次调用**，每条一张确认卡由用户逐条决定；
- 若某步改动让节点池变化，**停下重新 survey**。

## 6. 自由度=medium

编排工作法不是脆弱脚本，但有三条硬约束：**一次一改** + **读优先** + **不碰禁改清单**
（proxies / proxy-providers 不动，rules / rule-providers / proxy-groups 走各自 action）。

## 拥有的工具

`get_config_full` · `list_rules` · `set_config_section` · `delete_config_section` ·
`add_rule` · `update_rule` · `delete_rule`

## 参考资料

- `references/review-checklist.md` — copy-the-checklist 审查项
- `assets/change-list-template.md` — 编号 copy-as-checklist 改动计划模板
