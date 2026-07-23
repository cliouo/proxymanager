# 领域模型 / 术语表

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才读取。
> 这是各 skill 的共同地基——术语、per-profile 所有权、kind 形态、锚点、Redis 托管模型。
> 全部事实取自 `web/schemas/*.ts`、`web/lib/`（engine/redis/ai）与原 system prompt，未经验证的字段名/行为一律不写。

## 目录 (TOC)

- [一、术语表](#一术语表)
- [二、per-profile 所有权](#二per-profile-所有权)
- [三、kind 形态总览](#三kind-形态总览)
- [四、锚点 prelude / manual / late](#四锚点-prelude--manual--late)
- [五、Redis 托管模型与 base.yaml 标记](#五redis-托管模型与-baseyaml-标记)
- [六、实体关系速览](#六实体关系速览)

---

## 一、术语表

| 术语                  | 实体 / schema                            | 是什么                                                                                                                          | 怎么管                                                                                                                                       |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **节点**              | `proxies[]` 条目                         | 代理节点。**渲染时由 enabled 订阅源自动注入**进 `proxies:`，跨源同名按**先到先得**去重                                          | 只读：`list_proxy_nodes`；本地源节点：`list_local_nodes` + `rename_local_node`。**禁**用 config-section 改 `proxies`。要增减节点改订阅源本身 |
| **订阅源**            | `Subscription` (`subscription.ts`)       | 一个机场订阅。`kind=remote`(给 `url`) 或 `local`(给 `content`，内联 `proxies:` 块)                                              | 在「订阅源」页增删；节点处理用算子工具                                                                                                       |
| **聚合订阅 / 节点池** | `Collection` (`collection.ts`)           | 把多个成员订阅(显式 `subscription_ids` + 按 `subscription_tags` 自动纳入)的节点合并去重                                         | `name`+`slug`(创建后不可改)；自带 `operators` 管线，在合并后、去重前对全集跑一遍                                                             |
| **规则**              | `Rule` (`rule.ts`)                       | 一条分流规则：`type`(DOMAIN/IP-CIDR/RULE-SET/GEOIP/MATCH…) + `value` + `policy`，挂在某个 `anchor` 下                           | `add_rule` / `update_rule` / `delete_rule`。**全部规则**由平台托管                                                                           |
| **规则集**            | `RuleSet` / rule-provider (`ruleSet.ts`) | 一份域名/IP 列表。`source=local`(平台托管 `content`) 或 `remote`(mihomo 直接抓 `url`)                                           | `list_rule_providers` / `create_/update_/delete_rule_provider`；远程转本地用 `localize_rule_provider`                                        |
| **策略组**            | `ProxyGroup` (`proxyGroup.ts`)           | mihomo `proxy-group`：`select`/`url-test`/`fallback`/`load-balance` 路由分组；固定 v1.19.28 已移除 `relay`                      | `list_proxy_groups` / `create_/update_/delete_proxy_group`；改 filter 前先 `preview_proxy_group_members`                                     |
| **profile**           | `Profile` (`profile.ts`)                 | 一份「配置文件」。`name` 是 kebab 标识(resolver 按 name 查)，`display_name` 是客户端导入后显示名；`source` 单选绑定一个节点来源；`kind` ∈ `normal`/`template`（**模版不分发**、不存 Tailscale 身份、新建时置顶供克隆） | Phase 2 起每个 profile **独占** base/rules/proxy-groups（+devices）；AI 可 `list_profiles`/`create_profile`/`update_profile`，**删除仅 UI**（neverList） |
| **设备**              | `Device` (`device.ts`)                   | 挂在 profile 下的**差量实体**：共享渲染 + RFC 7386 `base_patch`（只动最终产物顶层键）+ 类型化设备级功能（Tailscale）。名字进设备订阅 URL `/api/sub/{token}/{profile}/{device}`，每 profile ≤16 台 | `list_devices` / `preview_device_config` / `create_/update_/delete_device` / `set_/remove_device_tailscale`——详见 **managing-devices** skill |
| **锚点**              | base.yaml 注释标记                       | `rules:` 块里的 `# === ANCHOR: <name> ===` 占位；规则按 anchor 分组、渲染时注入到对应标记处                                     | 规则的 `anchor` 字段必须命中 base 已声明的锚点                                                                                               |

**Profile.source**(`ProfileSourceSchema`，三选一判别联合)：

| `type`         | 含义                                          | 字段        |
| -------------- | --------------------------------------------- | ----------- |
| `none`         | 不注入任何订阅节点（新建 profile 的**默认**） | —           |
| `subscription` | 绑定单个订阅源                                | `id` (uuid) |
| `collection`   | 绑定单个聚合订阅（其成员合并注入）            | `id` (uuid) |

> 想要"多个机场" → 建一个聚合订阅再绑它；profile 本身**不**展开成手选列表（多绑模型已废弃）。

**节点处理 / 算子**(`Operator`，订阅源与聚合订阅共用同一套管线，按数组顺序逐个作用，**只过滤/改写/排序已有节点、绝不新增节点**)：
`filter-regex`、`filter-useless`、`rename-regex`、`flag-emoji`、`filter-type`、`sort`、`set-prop`、`dedup`、`filter-region`。
管理：`list_node_sources` 查 → `preview_node_operators` 试算(改正则前必做) → `add_/update_/delete_operator` / `reorder_operators`。

---

## 二、per-profile 所有权

Phase 2 把 **base / rules / proxy-groups** 改为**每个 profile 各自拥有**，按 profile id 分键存储。

**Redis 键（`lib/redis/keys.ts`）**

| 资源                                                      | 键                                                                                               | 范围                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| base 骨架内容                                             | `base:content:<profileId>`                                                                       | per-profile                    |
| base 元数据                                               | `base:meta:<profileId>`                                                                          | per-profile                    |
| 规则 hash                                                 | `rules:<profileId>`                                                                              | per-profile                    |
| 策略组 hash                                               | `proxy-groups:<profileId>`                                                                       | per-profile                    |
| 策略组 taxonomy                                           | `taxonomy:groups:<profileId>`                                                                    | per-profile                    |
| 订阅源 / 节点 / 规则集 / 聚合订阅 / 策略组模板 / profiles | `subscriptions` / `proxies` / `rule-sets` / `collections` / `proxy-group-templates` / `profiles` | **全局共享**（非 per-profile） |

> 迁移前的全局键 `base:content` / `rules` / `proxy-groups` 等只剩 `REDIS_KEYS.legacy.*` 引用，仅迁移脚本读取。

**clone-on-create（`ProfileCreateSchema.copy_from`，uuid 可选）**

- 设为某个现有 profile id → 新 profile **深拷贝**该 profile 的 base + proxy-groups + rules + taxonomy + **devices**（**生成新 id，保留名字**；每台设备的 `features` **清空**——Tailscale hostname/key 是设备身份，克隆必冲突，需在新 profile 重新启用）。
- 省略 → 新 profile 拿一份从 `default` profile 的 base 复制的**空骨架**，无策略组、无规则、无设备。
- `copy_from` **不落库**，仅是创建期指令。模版（`kind=template`）在新建流程里置顶，是 clone 的常用来源。

**active-profile cookie（`lib/profileScope.ts`）**

- cookie 名：`pm.active_profile`（侧栏切换器的选择）。
- 编辑类路由解析"作用于哪个 profile"的优先级：
  1. `?profile=<name>` 查询参数（最高，scoped 页面发的）
  2. `pm.active_profile` cookie
  3. `default`（永远存在的锚 profile）
- 解析出的 name 会查成真实 Profile 记录；**未知 name → 404**（不静默回退，避免改错 profile）。

---

## 三、kind 形态总览

不同实体的 `kind`/`source` 各自独立，别混淆：

**ProxyGroup.kind** —— 标记成员**来源形态**(intent，非行为；renderer 对所有 kind 一视同仁)：

| kind         | 含义                                                                                               | 关键字段                        |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| `manual`     | 手选 —— `proxies` 列命名节点，不 include-all                                                       | `proxies`                       |
| `filter`     | 筛选 —— `include-all-proxies` + `filter` 正则（可叠加 manual 补充）                                | `include-all-proxies`, `filter` |
| `all`        | 全部 —— `include-all-proxies`，无 filter                                                           | `include-all-proxies`           |
| `single-sub` | 绑定一个订阅源 —— 成员=该源处理后节点；渲染时把成员（`proxies`）设为该源**存活节点名**，**别手填** | `bound_subscription_id`         |
| `raw`        | 逃生口（默认值）                                                                                   | 任意原生字段                    |

> 旧值 `region`/`service`/`system`/`rule-set-policy`/`collection-scope`/`all-auto-pair` 在 parse 时透明重映射（`collection-scope`→`manual`，该 kind 已弃用）。`single-sub` 组的成员在**渲染时计算**——把 `proxies` 设为绑定源的存活节点名，别手填 `proxies`；遗留记录上的 `bound_collection_id` 字段渲染时仍会把 `proxies` 设为其成员节点（仅向后兼容，新建勿用）。

**ProxyGroup.type**(固定 Mihomo v1.19.28)：`select` / `url-test` / `fallback` / `load-balance`。`relay` 已被内核移除并会令整份配置拒载；链式转发应使用 concrete proxy 的 `dialer-proxy`。其中 `url-test`/`fallback`/`load-balance` 才吃 `url`/`interval`/`tolerance`/`lazy`/`expected-status` 健康检查字段。

**Subscription.kind**：`remote`(给 `url`) / `local`(给 `content`)。
**RuleSet.source**：`local`(平台托管 `content`) / `remote`(外部 `url`)；`RuleSet.format`：`yaml` / `text` / `mrs`（**`mrs` 仅 remote**，二进制）。

---

## 四、锚点 prelude / manual / late

锚点是 base.yaml `rules:` 块里的注释占位 `# === ANCHOR: <name> ===`（`lib/engine/parser.ts` 的 `ANCHOR_PATTERN`）。渲染时（`renderer.ts`）规则按 `anchor` 分组、注入到同名标记行之后；锚内按 `rank` 升序，**MATCH 取最大 rank、永远渲染在最后**。

项目默认三段锚点（顺序即分流优先级，`scripts/migrate-rules-into-hash.ts`）：

| 锚点      | 角色  | 语义                                             |
| --------- | ----- | ------------------------------------------------ |
| `prelude` | 前置  | pivot 之前的规则 —— 高优先级，最先匹配           |
| `manual`  | pivot | 已托管的主体规则锚点（迁移的 pivot marker）      |
| `late`    | 兜底  | pivot 之后的规则 —— 收尾，MATCH 落在这里渲染最后 |

> `add_rule` 的 `anchor` 必须是 base.yaml 已声明的锚点；不确定时先 `get_base_overview`。`options` 不是自由文本：仅 `GEOIP` / `IP-ASN` / `IP-CIDR` / `IP-CIDR6` / `RULE-SET` 可带不重复的小写 `src` / `no-resolve`，其它类型必须为空。`enabled:false` 表示驻留 hash 但渲染时跳过；`source` ∈ `manual`/`speedtest`/`import`。

---

## 五、Redis 托管模型与 base.yaml 标记

**核心约定**：rules / rule-providers / proxy-groups 三类**全部移出 base.yaml、存进 Redis**，base.yaml 对应位置只留注释标记，渲染时由引擎注入。

| 资源   | 存储                                                                                 | base.yaml 里只剩                                             | 注入方式                                                                                        |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 规则   | `rules:<profileId>` hash                                                             | `rules:` 块内的 `# === ANCHOR: <name> ===` 标记（无规则行）  | 按锚点注入到各标记处                                                                            |
| 规则集 | `rule-sets` hash + `rule-set-content:<id>`（内容拆独立键）                           | `# === RULE-PROVIDERS ===` 单标记（无 `rule-providers:` 块） | **只注入被引用的**：被 enabled RULE-SET 规则、或 base 正文 `rule-set:` 引用到的规则集才下发声明 |
| 策略组 | `proxy-groups:<profileId>` hash（原生字段 + 元数据；模板在 `proxy-group-templates`） | `# === PROXY-GROUPS ===` 单标记                              | 全量按 `rank` 注入，各组先并入其 `template_id` 模板（组覆盖模板填空）                           |

**衍生事实**

- 让一个规则集生效要两步：先 `create_rule_provider` 入库，再 `add_rule` 加一条 RULE-SET 规则引用它的 `name`（只入库不引用 = 不下发）。
- 节点（`proxies`）也不在 base 里：enabled 订阅源渲染时注入；用户手写的 `proxy-providers` 原样透传、平台不管理。
- `# === PROXY-GROUPS ===` 标记缺失会让 hash 里的策略组**无法注入**（resolve 报错），需先跑迁移或手插标记。

**config-section 写操作的禁改根**（`lib/ai/configPath.ts` `FORBIDDEN_EDIT_ROOTS`，越权会被系统拒绝）：

| 根                | 为什么禁               | 正确入口                   |
| ----------------- | ---------------------- | -------------------------- |
| `proxies`         | 节点由订阅源自动注入   | 「订阅源」页               |
| `proxy-providers` | 平台不再管理，原样透传 | 不要碰                     |
| `proxy-groups`    | 已进 Redis hash        | `*_proxy_group`            |
| `rules`           | 已托管                 | `add_/update_/delete_rule` |
| `rule-providers`  | 已托管                 | `*_rule_provider`          |

> 骨架其余区块（dns / sniffer / tun / 顶层标量等）才走 `set_config_section` / `delete_config_section`，路径语法见 `get_config_section`（如 `dns.enhanced-mode`、`proxy-groups[OpenAI]` 仅用于**读**）。

---

## 六、实体关系速览

```
Profile (per-profile 拥有 base/rules/proxy-groups/devices; kind normal/template, 模版不分发)
  ├─ Device ×N ── base_patch(RFC 7386 顶层差量) + features.tailscale(typed)
  │                名字进 /api/sub/{token}/{profile}/{device} (?format=base64 可选)
  └─ source ── none │ subscription(id) │ collection(id)
                              │              │
                     Subscription ◀──成员──── Collection (节点池: ids + tags)
                       kind remote/local        自带 operators 管线
                       operators 管线                │
                              └──── 节点(proxies) ◀──┘  渲染时注入, 跨源去重(先到先得)
                                         ▲
                                         │ 被名字引用
              ProxyGroup ──proxies/filter┘   policy ▼
                kind raw/manual/filter/all/single-sub   Rule ── anchor(prelude/manual/late)
                type select/url-test/...                  type/value/policy, options, enabled
                (可选 template_id 合并)                    policy ─▶ 策略组名 / 节点名 / 内建(DIRECT/REJECT…)
                                                          RULE-SET value ─▶ RuleSet(name)

base.yaml 仅标记: # === ANCHOR: x ===  /  # === RULE-PROVIDERS ===  /  # === PROXY-GROUPS ===
Redis 托管: rules:<pid> / proxy-groups:<pid> / rule-sets / subscriptions / collections / profiles
```
