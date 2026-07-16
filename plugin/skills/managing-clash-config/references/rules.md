# 规则 CRUD

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才被读取。
> 事实来源：`web/lib/ai/actions/primitives/writes.ts`（zod 入参 + 校验）、`web/lib/services/rulesService.ts`（anchor/policy/rule-set 校验）、`web/schemas/common.ts`（规则类型枚举）、原 system prompt L16。

## 目录 (TOC)

- [范围](#范围)
- [三个工具速览](#三个工具速览)
- [add_rule 入参](#add_rule-入参)
- [update_rule 入参](#update_rule-入参)
- [delete_rule 入参](#delete_rule-入参)
- [规则类型枚举](#规则类型枚举)
- [options 修饰符](#options-修饰符no-resolve-等)
- [MATCH 无 value](#match-无-value)
- [enabled 启停](#enabled-启停)
- [policy 须已存在](#policy-须已存在)
- [anchor 须已声明](#anchor-须已声明)
- [RULE-SET 引用须先入库](#rule-set-引用须先入库)
- [base.yaml rules 块仅锚点标记](#baseyaml-rules-块仅锚点标记)
- [确认与审计](#确认与审计)
- [示例](#示例)

## 范围

分流规则的增删改：`add_rule` / `update_rule` / `delete_rule`。本项目托管全部规则，规则不写在 base.yaml 里。

## 三个工具速览

| 工具          | 作用                          | 必备前置                                                   |
| ------------- | ----------------------------- | ---------------------------------------------------------- |
| `add_rule`    | 新增一条规则到某锚点          | `policy`/`anchor` 须已存在；不确定时先 `get_base_overview` |
| `update_rule` | 改一条已存在规则的字段 / 启停 | 先 `list_rules` 拿 `id`                                    |
| `delete_rule` | 删一条已存在的手动规则        | 先 `list_rules` 拿 `id`                                    |

三者均 `risk: 'write'`，不会立即生效（见[确认与审计](#确认与审计)）。

## add_rule 入参

来自 `AddRuleInput`：

| 字段      | 类型     | 必填 | 约束 / 说明                                                                                                     |
| --------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `type`    | 枚举     | 是   | 见[规则类型枚举](#规则类型枚举)                                                                                 |
| `value`   | string   | 否\* | `max 256`；**MATCH 不需要 value**。除 DOMAIN-REGEX 可含正则里的逗号外，其它类型不得含逗号；typed payload 见下文 |
| `policy`  | string   | 是   | `min 1 / max 64`；目标策略组名或内建目标，必须已存在且不得含逗号                                                |
| `anchor`  | string   | 是   | `min 1 / max 64`；插入锚点名（prelude / manual / late 等），必须是 base.yaml 已声明的                           |
| `options` | string[] | 否   | 仅指定 5 类规则可用；只允许不重复的小写 `src` / `no-resolve`，见下文                                            |
| `enabled` | boolean  | 否   | `false`=停用（保留但不下发）；默认启用                                                                          |
| `note`    | string   | 否   | `max 256`                                                                                                       |

`preview` 阶段校验：始终校验 `anchor`+`policy`；当 `type === 'RULE-SET'` 时额外校验 `value` 指向的规则集是否在库。

## update_rule 入参

来自 `UpdateRuleInput`。除 `id` 外全部可选，但**至少要改一个字段**（否则报「至少要修改一个字段」）：

| 字段      | 类型     | 必填 | 约束 / 说明                                                                   |
| --------- | -------- | ---- | ----------------------------------------------------------------------------- |
| `id`      | uuid     | 是   | 规则 id，先用 `list_rules` 取                                                 |
| `type`    | 枚举     | 否   | 见[规则类型枚举](#规则类型枚举)                                               |
| `value`   | string   | 否   | `min 1 / max 256`                                                             |
| `policy`  | string   | 否   | `min 1 / max 64`                                                              |
| `anchor`  | string   | 否   | `min 1 / max 64`                                                              |
| `options` | string[] | 否   | 替换整个修饰符列表，传 `[]` 清空；合并后的完整规则仍须通过同一 closed grammar |
| `enabled` | boolean  | 否   | `true`=启用，`false`=停用                                                     |
| `note`    | string   | 否   | `max 256`                                                                     |

`preview` 阶段校验：仅当传了 `anchor` 或 `policy` 时才校验 anchor+policy；仅当改了 `type` 或 `value` 且改后 `type === 'RULE-SET'` 时校验规则集引用。未传的字段沿用原值（patch 语义，只覆盖显式传入的键）。

## delete_rule 入参

来自 `DeleteRuleInput`：

| 字段 | 类型 | 必填 | 说明                          |
| ---- | ---- | ---- | ----------------------------- |
| `id` | uuid | 是   | 规则 id，先用 `list_rules` 取 |

## 规则类型枚举

`type` 取值（`web/schemas/common.ts` 的 `RuleTypeSchema`，共 17 个）：

```
DOMAIN  DOMAIN-SUFFIX  DOMAIN-KEYWORD  DOMAIN-REGEX
RULE-SET  GEOIP  GEOSITE
IP-CIDR  IP-CIDR6  IP-ASN  SRC-IP-CIDR
DST-PORT  SRC-PORT
PROCESS-NAME  PROCESS-PATH
NETWORK  MATCH
```

## options 修饰符（no-resolve 等）

- 只有 `GEOIP` / `IP-ASN` / `IP-CIDR` / `IP-CIDR6` / `RULE-SET` 可带 options。
- 唯一允许值是小写 `src` 与 `no-resolve`；不得重复、不得含逗号。其它类型的 options 必须为空。
- `DOMAIN-REGEX` 的 payload 可含逗号，所以明确禁止 options，避免 fixed ParseRulePayload 把 policy 静默重排。
- `update_rule` 传 `options: []` 清空全部修饰符。

## typed payload 与分隔符

- `IP-CIDR` / `IP-CIDR6` / `SRC-IP-CIDR` 必须是合法 IP prefix；prefix bits 用规范十进制，`/024`、`/00` 等前导零写法拒绝。
- `IP-ASN` 必须是 `1..4294967295` 的纯十进制数，不写 `AS13335`。
- `SRC-PORT` / `DST-PORT` 只接受 `0..65535` 的单值或 `start-end`，多段用 `/` 分隔。
- `NETWORK` 只接受 `TCP` / `UDP`。
- `DOMAIN-REGEX` 必须落在固定 regexp2 与 JS 预览的有界安全公共子集；`[]`、`[^]`、`\u{...}` 等不兼容写法拒绝。固定规则 regex 总是 IgnoreCase，因此也拒绝 `K`、`ß`、`ẞ` 等会参与 Unicode case-fold 的非 ASCII 字符及其转义，避免折叠后产生指数回溯。
- value（DOMAIN-REGEX 除外）、policy、option 都不得含逗号；任何 C0/DEL 控制字符或会改变 YAML 单标量 round-trip 的内容也拒绝。
- `MATCH` 必须同时没有 value 和 options。

## MATCH 无 value

- `MATCH` 是兜底规则，**不需要 `value`**；`add_rule` 的 superRefine 只对非 MATCH 类型强制要求 value。
- 渲染为 `MATCH,<policy>`，一般放在 `late` 锚点收尾。

## enabled 启停

- `enabled: false` = 停用：规则保留在库但**不下发**到生效配置。
- 默认（不传 / `true`）= 启用。
- `update_rule` 用 `enabled` 切换启停，无需删除规则。

## policy 须已存在

- `policy` 必须是 base.yaml 已存在的策略：托管策略组名、或 base.yaml 里的节点 / 内建策略（DIRECT/REJECT 等）。
- 校验在 `ensureValidAnchorAndPolicy`：不存在时报 422 —— `policy "X" 不存在——既不是策略组，也不是 base.yaml 里的节点/内建策略`。
- 不确定可用值时先 `get_base_overview` 或 `list_proxy_groups`。

## anchor 须已声明

- `anchor` 必须是 base.yaml 已声明的锚点（prelude / manual / late 等）。
- 校验同样在 `ensureValidAnchorAndPolicy`：不存在时报 422 —— `anchor "X" not present in base.yaml`。

## RULE-SET 引用须先入库

让一个规则集生效是**两步**：

1. `create_rule_provider` 把规则集入库（拿到 name）。
2. `add_rule` 加一条 `RULE-SET` 规则，`value` 填该 name。

`ensureValidRuleSetRef` 会校验：`type === 'RULE-SET'` 且 `value` 不在规则集库时报 422 —— `RULE-SET 规则引用的规则集 "X" 不存在于规则集库；请先到「规则集」页创建，或从下拉中选择已有的。` 渲染时只把**被 RULE-SET 规则引用**的规则集注入下发配置。

## base.yaml rules 块仅锚点标记

- 本项目托管全部规则：base.yaml 的 `rules:` 块**只剩锚点标记、不含任何规则行**。
- 因此**禁止**用 `set_config_section` / `delete_config_section` 去改 `rules` 路径——规则改动只能走 `add_rule` / `update_rule` / `delete_rule`，否则会被系统拒绝。

## 确认与审计

- 三个写操作均不内联执行：orchestrator 先 `preview` 并铸造确认 token，用户经 `/api/v1/assistant/confirm` 授权后才 `execute`。
- 发起写操作后不要声称已改好，只简述这条改动会做什么，并提示用户在确认卡中授权。
- 三者都映射到 `rule-anchor-append` 场景经 dispatcher 落地，审计日志与撤销（inverses）随之免费获得。

## 示例

以下为 `add_rule` 的调用入参（JSON），右侧为渲染后的规则行：

```jsonc
// DOMAIN-SUFFIX → 渲染 DOMAIN-SUFFIX,openai.com,OpenAI
{ "type": "DOMAIN-SUFFIX", "value": "openai.com", "policy": "OpenAI", "anchor": "manual" }

// GEOIP（带 no-resolve 修饰符）→ 渲染 GEOIP,CN,DIRECT,no-resolve
{ "type": "GEOIP", "value": "CN", "policy": "DIRECT", "anchor": "late", "options": ["no-resolve"] }

// IP-CIDR（带 no-resolve）→ 渲染 IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
{ "type": "IP-CIDR", "value": "192.168.0.0/16", "policy": "DIRECT", "anchor": "manual", "options": ["no-resolve"] }

// RULE-SET（youtube 须已在规则集库）→ 渲染 RULE-SET,youtube,YouTube
{ "type": "RULE-SET", "value": "youtube", "policy": "YouTube", "anchor": "manual" }

// MATCH（无 value）→ 渲染 MATCH,Final
{ "type": "MATCH", "policy": "Final", "anchor": "late" }
```
