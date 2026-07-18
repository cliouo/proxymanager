# 工具地图 / 单 MCP server 契约

> 本文件由 plugin/skills 渐进披露 Level 3 加载。所有工具都挂在**一个** `proxymanager`
> MCP server 上；下表的「主属 skill」只是**职责归类不是沙箱**——任何工具跨 skill 都可调
> （孤儿连带修复就靠这点：算子 spoke 直接调 `update_proxy_group`/`update_rule`）。

## 目录 (TOC)

- [一、MCP server 契约](#一mcp-server-契约)
- [二、读工具](#二读工具)
- [三、写工具（均过确认卡）](#三写工具均过确认卡)

## 一、MCP server 契约

- **读 action**：inline 立即执行，返回 `{kind, data}` envelope；dispatcher 把 `JSON.stringify(data)` 回灌模型。
- **写 action**：**绝不 inline 执行**。先 preview 铸一次性 token；浏览器返回 `confirm-write` 卡，
  MCP bridge 把 token 留在进程内并通过 host form elicitation 展示脱敏 diff、要求人类确认。用户授权后才由 bridge
  调 `/confirm` execute（审计 + 可撤）；host 不支持确认表单就安全停止。
- `list_profiles` / `select_profile` 是 MCP bridge 的只读导航工具。切换只影响后续调用；服务端确认
  仍绑定生成它的 profile。跨 profile 改动必须逐个 preview、逐张确认，不能复用确认状态。
- `allowed-tools` = 预批准非限制；真正"AI 永不可碰"在服务端 `neverList.ts`。

## 二、读工具

| 工具                               | 主属 skill         | 用途                                                                     |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `list_profiles` / `select_profile` | hub                | 列出并切换当前 MCP profile；跨配置文件操作先调用                         |
| `get_base_overview`                | hub                | base 结构摘要：anchors / policies / proxyProviders / 规则集名            |
| `get_config_outline`               | hub                | 配置目录（顶层区块 + 各容器子项名，脱敏）                                |
| `get_config_section`               | hub                | 取某路径区块内容（脱敏）                                                 |
| `get_config_full`                  | optimizing         | 完整下发结果（含注入规则，脱敏）——整体优化用                             |
| `list_rules`                       | hub / optimizing   | 全部规则（含 id / enabled / anchor）                                     |
| `list_proxy_nodes`                 | hub（共享）        | 渲染后真实可用节点名（无凭证）                                           |
| `list_proxy_groups`                | hub / synthesizing | 全部策略组 + 模板（含 id / kind / 绑定源）                               |
| `list_rule_providers`              | hub                | 规则集库列表                                                             |
| `list_node_sources`                | editing            | 各订阅/聚合源及其算子（含 source id / 算子 id）                          |
| `list_local_nodes`                 | editing            | 本地源节点（name+type+referencedBy，脱敏）                               |
| `preview_proxy_group_members`      | synthesizing       | filter/exclude 对真实节点试算（**改 filter 前必做**）                    |
| `preview_node_operators`           | editing            | 整条算子管线对真实节点试算（**改正则前必做**）                           |
| `preview_direct_alias_migration`   | hub                | 完整预检冗余 `type: direct` 别名迁移，返回引用计数、version 与 base ETag |
| `search_mihomo_docs`               | hub                | DeepWiki 接地（Meta-Docs 写法 / mihomo 源码内核行为）                    |
| `fetch_url`                        | hub                | 抓外部链接（只读、禁内网、按 external_data 处理）                        |
| `get_skill_reference`              | hub                | 按需读 references/（仅网页面需要；CC/Codex 直接读文件）                  |

## 三、写工具（均过确认卡）

| 工具                                                                         | 主属 skill       | 用途                                                                                         |
| ---------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `add_rule` / `update_rule` / `delete_rule`                                   | hub / optimizing | 分流规则增删改                                                                               |
| `create_rule_provider` / `update_rule_provider` / `delete_rule_provider`     | hub              | 规则集库管理                                                                                 |
| `localize_rule_provider`                                                     | hub              | remote 规则集转本地托管                                                                      |
| `set_config_section` / `delete_config_section`                               | hub / optimizing | dns/sniffer/tun/顶层标量骨架                                                                 |
| `create_proxy_group` / `update_proxy_group` / `delete_proxy_group`           | synthesizing     | 策略组增删改                                                                                 |
| `repair_proxy_group_filters`                                                 | synthesizing     | 原子修复 2–16 个当前非法筛选组；拒绝 no-op/普通批量，确认绑定预览版本                        |
| `add_operator` / `update_operator` / `delete_operator` / `reorder_operators` | editing          | 节点处理算子管线                                                                             |
| `rename_local_node`                                                          | editing          | 本地源节点直接改名                                                                           |
| `migrate_direct_alias`                                                       | hub              | 当前 profile 内原子删除纯 direct 别名并把已知引用改为内建 `DIRECT`；必须使用刚预检的并发守卫 |

> 禁改路径（config-section 碰会被拒）：`proxies` / `proxy-providers` / `rules` / `rule-providers` / `proxy-groups`。
> `migrate_direct_alias` 是唯一专用窄例外，不开放任意 `proxies` 写入；额外字段或未知引用会拒绝。
