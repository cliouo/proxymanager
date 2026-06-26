# 节点来源 / 节点真相

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才被读取。文件 >100 行须保留下方目录。

## 目录 (TOC)
- [一句话](#一句话)
- [proxies 从哪来](#proxies-从哪来)
- [跨源同名去重：先到先得](#跨源同名去重先到先得)
- [proxy-providers：原样透传，AI 不碰](#proxy-providers原样透传ai-不碰)
- [要多 / 少节点 → 改订阅源本身](#要多--少节点--改订阅源本身)
- [list_proxy_nodes：看渲染后的真实节点](#list_proxy_nodes看渲染后的真实节点)
- [订阅源 vs 聚合订阅](#订阅源-vs-聚合订阅)
- [本地源改名（跨链）](#本地源改名跨链)
- [禁止事项速查](#禁止事项速查)

## 一句话
`proxies:` 不是手写的、也不允许用 config-section 改——它由**每个 enabled 订阅源**在渲染时自动注入合并。要改节点集合，改订阅源；要改节点名/属性，改该源的算子；要查真实节点，调 `list_proxy_nodes`。

## proxies 从哪来
渲染时每个 enabled 订阅源各自解析，再按**订阅源顺序**把处理后的节点合并进 `proxies:`：

| 步骤 | 说明 | 源 |
| --- | --- | --- |
| 取内容 | `kind=local` 用源里内嵌 content（用户自填）；`kind=remote` 抓 URL，带缓存(ttl_ms)、抓取失败回退上次缓存并标 `stale` | `subscriptionFetcher.ts` `resolveSubscriptionRaw` |
| 归一化 | 接受 Clash `proxies:` YAML / 代理 URI 列表(ss·vmess·vless·trojan·hysteria2·tuic·ssr·snell·socks5·http) / 上述的 base64 变体 | `normaliseToClashProxies` |
| 跑算子 | 应用该源自己的「节点处理」管线 `sub.operators`（过滤/重命名/加旗/排序/设属性/去重…），算子只改写已有节点、绝不新增 | `applyOperators` |
| 合并去重 | 按订阅源顺序累积所有源的节点，跨源同名去重后写入 `proxies:` | `engine/resolve.ts` |

- 缓存键按 `url + UA + custom_headers` 区分；同机场同 UA 的两个源共享缓存，改 UA 即失效。
- 算子改的是“已有节点的样子/顺序/属性”，不是节点数量——增删节点必须动订阅源本身（见下）。

## 跨源同名去重：先到先得
合并时按节点 `name` 去重，**first-writer-wins**（先到先得），冲突**永不静默**，会记进快照的 `collisions`：

| 情形 | 结果 |
| --- | --- |
| 名字撞上 base.yaml 里**字面写死**的 proxy | base 字面节点保留，订阅源里的同名节点被丢弃（`keptFrom = null`） |
| 两个订阅源出同名节点 | 按订阅源顺序，**先出现的源**那个保留，后者被丢弃并记入 `droppedFrom` |
| 同一源内部同名 | 同样先到先得 |

`collisions[]` 每项形如 `{ name, keptFrom, droppedFrom[] }`：`keptFrom` 是被保留节点所属的订阅源名（`null`=保留的是 base 字面项），`droppedFrom` 是被丢弃的源名列表。用户抱怨“某节点没出现/数量不对”时，先看 `list_proxy_nodes` 返回的 `collisions`——多半是重名被去掉了，用 rename 类算子改名错开即可。

## proxy-providers：原样透传，AI 不碰
用户 base 里若残留 `proxy-providers:`，本项目**不再管理、原样透传下发**。AI **不要**读它、改它、也别建议用它——节点的标准来源是订阅源。`get_base_overview` 会把残留的 `proxyProviders` 名字列出来仅供知情，但不去动。

## 要多 / 少节点 → 改订阅源本身
- **要更多/更少节点** = 到「订阅源」页**增删订阅源**，或启用/停用某个源。算子和去重都做不到“凭空多出节点”。
- **要改某些节点的名字/属性/顺序/打旗/过滤掉** = 改该源的算子（`add_operator` / `update_operator` / `delete_operator` / `reorder_operators`，详见 editing-node-operators）。
- **绝不**用 `set_config_section` 去写 `proxies` 路径——会被系统拒绝。

## list_proxy_nodes：看渲染后的真实节点
要回答“我有哪些节点可用”、或写涉及具体节点名的 proxy-group/规则前，**必查** `list_proxy_nodes`。它读自上一次 `resolveConfig` 的快照，返回：

```jsonc
{
  "nodes": ["香港-01", "JP-Tokyo-1", ...], // 渲染后最终 proxies 的节点名(含手写节点 + 全部 enabled 源注入、已应用算子)
  "collisions": [ { "name": "...", "keptFrom": "源A"|null, "droppedFrom": ["源B"] } ],
  "computedAt": 1700000000000,            // 快照计算时刻(ms)
  "buildId": "..."                        // 产出该快照的配置 build id
}
```

- **只给名字，绝不含任何节点凭证**（密码/URL 已脱敏，不要尝试获取或猜测）。
- 快照缺失（系统刚启动 / 从未渲染过）时返回 `nodes: []` 且带 `hint`——此时提示用户先打开「最终配置」预览或访问订阅 URL 触发一次渲染，再重查。

## 订阅源 vs 聚合订阅
两者都能在「节点处理」里挂算子，但层级不同：

| | 订阅源 (subscription) | 聚合订阅 (collection) |
| --- | --- | --- |
| 是什么 | 一个机场链接(`kind=remote`)或一段自填内容(`kind=local`) | 把若干订阅源按标签/选择并起来的集合 |
| 算子作用域 | 只作用于**本源**节点 | 在合并完成员节点后，对**并集**整体再跑一遍 collection 自己的算子 |
| 节点来源 | 自身 fetch/content | 其成员订阅源的节点 |
| 查看 | `list_node_sources` 列出两类源及其算子(含 source id / 算子 id) | 同上 |

聚合订阅的算子作用在成员节点的并集上；改正则 / 重命名前先用 `preview_node_operators` 对该源真实节点试算，看 before/after 与每步增删改。

## 本地源改名（跨链）
- 本地源(`kind=local`)的节点可**直接在源里改名**：`list_local_nodes` 列节点（只给 name+type+referencedBy，凭证已脱敏）、`rename_local_node` 改单个名字（仅动 name 字段、其它配置原样保留，需用户确认）。
- 远程源不能直接改名，用 `rename-regex` 算子；本地源要批量/按正则改也可用 `rename-regex`。
- **改名会断引用**（链式代理后端 / 策略组成员 / 规则 policy 按名字钉死，悬空的链式后端会让整份配置在 mihomo 里加载失败）。改名前务必先看影响、预警、提议一并更新——完整规则见 **editing-node-operators**（本文不展开）。

## 禁止事项速查
| 不要 | 改用 |
| --- | --- |
| `set_config_section('proxies', ...)` | 增删源 / 算子 / `list_proxy_nodes` |
| 读/改用户的 `proxy-providers` | 不碰，原样透传 |
| 凭记忆报“有哪些节点” | `list_proxy_nodes`（读真实快照） |
| 以为算子能多出节点 | 改订阅源本身 |
| 在远程源里直接改节点名 | `rename-regex` 算子 |
