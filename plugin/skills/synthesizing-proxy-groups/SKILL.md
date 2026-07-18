---
name: synthesizing-proxy-groups
description: >-
  Designs and edits clash/mihomo proxy-groups (策略组) in ProxyManager —
  choosing the kind (raw escape-hatch / manual hand-pick / filter
  include-all+regex / all / single-sub bound source / collection-scope),
  composing members, and validating filter and exclude-filter against live
  node names before writing. Use when the user creates, renames, deletes, or
  changes a proxy-group's members, filter, or exclude-filter; mentions 策略组 /
  地区组 / 筛选组 / select / url-test / fallback / load-balance / relay; or
  reports a group catching the wrong nodes (a bare "us" swallowing
  A-us-tralia / R-us-sia). Always previews members before any filter change
  (explicit ASCII lookaround or flag-emoji anchoring). Deep-dive spoke of the
  managing-clash-config hub.
---

# 策略组合成器 (spoke)

**安全地板**（完整横切护栏在 `managing-clash-config` hub）：节点密码 / 订阅 URL 已脱敏为 `***`，
不获取不猜测；写不立即生效，服务端出确认卡、用户授权才执行，发起后别声称已改好；先 `search_mihomo_docs`
再答 mihomo 写法。这些 load-bearing 部分由服务端强制。

管理 select / url-test / fallback / load-balance 路由分组。固定 Mihomo v1.19.28 已移除 relay；
遇到遗留 relay 时应迁移为具体节点上的 `dialer-proxy` 链式代理，而不是继续下发 relay。策略组已从 base.yaml 抽到
`proxy-groups` Redis hash，base 只剩 `# === PROXY-GROUPS ===` 标记。

## 1. kind 五种有效形态 + 一种遗留绑定

每个组带 `kind` 字段标记 UI 预设形态（字段矩阵见 `references/kind-taxonomy.md`）：

- `raw` — 逃生口，整组按字面写
- `manual` — 手选 proxies
- `filter` — 纳入全部再用正则筛
- `all` — 全部节点
- `single-sub` — 绑一个订阅源，用 `bound_subscription_id`，成员=该源处理后的节点直接列为 proxies
  （无 node_prefix、不自动生成 filter）
- `collection-scope` 类 — 用 `bound_collection_id` 自动生成 proxies

> `single-sub` / 遗留 `collection-scope` 的成员是**渲染时算的**，别手填 filter / proxies；绑定缺失或本轮没有存活节点会拒绝整次渲染。无显式成员的动态组默认使用 `empty-fallback: REJECT`。

> 另一根正交轴是 `type`（健康检查行为）：`select` 手动切换、**无健康检查**；`url-test` 自动选速；
> `fallback` 有序故障转移；`load-balance` 多路分流。后三种健康检查类型需配 `url`+`interval`。
> 链式代理由渲染器把单后端 wrap 转成带 `dialer-proxy` 的 concrete proxy，不是 proxy-group type。

## 2. 成员合成三来源

手选 `proxies` ｜ `include_all_proxies` + `filter` ｜ 绑定来源自动算。

## 3. filter 字母边界坑（本 spoke 招牌）

裸 `us` 会顺带吃进 A-**us**-tralia / R-**us**-sia。三种锚定策略（优先级递减）：

| 场景                        | 写法                          | 说明                                 |
| --------------------------- | ----------------------------- | ------------------------------------ | ---------------- | -------------------- | --------------------------------- |
| 节点含旗帜 emoji 或中文地名 | `🇺🇸                           | United States                        | 美国`            | 绕开字母子串，最安全 |
| 只有字母缩写                | `(?<![A-Za-z])US(?![A-Za-z])` | 显式 ASCII 边界挡住 Australia/Russia |
| 双代码地区（英国 UK/GB）    | `(?<![A-Za-z])(?:UK           | GB                                   | GBR)(?![A-Za-z]) | 英国`                | 同时认 UK/GB/GBR，不误命中 `80GB` |

固定 Mihomo v1.19.28 的组筛选引擎是 `dlclark/regexp2`，不是 RE2。产品预览只接受
JS/固定 regexp2 的有界安全交集：可用环视，但拒绝两边语义不同的 `\b` / `\w` /
`\d` / `\s` / `\p`。多条独立模式用反引号分隔，不要当成普通 `|`。

**纯中文命名陷阱**：真实节点池常有只含中文地名、无任何 ASCII 缩写的节点（如「日本 东京 02」「新加坡 狮城」）。
只写 `JP|JPN` / `SG|SGP` 会漏掉它们——filter 必须**同时含中文别名**。常用模板：

| 地区   | filter  |
| ------ | ------- | ------ | ------------------------------ | ------------------------------ |
| 美国   | `(?i)🇺🇸 | 美国   | (?<![A-Za-z])USA?(?![A-Za-z])` |
| 日本   | `(?i)🇯🇵 | 日本   | (?<![A-Za-z])JPN?(?![A-Za-z])` |
| 香港   | `(?i)🇭🇰 | 香港   | (?<![A-Za-z])HKG?(?![A-Za-z])` |
| 新加坡 | `(?i)🇸🇬 | 新加坡 | 狮城                           | (?<![A-Za-z])SGP?(?![A-Za-z])` |
| 台湾   | `(?i)🇹🇼 | 台湾   | 台北                           | (?<![A-Za-z])TWN?(?![A-Za-z])` |
| 韩国   | `(?i)🇰🇷 | 韩国   | 首尔                           | (?<![A-Za-z])KOR?(?![A-Za-z])` |

**改 filter / exclude_filter 之前必须** `preview_proxy_group_members` 对真实节点试算，确认命中的
正是想要的节点，再发起 `create_proxy_group` / `update_proxy_group`。（浏览器本地纯正则匹配，零往返；
非浏览器客户端经同名 MCP 工具走。）

## 4. 改名级联 / 删除守卫

- 给组改名会**自动级联**改写引用它的其它组与规则。
- 删除前确保没被别处引用（其它组 proxies / dialer-proxy 或规则 policy），否则会被拒。
- 可空字段传 `null` 清除。

## 5. plan → preview → write 闭环

设计/调整 → `preview_proxy_group_members` 试算 → `update_proxy_group` / `create_proxy_group`。
若改动会让**节点引用悬空**，跨链回 hub 的 `references/orphan-references.md`：先预警、提议一并改
（链式后端 / 组成员 / 规则 policy），取得同意再落地。

**旧配置修复死锁的窄例外**：若同一 profile 已经存有两个以上非法 `filter` / `exclude-filter`，
逐个 `update_proxy_group` 会因为“其余坏组仍让整份配置预检失败”而无法落地。此时每条候选仍要先
`preview_proxy_group_members`，然后用 `repair_proxy_group_filters` 把 2–16 个组的筛选字段放进**一个候选
配置、一次完整预检和一张确认卡**中原子修复；任一项仍非法则全部不写。服务端要求每个目标组
被改字段中至少有一个当前确属非法正则，拒绝无变化项，并把确认卡绑定到预览时的配置版本；卡片
差异过长无法完整展示时 MCP 会安全拒绝。该 action 只开放 `filter` / `exclude_filter`，不得用于普通批量改组。

## 6. 只读契约

`filter` 作用于**注入后的真实节点池**；节点真相依赖 hub（订阅源注入，要改节点数量改订阅源本身）。
要给新组导流，另加 `add_rule`（由 hub 拥有，同一 MCP server 可调）。

## 拥有的工具

`list_proxy_groups` · `preview_proxy_group_members` · `create_proxy_group` ·
`update_proxy_group` · `repair_proxy_group_filters` · `delete_proxy_group` · `list_proxy_nodes`

## 参考资料

- `references/kind-taxonomy.md` — 五种有效形态 + 遗留绑定的字段矩阵；type 与 empty-fallback 语义
- `references/filter-regex.md` — regexp2 安全交集、显式 ASCII 边界、常用地区正则与 exclude-filter
