# 整体审查清单 (review checklist)

> 本文件由 plugin/skills 渐进披露 **Level 3** 加载：仅当上层 `SKILL.md` 的 Audit 步指向本文件时才读取。
> 配套：`assets/change-list-template.md`（把审出的问题落成编号改动计划）。

## 目录 (TOC)

- [用法](#用法)
- [工具速查（看什么 / 用哪个读）](#工具速查看什么--用哪个读)
- [审查项](#审查项)
  - [1. DNS 合理性](#1-dns-合理性)
  - [2. 规则顺序 / 锚点](#2-规则顺序--锚点)
  - [3. 死规则](#3-死规则)
  - [4. 重复规则](#4-重复规则)
  - [5. 组引用完整性](#5-组引用完整性)
  - [6. 地区覆盖](#6-地区覆盖)
  - [7. MATCH 兜底](#7-match-兜底)
  - [8. 规则集 referenced 计数](#8-规则集-referenced-计数)
  - [9. 裸国家码 filter](#9-裸国家码-filter)
  - [10. 孤儿引用](#10-孤儿引用)
- [审完之后](#审完之后)

## 用法

逐项过一遍，把 `- [ ]` 当 checkbox 用：命中问题 → 记进编号改动清单（先不落地）。
每项都标了**用哪个工具检测**和**判据**。mihomo/clash 的内核行为（匹配顺序、字段语义）
凡有疑问一律先 `search_mihomo_docs` 核实，不要凭记忆断言。

- 本 spoke **自有**写/读工具：`get_config_full` · `list_rules` · `set_config_section` · `delete_config_section` · `add_rule` · `update_rule` · `delete_rule`。
- 其余 `list_*` / `preview_*` 为 hub 共享**只读**面，按需读取，不改配置。

## 工具速查（看什么 / 用哪个读）

| 工具                          | 能看到什么                                                                                                                  | 注意                                                           |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `get_config_full`             | 完整下发 YAML（脱敏）= 骨架 + 注入各锚点的**生效**规则 + enabled 源注入节点                                                 | **无规则 id、不含已停用规则**；要 id / 停用规则用 `list_rules` |
| `list_rules`                  | 每条 `id/type/value/policy/anchor/options/enabled/source/note`，可按 `anchor` 过滤                                          | `enabled=false` = 已停用、不下发                               |
| `get_config_outline`          | 顶层区块 + 子键 / 具名条目（dns 子键、sniffer/tun、端口、proxy-groups、rule-providers）；`rules` 仅给条数                   | 规则正文不在此                                                 |
| `get_config_section(path)`    | 某区块 YAML。path：map 用点 `dns` / `dns.enhanced-mode`；具名序列 `proxy-groups[OpenAI]`                                    | `proxies` / `proxy-providers` 自动脱敏为 `***`                 |
| `get_base_overview`           | `anchors` / `policies` / `proxyProviders` / `ruleProviders`(规则集名)                                                       | 不含订阅源注入的节点                                           |
| `list_proxy_nodes`            | 渲染后**真实**节点名 + `collisions`（跨源同名）                                                                             | 快照缺失时返回空，需先触发一次渲染                             |
| `list_proxy_groups`           | 组 `id/name/type/kind/proxies/filter/exclude-filter/dialer-proxy/bound_subscription_id/bound_collection_id/...` + templates | `single-sub` / collection-scope 组成员**渲染时算**，不手填     |
| `list_rule_providers`         | `id/name/source/format/behavior/url/interval/note` + `referenced`（被几条 RULE-SET 规则引用）                               | `referenced=0` = 没有任何规则引用它                            |
| `preview_proxy_group_members` | 给定 `filter`(+`exclude_filter`) 对真实节点名试算的命中名 + 数量；可传组 `id` 或候选正则                                    | 只读、不改配置                                                 |
| `preview_node_operators`      | 算子管线 before/after + 每步增删改 + `orphanedReferences` / `orphanWarning`                                                 | 改正则 / 算子前必跑                                            |
| `list_local_nodes`            | 本地源节点 `name + type + referencedBy`（凭证已脱敏）                                                                       | 仅 `kind=local` 源，远程源调用报错                             |

## 审查项

### 1. DNS 合理性

- [ ] `dns` 区块存在且 `enable` 合预期；`enhanced-mode` / `nameserver` / `fake-ip-range` / `fake-ip-filter` 等子键取值合理。
- **检测**：`get_config_outline` 看 `dns` 有哪些子键 → `get_config_section(dns)` 读全文（或 `get_config_section(dns.enhanced-mode)` 精确钻取）。整体视角也可在 `get_config_full` 里看。
- **判据**：字段名 / 取值是否符合 mihomo 语义——拿不准用 `search_mihomo_docs` 核对，不要臆造字段名。
- **落地**：`set_config_section(dns…)` / `delete_config_section`。

### 2. 规则顺序 / 锚点

- [ ] 规则在各锚点（`prelude` / `manual` / `late`）内的先后合理；高频精确规则不被前面的宽泛规则抢先命中。
- **检测**：`list_rules`（每条带 `anchor`，按锚点查看分组与顺序）；`get_config_full` 看**跨锚点拼接后的最终下发顺序**（锚点按 prelude→manual→late 注入）。
- **判据**：mihomo 自上而下匹配、命中即停（确切行为以 `search_mihomo_docs` 为准）；越具体的规则应越靠前。

### 3. 死规则

- [ ] 没有**永远命中不到**的规则：排在 `MATCH` 之后的任何规则、或被前面更宽规则完全覆盖（shadow）的规则。
- **检测**：`get_config_full` 看最终顺序，定位 `MATCH` 位置 → 其后规则即死规则；`list_rules` 对照 `anchor`/顺序与 `enabled`。
- **注意**：`enabled=false` 的规则本就不下发（存着但不生效），与「死规则」区分——后者是**生效却到不了**。
- **落地**：`delete_rule` 删，或 `update_rule` 调位置 / 改 enabled。

### 4. 重复规则

- [ ] 没有同 `type`+`value` 的冗余条目（完全相同 = 纯冗余；同 type+value 但 `policy` 不同 = 后者被前者遮蔽 / 策略冲突）。
- **检测**：`list_rules` 拉全量，按 `type`+`value` 比对；拿到 `id` 以便后续删改。
- **落地**：`delete_rule` 删冗余；冲突项保留正确的那条。

### 5. 组引用完整性

- [ ] 每个组 `proxies` 里列的名字、以及规则 `policy`，都能解析到**存在的节点**或**另一个存在的组名**，没有指向空气。
- **检测**：`list_proxy_groups` 取各组 `proxies` / `dialer-proxy`；`list_rules` 取每条 `policy`；与 `list_proxy_nodes`（真实节点名）+ 组名集合**交叉比对**。
- **注意**：`kind=single-sub`（`bound_subscription_id`）与 collection-scope（`bound_collection_id`）组成员是**渲染时算**的，别拿「proxies 为空」当问题。
- **注意**：`list_proxy_nodes` 快照缺失时为空——先让用户打开「最终配置」预览触发一次渲染，再做引用核对，否则会误判全部悬空。

### 6. 地区覆盖

- [ ] 每个地区组（HK/JP/US/SG…）的 `filter` 确实能筛到节点，没有空组；想覆盖的地区都有对应组与命中。
- **检测**：`list_proxy_groups` 取各地区组 `filter`/`exclude-filter` → `preview_proxy_group_members(id=…)` 试算命中数；`list_proxy_nodes` 看真实节点里实际有哪些地区。
- **判据**：命中数为 0 = 空组（filter 写错或该地区无节点）；地区组集合应覆盖节点池里的主要地区。

### 7. MATCH 兜底

- [ ] 规则链**最后一条是 `MATCH`**（无 value 的兜底规则），保证未命中流量有归宿。
- **检测**：`get_config_full` 看最终下发的最后一条是否为 `MATCH`；`list_rules` 确认存在一条 `type=MATCH`（`value` 为空、带 `policy`）。
- **注意**：`MATCH` 之后不应再有规则（见 [3. 死规则](#3-死规则)）。
- **落地**：缺失则 `add_rule`（type=MATCH，仅给 policy，无 value）。

### 8. 规则集 referenced 计数

- [ ] 规则集库里没有「**没人引用**」的死规则集；每条 RULE-SET 规则引用的 `name` 都在库中存在。
- **检测**：`list_rule_providers` 看每条的 `referenced`（被多少条 RULE-SET 规则引用）；与 `list_rules` 里 `type=RULE-SET` 的 `value` 交叉。
- **判据**：
  - `referenced=0` → 入了库却没规则用它（删掉，或补一条 `add_rule` RULE-SET 引用它的 `name`）。
  - RULE-SET 规则的 `value` 不在 `list_rule_providers` 的 `name` 集合里 → 引用了不存在的规则集（孤儿规则，见 [10](#10-孤儿引用)）。
- **注意**：让规则集生效是**两步**——先 `create_rule_provider` 入库，再 `add_rule` 加 RULE-SET 引用其 `name`；渲染时只注入**被引用**的规则集。

### 9. 裸国家码 filter

- [ ] 组的 `filter` 没有用**裸两位国家码**（如 `us`）做子串匹配——会顺带吃进 `A-us-tralia` / `R-us-sia` 等。
- **检测**：`list_proxy_groups` 扫各组 `filter` 找裸码 → `preview_proxy_group_members` 试算，确认有没有误命中。
- **修复方向**：改用显式 ASCII 边界 `(?<![A-Za-z])US(?![A-Za-z])` 或国旗 emoji 锚定；产品拒绝 JS/regexp2 语义不同的 `\b`。
- **落地**：策略组 filter 改动**交回 `synthesizing-proxy-groups` spoke** 走 `update_proxy_group`（本 spoke 不直接改组）。

### 10. 孤儿引用

- [ ] 没有按名字钉死、但目标已不存在的引用：**链式代理后端**（组 `dialer-proxy`）/ **策略组成员**（组 `proxies`）/ **规则 policy**。改名 / 算子过滤会把它们打成悬空。
- **检测**：
  - 改算子前：`preview_node_operators` 看返回的 `orphanedReferences` / `orphanWarning`。
  - 改本地源节点名前：`list_local_nodes` 看每个节点的 `referencedBy`。
  - 现状核对：把组 `proxies`/`dialer-proxy` + 规则 `policy` 对 `list_proxy_nodes` 真实节点名交叉比对。
- **判据 / 严重度**：**链式代理后端悬空会让整份配置在 mihomo 里加载失败**（最高优先级）；组成员 / 规则 policy 悬空会让该项失效。
- **纪律**：发现影响**先告知用户会断哪些引用**、提议一并更新（改后端指向 / 改组成员 / 改规则 policy），取得同意再落地；不要闷头改完导致配置打不开。

## 审完之后

- 把命中的问题汇成一份**编号改动清单**（套 `assets/change-list-template.md`），逐条写建议 + 理由，**先不落地**。
- 逐条落地、**一次一改**、一张确认卡：骨架 → `set_config_section`/`delete_config_section`；规则 → `add_rule`/`update_rule`/`delete_rule`；**策略组 / 算子改动交回各自 spoke**。
- 任一改动让节点池变化（删源 / 改算子 / 改名）→ **停下重新 survey**（`get_config_full` + `list_proxy_nodes`），再继续后续项。
