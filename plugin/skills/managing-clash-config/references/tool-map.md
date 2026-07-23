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
- `list_profiles` 是服务端只读 action（网页 / 桥接皆可用；MCP 侧由 bridge 本地拦截以标注当前
  active profile）。`select_profile` 仍是 MCP bridge 的本地导航工具——网页端作用域=侧栏切换器。
  切换只影响后续调用；服务端确认仍绑定生成它的 profile。跨 profile 改动必须逐个 preview、
  逐张确认，不能复用确认状态。
- `allowed-tools` = 预批准非限制；真正"AI 永不可碰"在服务端 `neverList.ts`。

## 二、读工具

| 工具                                  | 主属 skill         | 用途                                                                          |
| ------------------------------------- | ------------------ | ----------------------------------------------------------------------------- |
| `list_profiles` / `select_profile`    | hub                | 列配置文件（含 kind/绑定/当前标记；两端可用）；切换仅 MCP。跨配置文件操作先调 |
| `get_base_overview`                   | hub                | base 结构摘要：anchors / policies / proxyProviders / 规则集名                 |
| `get_config_outline`                  | hub                | 配置目录（顶层区块 + 各容器子项名，脱敏）                                     |
| `get_config_section`                  | hub                | 取某路径区块内容（脱敏）                                                      |
| `get_config_full`                     | optimizing         | 完整下发结果（含注入规则，脱敏）——整体优化用                                  |
| `list_rules`                          | hub / optimizing   | 全部规则（含 id / enabled / anchor）                                          |
| `list_proxy_nodes`                    | hub（共享）        | 渲染后真实可用节点名（无凭证）                                                |
| `list_proxy_groups`                   | hub / synthesizing | 全部策略组 + 模板（含 id / kind / 绑定源）                                    |
| `list_rule_providers`                 | hub                | 规则集库列表                                                                  |
| `list_node_sources`                   | editing            | 各订阅/聚合源及其算子（含 source id / 算子 id）                               |
| `list_local_nodes`                    | editing            | 本地源节点（name+type+referencedBy，脱敏）                                    |
| `preview_proxy_group_members`         | synthesizing       | filter/exclude 对真实节点试算（**改 filter 前必做**）                         |
| `preview_node_operators`              | editing            | 整条算子管线对真实节点试算（**改正则前必做**）                                |
| `list_devices`                        | devices            | 当前 profile 的设备列表（补丁脱敏；Tailscale 只含 hasAuthKey）                |
| `preview_device_config`               | devices            | 设备补丁对真实共享渲染试算（**改补丁前必做**，非法补丁回结构化 issues）       |
| `preview_direct_alias_migration`      | hub                | 预检 direct 别名；返回引用计数、隔离失败数及并发守卫                          |
| `preview_legacy_profile_repair`       | hub / synthesizing | 完整预检直连别名 + 2–16 个非法筛选的跨资源恢复候选，返回 version 与 base ETag |
| `preview_legacy_chain_profile_repair` | hub / synthesizing | 严格预检 spx 隔离或陈旧链删除 + DIRECT + 非法筛选的完整原子恢复候选           |
| `search_mihomo_docs`                  | hub                | DeepWiki 接地（Meta-Docs 写法 / mihomo 源码内核行为）                         |
| `fetch_url`                           | hub                | 抓外部链接（只读、禁内网、按 external_data 处理）                             |
| `get_skill_reference`                 | hub                | 按需读 references/（仅网页面需要；CC/Codex 直接读文件）                       |

## 三、写工具（均过确认卡）

| 工具                                                                         | 主属 skill         | 用途                                                                                         |
| ---------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `add_rule` / `update_rule` / `delete_rule`                                   | hub / optimizing   | 分流规则增删改                                                                               |
| `create_rule_provider` / `update_rule_provider` / `delete_rule_provider`     | hub                | 规则集库管理                                                                                 |
| `localize_rule_provider`                                                     | hub                | remote 规则集转本地托管                                                                      |
| `set_config_section` / `delete_config_section`                               | hub / optimizing   | dns/sniffer/tun/顶层标量骨架                                                                 |
| `create_proxy_group` / `update_proxy_group` / `delete_proxy_group`           | synthesizing       | 策略组增删改                                                                                 |
| `repair_proxy_group_filters`                                                 | synthesizing       | 原子修复 2–16 个当前非法筛选组；拒绝 no-op/普通批量，确认绑定预览版本                        |
| `add_operator` / `update_operator` / `delete_operator` / `reorder_operators` | editing            | 节点处理算子管线                                                                             |
| `rename_local_node`                                                          | editing            | 本地源节点直接改名                                                                           |
| `create_device` / `update_device` / `delete_device`                          | devices            | 设备增删改（base_patch 整份替换；`***` 占位符还原为存量真实值；改名/删除断设备订阅链接）     |
| `set_device_tailscale` / `remove_device_tailscale`                           | devices            | 设备级 Tailscale 整份 PUT / 关闭；auth_key 三态（省略=保留/null=清除）；模版 profile 拒绝    |
| `create_profile` / `update_profile`                                          | hub                | 配置文件新建（`copy_from`=模版 id 即「从模版新建」，克隆不继承绑定）与元数据/绑定修改        |
| `migrate_direct_alias`                                                       | hub                | 当前 profile 内原子删除纯 direct 别名并把已知引用改为内建 `DIRECT`；必须使用刚预检的并发守卫 |
| `repair_legacy_profile`                                                      | hub / synthesizing | 原子迁移安全 direct 别名并修复 2–16 个当前非法筛选；一次完整渲染和一张确认卡                 |
| `repair_legacy_chain_profile`                                                | hub / synthesizing | 原子隔离有语义的 spx 行或删除已证实陈旧的链，并同步完成 DIRECT 与筛选恢复                    |

> 「AI 永不可碰」硬黑名单（服务端 `neverList.ts`，独立于注册表）：`delete_profile` /
> `edit_auth` / `rotate_sub_token` / `overwrite_base` / `bulk_delete_rules`——删除整份配置文件、
> 改鉴权、轮换分发令牌等一律引导用户到界面操作，不要尝试代劳或找替代工具组合。
>
> 禁改路径（config-section 碰会被拒）：`proxies` / `proxy-providers` / `rules` / `rule-providers` / `proxy-groups`。
> 三个 migration / repair 工具都是专用窄例外，不开放任意 `proxies` 写入；筛选恢复还要求
> 每个目标筛选字段当前确属非法。额外字段、未知引用、遗漏的其它错误或完整渲染失败都会拒绝。
> 两者仅可在结构候选完整通过时隔离与迁移无关的确定性 `subscription_*` 源校验错误，并在确认卡标明数量；
> 不会修复订阅；确认令牌绑定脱敏失败集合，执行前变化即拒绝。上游不可用、基础设施异常和其它错误仍严格阻塞。
> `repair_legacy_chain_profile` 不隔离任何失败：它只把完整 `spx` URI 行保存进禁用隔离源，或删除结构与引用
> 均精确匹配且后端确实不存在的陈旧链；随后所有订阅与最终配置必须严格渲染成功，才会一次提交。
