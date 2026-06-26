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
  (word-boundary \bUS\b or flag-emoji anchoring). Deep-dive spoke of the
  managing-clash-config hub.
---

# 策略组合成器 (spoke)

**安全地板**（完整横切护栏在 `managing-clash-config` hub）：节点密码 / 订阅 URL 已脱敏为 `***`，
不获取不猜测；写不立即生效，服务端出确认卡、用户授权才执行，发起后别声称已改好；先 `search_mihomo_docs`
再答 mihomo 写法。这些 load-bearing 部分由服务端强制。

管理 select / url-test / fallback / load-balance / relay 路由分组。策略组已从 base.yaml 抽到
`proxy-groups` Redis hash，base 只剩 `# === PROXY-GROUPS ===` 标记。

## 1. kind 七形态决策树

每个组带 `kind` 字段标记 UI 预设形态（字段矩阵见 `references/kind-taxonomy.md`）：

- `raw` — 逃生口，整组按字面写
- `manual` — 手选 proxies
- `filter` — 纳入全部再用正则筛
- `all` — 全部节点
- `single-sub` — 绑一个订阅源，用 `bound_subscription_id`，成员=该源处理后的节点直接列为 proxies
  （无 node_prefix、不自动生成 filter）
- `collection-scope` 类 — 用 `bound_collection_id` 自动生成 proxies

> `single-sub` / `collection-scope` 的成员是**渲染时算的**，别手填 filter / proxies。

## 2. 成员合成三来源

手选 `proxies` ｜ `include_all_proxies` + `filter` ｜ 绑定来源自动算。

## 3. filter 单词边界坑（本 spoke 招牌）

裸 `us` 会顺带吃进 A-**us**-tralia / R-**us**-sia。改用单词边界 `\bUS\b` 或国旗 emoji 锚定。

**改 filter / exclude_filter 之前必须** `preview_proxy_group_members` 对真实节点试算，确认命中的
正是想要的节点，再发起 `update_proxy_group`。（`preview_proxy_group_members` 在浏览器本地纯正则
匹配，零往返；非浏览器客户端经同名 MCP 工具走。）

## 4. 改名级联 / 删除守卫

- 给组改名会**自动级联**改写引用它的其它组与规则。
- 删除前确保没被别处引用（其它组 proxies / dialer-proxy 或规则 policy），否则会被拒。
- 可空字段传 `null` 清除。

## 5. plan → preview → write 闭环

设计/调整 → `preview_proxy_group_members` 试算 → `update_proxy_group` / `create_proxy_group`。
若改动会让**节点引用悬空**，跨链回 hub 的 `references/orphan-references.md`：先预警、提议一并改
（链式后端 / 组成员 / 规则 policy），取得同意再落地。

## 6. 只读契约

`filter` 作用于**注入后的真实节点池**；节点真相依赖 hub（订阅源注入，要改节点数量改订阅源本身）。
要给新组导流，另加 `add_rule`（由 hub 拥有，同一 MCP server 可调）。

## 拥有的工具

`list_proxy_groups` · `preview_proxy_group_members` · `create_proxy_group` ·
`update_proxy_group` · `delete_proxy_group` · `list_proxy_nodes`

## 参考资料

- `references/kind-taxonomy.md` — 七形态 × 字段矩阵；type 语义；bound_subscription_id / bound_collection_id
- `references/filter-regex.md` — 单词边界 cookbook、常用地区正则、exclude-filter 模式、flag-emoji 锚定
