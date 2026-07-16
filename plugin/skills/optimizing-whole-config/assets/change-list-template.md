# 编号改动计划模板

> 本文件由 `plugin/skills` 渐进披露 Level 3 加载——仅当上层 `SKILL.md`（`optimizing-whole-config`）指向本文件时才读取。
> 用途：把 Plan 步骤的「编号改动清单」做成可直接复制的 checklist，保证多步优化不漏、逐条落地、逐条确认。

## 目录 (TOC)

- [何时用](#何时用)
- [可直接复制的改动计划表](#可直接复制的改动计划表)
- [列说明](#列说明)
- [类型 → 落地 action 速查](#类型--落地-action-速查)
- [确认状态图例](#确认状态图例)
- [使用说明（硬约束）](#使用说明硬约束)
- [填好的示例](#填好的示例)

## 何时用

走完 SKILL.md 的 Survey（`get_config_full` + `list_rules`）与 Audit（`references/review-checklist.md`）后，
进入 **Plan** 步骤：用**文字**给出编号清单、**先不落地**。本表是该清单的承载格式——
先整张表呈现给用户，再 **逐条** 进入 Land 步骤，每条一张确认卡。

## 可直接复制的改动计划表

```markdown
| 序号 | 类型 | 目标路径 / 规则 | 理由 | 落地 action | 确认状态 |
| ---- | ---- | --------------- | ---- | ----------- | -------- |
| 1    |      |                 |      |             | ☐ 待发起 |
| 2    |      |                 |      |             | ☐ 待发起 |
| 3    |      |                 |      |             | ☐ 待发起 |
```

- **类型** 三选一：`骨架` / `规则` / `委派spoke`。
- 一行 = 一次写操作 = 一张确认卡；**不要在一行里塞多处改动**。
- 若一项需要多个 action（如让规则集生效＝入库＋引用），拆成两行编号。

## 列说明

| 列              | 填什么            | 取值约束                                                                                                                                                                      |
| --------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 序号            | 落地顺序编号      | 整数；按依赖与风险排序（兜底/低风险先）                                                                                                                                       |
| 类型            | 改动归属          | `骨架` / `规则` / `委派spoke` 三者之一                                                                                                                                        |
| 目标路径 / 规则 | 受影响对象        | 骨架填 `get_config_section` 路径语法（如 `dns.enhanced-mode`、`tun.enable`、`sniffer`）；规则填规则文本或其 `list_rules` id；委派填目标对象（组名 / 源 + 算子 / 规则集 name） |
| 理由            | 来自 Audit 的依据 | 一句话，引到具体审查项（死规则 / 缺 MATCH 兜底 / 裸国家码 filter 等）                                                                                                         |
| 落地 action     | 实际调用的工具    | 见下「速查」；委派项写 `→ <spoke>（<action>）`                                                                                                                                |
| 确认状态        | 生命周期          | 见「确认状态图例」                                                                                                                                                            |

## 类型 → 落地 action 速查

| 类型      | 覆盖对象                                                                             | 落地 action                                                                                                                      | 归属           |
| --------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 骨架      | dns / sniffer / tun / 顶层标量等非规则、非规则集、非策略组区块                       | `set_config_section` · `delete_config_section`                                                                                   | 本 spoke 自持  |
| 规则      | 任意锚点（prelude/manual/late）下的分流规则（GEOIP / IP-CIDR / RULE-SET / MATCH 等） | `add_rule` · `update_rule` · `delete_rule`                                                                                       | 本 spoke 自持  |
| 委派spoke | 策略组（select/url-test/fallback/load-balance；遗留 relay 需迁移）                   | `→ synthesizing-proxy-groups`（`create_proxy_group` · `update_proxy_group` · `delete_proxy_group`）                              | 跨链交回 spoke |
| 委派spoke | 节点处理 / 算子（过滤 / 重命名 / 国旗 / 排序 / 去重 / 设属性…）                      | `→ editing-node-operators`（`add_operator` · `update_operator` · `delete_operator` · `reorder_operators`）                       | 跨链交回 spoke |
| 委派spoke | 规则集 / rule-providers                                                              | `→ managing-clash-config`（`create_rule_provider` · `update_rule_provider` · `delete_rule_provider` · `localize_rule_provider`） | 跨链交回 hub   |

> **让一个规则集生效要两步、拆两行**：① `→ managing-clash-config` 的 `create_rule_provider` 入库；
> ② 本 spoke 的 `add_rule` 加一条 RULE-SET 规则引用它的 name。只入库不引用，渲染时不会注入下发配置。

## 确认状态图例

| 标记          | 含义                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| ☐ 待发起      | 仅在清单里、尚未调用工具                                               |
| ⏳ 卡片待确认 | 已发起写操作，确认卡已出、等用户在卡片中授权（**此时不要声称已改好**） |
| ✅ 已落地     | 用户已确认、改动生效                                                   |
| ⏭️ 已跳过     | 用户否决或本轮不做                                                     |

## 使用说明（硬约束）

1. **一次一改**：逐行落地，每条一张确认卡，由用户逐条决定；**绝不把多处改动塞进一次调用**。
2. **读优先**：改骨架区块前先 `get_config_section` 看清现状，确保新值是完整、正确的 YAML；改地区/筛选组 filter 前先 `preview_proxy_group_members`、改算子正则前先 `preview_node_operators` 对真实节点试算。
3. **不碰禁改清单**：`proxies`（订阅源注入）与 `proxy-providers`（原样透传）不动；`rules` / `rule-providers` / `proxy-groups` 路径**禁用 config-section**，各走上表对应 action（系统会拒绝）。
4. **节点池变化则停下重 survey**：若某步改动让节点池变化（改算子过滤/排序、增删订阅源致节点增减、改名断引用等），**停下重新 `get_config_full` + `list_rules`**，据新现状修订后续编号，再继续——别拿过期快照接着改。
5. **写不立即生效**：发起写操作后只说明这条会做什么、提示在卡片中确认，把该行状态置 `⏳`；用户确认后再置 `✅`。

## 填好的示例

| 序号 | 类型      | 目标路径 / 规则                                  | 理由                                                           | 落地 action                                           | 确认状态 |
| ---- | --------- | ------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------- | -------- |
| 1    | 规则      | `MATCH,🐟 漏网之鱼`                              | late 锚点缺 MATCH 兜底，未命中流量行为未定义                   | `add_rule`                                            | ☐ 待发起 |
| 2    | 规则      | id `r_8f3a`（重复的 `DOMAIN-SUFFIX,google.com`） | 与 RULE-SET 已覆盖，死规则                                     | `delete_rule`                                         | ☐ 待发起 |
| 3    | 骨架      | `dns.enhanced-mode`                              | 当前 redir-host，改 fake-ip 更稳、减泄漏                       | `set_config_section`                                  | ☐ 待发起 |
| 4    | 委派spoke | 策略组 `OpenAI` 的 `filter`                      | 裸 `us` 会顺带吃进 R**us**sia，应改显式 ASCII 边界或国旗 emoji | `→ synthesizing-proxy-groups`（`update_proxy_group`） | ☐ 待发起 |
| 5    | 委派spoke | 规则集 `cn_ip`（入库）                           | 国内 IP 直连需新规则集承载                                     | `→ managing-clash-config`（`create_rule_provider`）   | ☐ 待发起 |
| 6    | 规则      | `RULE-SET,cn_ip,DIRECT,no-resolve`               | 引用第 5 项规则集才会注入生效                                  | `add_rule`                                            | ☐ 待发起 |
