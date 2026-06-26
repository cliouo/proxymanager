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
| 工具 | 作用 | 必备前置 |
|---|---|---|
| `add_rule` | 新增一条规则到某锚点 | `policy`/`anchor` 须已存在；不确定时先 `get_base_overview` |
| `update_rule` | 改一条已存在规则的字段 / 启停 | 先 `list_rules` 拿 `id` |
| `delete_rule` | 删一条已存在的手动规则 | 先 `list_rules` 拿 `id` |

三者均 `risk: 'write'`，不会立即生效（见[确认与审计](#确认与审计)）。

## add_rule 入参
来自 `AddRuleInput`：

| 字段 | 类型 | 必填 | 约束 / 说明 |
|---|---|---|---|
| `type` | 枚举 | 是 | 见[规则类型枚举](#规则类型枚举) |
| `value` | string | 否* | `max 256`；域名 / IP-CIDR / 规则集名等。**MATCH 不需要 value**；非 MATCH 必须填（`superRefine`：空白会报「非 MATCH 规则必须填写 value」） |
| `policy` | string | 是 | `min 1 / max 64`；目标策略组名，必须是 base.yaml 已存在的 |
| `anchor` | string | 是 | `min 1 / max 64`；插入锚点名（prelude / manual / late 等），必须是 base.yaml 已声明的 |
| `options` | string[] | 否 | `max 8`，每项 `max 64`；规则修饰符，如 `["no-resolve"]`，拼在规则末尾 |
| `enabled` | boolean | 否 | `false`=停用（保留但不下发）；默认启用 |
| `note` | string | 否 | `max 256` |

`preview` 阶段校验：始终校验 `anchor`+`policy`；当 `type === 'RULE-SET'` 时额外校验 `value` 指向的规则集是否在库。

## update_rule 入参
来自 `UpdateRuleInput`。除 `id` 外全部可选，但**至少要改一个字段**（否则报「至少要修改一个字段」）：

| 字段 | 类型 | 必填 | 约束 / 说明 |
|---|---|---|---|
| `id` | uuid | 是 | 规则 id，先用 `list_rules` 取 |
| `type` | 枚举 | 否 | 见[规则类型枚举](#规则类型枚举) |
| `value` | string | 否 | `min 1 / max 256` |
| `policy` | string | 否 | `min 1 / max 64` |
| `anchor` | string | 否 | `min 1 / max 64` |
| `options` | string[] | 否 | `max 8`；替换整个修饰符列表，传 `[]` 清空 |
| `enabled` | boolean | 否 | `true`=启用，`false`=停用 |
| `note` | string | 否 | `max 256` |

`preview` 阶段校验：仅当传了 `anchor` 或 `policy` 时才校验 anchor+policy；仅当改了 `type` 或 `value` 且改后 `type === 'RULE-SET'` 时校验规则集引用。未传的字段沿用原值（patch 语义，只覆盖显式传入的键）。

## delete_rule 入参
来自 `DeleteRuleInput`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | uuid | 是 | 规则 id，先用 `list_rules` 取 |

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
- `options` 是规则修饰符数组，渲染时拼在规则行末尾（如 `GEOIP,CN,DIRECT,no-resolve`）。
- 最多 8 项，每项最长 64 字符。
- `update_rule` 传 `options: []` 清空全部修饰符。
- 各修饰符的具体语义（如 `no-resolve` 跳过 DNS 解析）属内核行为，按需用 `search_mihomo_docs` 查官方文档，不要凭记忆臆测。

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
