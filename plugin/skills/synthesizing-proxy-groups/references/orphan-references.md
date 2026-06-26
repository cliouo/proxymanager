# 改名 / 过滤断引用安全 playbook

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向它时才被读取。
> 横切安全主题，被 `editing-node-operators` 与 `synthesizing-proxy-groups` 两个 spoke 共同交叉引用。
> 权威来源：`web/lib/ai/systemPrompt.ts` L24、`primitives/operatorWrites.ts`、`primitives/localNodeWrites.ts`、`services/nodeReferenceService.ts`。

## 目录 (TOC)
- [范围](#范围)
- [一、节点被按名钉进哪三处](#一节点被按名钉进哪三处)
- [二、悬空的后果（尤其链式后端）](#二悬空的后果尤其链式后端)
- [三、改名 / 过滤前怎么探测影响](#三改名--过滤前怎么探测影响)
- [四、引用类型 → 一并修复工具映射](#四引用类型--一并修复工具映射)
- [五、完整演练：改名 → 检测悬空 → 连带修复](#五完整演练改名--检测悬空--连带修复)
- [六、为什么能跨 skill 调工具（同一 server，非沙箱）](#六为什么能跨-skill-调工具同一-server非沙箱)
- [七、原始权威文本（systemPrompt L24）](#七原始权威文本systemprompt-l24)

## 范围
节点是被**按名字**钉进配置里的：给节点改名或把它过滤掉，那些引用就**悬空**了。本文件讲：
钉在哪三处、悬空的后果、落地前如何探测、以及「先预警 → 提议一并改 → 取得同意 → 再落地」的标准流程。
任何会让节点名消失的写操作（算子 `rename-regex` / `filter-*`、本地源 `rename_local_node`）落地前都适用。

---

## 一、节点被按名钉进哪三处

`services/nodeReferenceService.ts` 的 `findNodeReferences(profileId, names)` 在**当前 profile 的托管配置**里
扫描三种引用，每命中一处产出一条 `NodeReference`：

| `kind` | 节点被钉在哪 | 怎么判定 | `via` 字段含义 |
|---|---|---|---|
| `chain-backend` | 链式代理的**后端节点** | 该组**设了 `dialer-proxy` 且 `proxies` 恰好只有 1 个成员**（=后端节点） | 该链式组的 `name` |
| `proxy-group-member` | 策略组的**手选成员** | 该节点出现在某组的 `proxies` 里（非链式包装） | 该组的 `name` |
| `rule-policy` | 某条规则的 **policy**（出口目标） | 规则的 `policy` 等于该节点名 | `type,value`（如 `DOMAIN-SUFFIX,netflix.com`；MATCH 等无 value 时只有 `type`） |

`NodeReference` 形状（即两条工具回包里的引用元素）：

```ts
type NodeReferenceKind = 'chain-backend' | 'proxy-group-member' | 'rule-policy';
interface NodeReference { node: string; kind: NodeReferenceKind; via: string; }
```

要点：
- 扫描范围只有**策略组 hash + 规则**（按 `profileId`）。`proxy-providers` 等不在其内（本项目不碰）。
- 空 names 数组直接返回 `[]`、不发起读取。
- 自动注入的成员（`filter` / `all` / `single-sub` / `collection-scope` 类组渲染时算成员）不算手选，
  其 `proxies` 是渲染期算的、不会被这里当 `proxy-group-member` 计入——会被计入的是**手填进 `proxies` 的名字**。

---

## 二、悬空的后果（尤其链式后端）

> systemPrompt L24 原文：节点是被**按名字**钉进链式代理后端 / 策略组成员 / 规则 policy 的——给节点改名 /
> 过滤掉（算子或本地改名）会让这些引用悬空，**其中链式代理后端悬空会让整份配置在 mihomo 里加载失败**。

按严重度：

| 悬空引用 | 后果 |
|---|---|
| `chain-backend` 悬空 | **最锋利**：链式后端指向一个已不存在的节点名，整份下发配置在 mihomo **加载失败**、用户配置直接打不开。 |
| `proxy-group-member` 悬空 | 该组里多出一个指向不存在节点的死成员，组退化 / 选不到该出口。 |
| `rule-policy` 悬空 | 该规则的出口目标失效，命中后无处可去。 |

> 渲染侧对「断掉的链式包装」留了一层兜底裁剪（resolve 的 broken-wrap pruning，见
> `nodeReferenceService.ts` 头注），但**不要依赖它**——预警 + 连带修复才是正道，且只有它能挽回组成员 / 规则 policy 的语义。

---

## 三、改名 / 过滤前怎么探测影响

有**两条**探测路径，分别对应两类改名入口，回包里现成带好引用清单——落地前必看：

### A. 算子路径（远程/本地源的 `filter-*` / `rename-regex`）→ `preview_node_operators`

`preview_node_operators` 把整条候选算子管线对该源真实节点试算，回包关键字段：

| 字段 | 含义 |
|---|---|
| `before` / `after` | `{ count, names, truncated }`（names 上限 300，超出 `truncated:true`） |
| `steps` | 每个算子的 before/after/dropped/changed 跟踪 |
| `orphanedReferences` | **处理前有、处理后没了**（被改名或被过滤掉）的节点名所命中的 `NodeReference[]` |
| `orphanWarning` | 仅当 `orphanedReferences` 非空时出现，固定文案（见下） |

`orphanWarning` 固定文案（出现即必须照做）：

```
⚠️ 这些节点改名/被过滤后，会让链式代理后端、策略组成员或规则的引用悬空(尤其 chain-backend 会导致整份配置无法加载)。落地前请提醒用户，并提议一并更新这些引用。
```

> 「消失」= 名字在 `before` 出现、在 `after` 不再出现——**改名**（旧名消失、新名出现）与**过滤掉**都算。

### B. 本地源直接改名路径 → `list_local_nodes`

`list_local_nodes` 列本地源（`kind=local`）节点，**仅 name + type，凭证已脱敏**；每个节点带 `referencedBy`：

```jsonc
{ "source": "...", "count": N,
  "nodes": [ { "name": "HK-01", "type": "ss",
              "referencedBy": [ { "kind": "chain-backend", "via": "网飞-链式" } ] } ] }
```

`referencedBy` 是该节点命中的引用数组（元素同 `NodeReference`，但按节点分组、省略 `node` 字段）。
**改名前若某节点 `referencedBy` 非空，务必预警并提议一并更新。**

---

## 四、引用类型 → 一并修复工具映射

预警之后、取得同意，按 `kind` 各自连带修复（**都需用户确认，逐个出确认卡**）：

| `orphanedReferences[].kind` | 用 `via` 定位 | 一并修复工具 | 改什么 |
|---|---|---|---|
| `chain-backend` | 链式组 name（`list_proxy_groups` 按 name 拿 id） | `update_proxy_group` | 把该链式组的后端指向改成新节点名 |
| `proxy-group-member` | 组 name（`list_proxy_groups` 按 name 拿 id） | `update_proxy_group` | 把该组手选 `proxies` 里的旧名换成新名 |
| `rule-policy` | `type,value`（`list_rules` 找到对应规则的 id） | `update_rule` | 把该规则 policy 改成新名 |

> `update_proxy_group` / `update_rule` 都按 **id** 定位（入参 `id` 是 uuid）；`via` 给的是 name / `type,value`，
> 须先用 `list_proxy_groups` / `list_rules` 换成 id 再调。

> 重要区分：**策略组改名**（`update_proxy_group` 改组的 `name`）会**自动级联**改写引用它的其它组与规则（systemPrompt L18）；
> 但**节点改名**（算子 / `rename_local_node`）**不会自动级联**——必须按上表手动连带修复。别把两者搞混。

---

## 五、完整演练：改名 → 检测悬空 → 连带修复

场景：用户想把本地源里的节点 `HK-01` 改名为 `香港-高级线路`。

1. **拿 id、确认形态** — `list_node_sources` 找到该本地源，确认 `kind=local`（远程源不能直接改名，须改用 `rename-regex` 算子）。
2. **探测影响** — `list_local_nodes(id)`，读 `HK-01` 的 `referencedBy`，假设得到：
   ```json
   [ { "kind": "chain-backend",       "via": "网飞-链式" },
     { "kind": "proxy-group-member",  "via": "手选-港区" },
     { "kind": "rule-policy",         "via": "DOMAIN-SUFFIX,netflix.com" } ]
   ```
3. **先预警，别闷头改** — 明确告诉用户：改名会断这 3 处引用，**其中 `网飞-链式` 是链式后端、不一并改会让整份配置在 mihomo 加载失败**。
4. **提议一并改，取得同意** — 提出连带修复清单：
   - `rename_local_node(id, from:"HK-01", to:"香港-高级线路")` — 改源内容、仅动 name、凭证原样保留。
   - `update_proxy_group(<"网飞-链式" 的 id>, …)` — 后端 `proxies:["HK-01"]` → `["香港-高级线路"]`（`chain-backend`；先用 `list_proxy_groups` 拿 id）。
   - `update_proxy_group(<"手选-港区" 的 id>, …)` — 手选成员里旧名换新名（`proxy-group-member`）。
   - `update_rule(<该规则 id>, policy:"香港-高级线路")` — `list_rules` 按 `DOMAIN-SUFFIX,netflix.com` 找到 id 后改 policy。
5. **逐个落地** — 每个写操作各出一张确认卡，由用户亲自授权后才执行；发起后只说明会做什么、提示在卡片确认，**不要声称已改好**。

> 算子路径完全同理：把第 2 步换成 `preview_node_operators`（看 `orphanedReferences` / `orphanWarning`），
> 第 4 步把改名动作换成 `add_operator` / `update_operator`，修复工具不变。

---

## 六、为什么能跨 skill 调工具（同一 server，非沙箱）

本文件的修复动作横跨多个 skill 的工具：`rename_local_node` / `update_operator`（`editing-node-operators`）、
`update_proxy_group`（`synthesizing-proxy-groups`）、`update_rule`（hub 本体）。这没问题——

- 所有工具都挂在**同一个 `proxymanager` MCP server** 上；不同 skill 只是把工具**按职责归类**，**不是沙箱**。
- 修复孤儿引用时，你可以照常调用名义上属于别的 skill 的工具（`update_proxy_group` / `update_rule`），它们在同一 server、随时可调。
- 因此「改名 + 连带修复」可以在一轮里跨域完成，无需切换或重新加载 skill。

---

## 七、原始权威文本（systemPrompt L24）

> **改名会断引用，务必预警**：节点是被**按名字**钉进链式代理后端 / 策略组成员 / 规则 policy 的——
> 给节点改名 / 过滤掉（算子或本地改名）会让这些引用悬空，**其中链式代理后端悬空会让整份配置在 mihomo 里加载失败**。
> 所以改名前：用 `preview_node_operators`（算子路径，看返回的 `orphanedReferences` / `orphanWarning`）
> 或 `list_local_nodes`（本地路径，看每个节点的 `referencedBy`）确认影响；**若有引用，先明确告诉用户会断哪些，
> 并提议一并更新（链式代理改后端指向、策略组改成员、规则改 policy），取得同意再落地**，不要闷头改完导致用户配置打不开。
