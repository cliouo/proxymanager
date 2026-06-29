---
name: editing-node-operators
description: >-
  Builds, reorders, and previews the node-processing operator pipeline on
  subscription sources and aggregate subscriptions in ProxyManager — regex
  filter, rename-regex, remove-useless, dedup, sort, flag-emoji, type/region
  filter, set-property (udp/tfo/skip-cert) — where array order changes the
  result, AND owns ALL node renaming including direct local-source node
  renames. Use when the user filters, renames, dedups, sorts, or flags nodes,
  cleans up a subscription's node list, batch-renames remote-source nodes,
  renames a node in a local source, or mentions 算子 / 节点处理 / 重命名 /
  改名 / 去重 / 加旗 / 排序 / 类型过滤 / 地区过滤. Always previews the whole
  pipeline against real nodes before changing a regex (order matters), and
  warns that renaming or filtering a node orphans chain-proxy backends / group
  members / rule policies pinned to it by name — a dangling chain backend makes
  the entire config fail to load. Deep-dive spoke of the managing-clash-config hub.
---

# 节点处理 / 算子 + 改名 (spoke)

**安全地板**（完整横切护栏在 `managing-clash-config` hub）：节点凭证已脱敏为 `***`，不获取不猜测；
写不立即生效，服务端出确认卡、用户授权才执行，发起后别声称已改好；先 `search_mihomo_docs` 再答
mihomo 写法。这些 load-bearing 部分由服务端强制。

本 spoke **独占所有改名**：远程源走 `rename-regex` 算子，本地源走 `rename_local_node`，批量改名
两者皆可。

## 1. 管线模型

订阅源与聚合订阅的「节点处理」管线：算子按**数组顺序依次作用**，顺序影响结果
（先重命名再过滤 ≠ 先过滤再重命名）。算子只**过滤 / 改写 / 排序已有节点，绝不新增节点**——
要真正多 / 少节点仍得改订阅源本身。

### 算子 kind 速查（9 种 · 完整字段与示例见 `references/operator-kinds.md`）

| kind | 作用 | 关键参数 |
|------|------|----------|
| `filter-regex` | 按名称正则保留 / 丢弃 | `mode` keep·drop · `pattern` |
| `filter-useless` | 去掉流量 / 到期 / 官网等说明性节点 | `extra`（追加关键词）|
| `rename-regex` | 按正则改名（`replacement` 留空 = 删名段）| `pattern` · `replacement`（`$1` 引用捕获组）|
| `flag-emoji` | 按地区码加 / 去国旗 | `action` add·remove · `tw2cn`（台湾显 🇨🇳）|
| `filter-type` | 按协议类型保留 / 丢弃 | `mode` · `types` |
| `filter-region` | 按地区码保留 / 丢弃 | `mode` · `regions: [HK, JP, US]` |
| `dedup` | 重复节点去重 / 编号 | `by` name·server-port · `action` drop·rename |
| `sort` | 排序 | `by` name·type·server·region · `order` asc·desc |
| `set-prop` | 强制 udp / tfo / skip-cert | `udp` · `tfo` · `skipCertVerify` |

典型清洗管线顺序：`filter-useless` → `rename-regex`（去前缀）→ `filter-region` → `flag-emoji`（台湾加 `tw2cn`）→ `dedup` → `sort`。

## 2. 改正则前必做 preview

**改任何正则前必须** `preview_node_operators` 把整条候选管线对该源真实节点试算：看 before/after、
每步 dropped/changed、以及 `orphanedReferences` / `orphanWarning`。

## 3. flag-emoji 地区码

`flag-emoji` 按节点名里的地区码识别国旗，**alpha-2(HK/JP/SG) 与 alpha-3(HKG/JPN/SGP) 两种都认**，
所以把节点统一命名成 3 位地区码也能正确加旗，不必为加旗手动转两位。

## 4. 本地 vs 远程改名

- **远程源**：节点来自上游、不可直接编辑，用 `rename-regex` 算子。对远程源调用
  `rename_local_node` 会被服务端拒绝（返回 422）——远程源没有可直接编辑的本地节点。
- **本地源**（kind=local，内容用户自填）：可直接改源内容——`list_local_nodes` 列其节点
  （只给 name+type+referencedBy，**凭证已脱敏**）、`rename_local_node` 改某节点名（永久生效，仅动
  name 字段、其它配置与密码原样保留，需确认）。本地源要批量 / 按正则改名也可用 `rename-regex` 算子。

## 5. 改名断引用安全（关键句，直接复述防漏）

节点是被**按名字**钉进**链式代理后端 / 策略组成员 / 规则 policy**的。给节点改名 / 过滤掉会让这些
引用悬空，**其中链式代理后端悬空会让整份配置在 mihomo 里加载失败**。所以改名前：

1. `preview_node_operators`（算子路径，看 `orphanedReferences`）或 `list_local_nodes`（本地路径，
   看每个节点的 `referencedBy`）确认影响；
2. 若有引用，**先明确告诉用户会断哪些**，并提议一并更新（链式改后端、组改成员=`update_proxy_group`、
   规则改 policy=`update_rule`，均同一 MCP server 可调），取得同意再落地；
3. 不要闷头改完导致用户配置打不开。详见 hub 的 `references/orphan-references.md`。

## 6. 算子语义

- `add_operator` 可指定 position；
- `update_operator` 整条替换同位同 id（可借此换 kind）；
- `delete_operator` 删一步；
- `reorder_operators` 须传现有 id 的全排列。

## 拥有的工具

`list_node_sources` · `preview_node_operators` · `add_operator` · `update_operator` ·
`delete_operator` · `reorder_operators` · `list_local_nodes` · `rename_local_node` · `list_proxy_nodes`

## 参考资料

- `references/operator-kinds.md` — 每种算子 kind + 参数 + 示例；顺序影响；flag alpha-2/alpha-3
- `references/rename-recipes.md` — rename-regex cookbook、地区码归一化、本地源直接改名、与加旗的顺序配合
