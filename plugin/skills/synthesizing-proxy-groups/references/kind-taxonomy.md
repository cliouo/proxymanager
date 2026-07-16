# 策略组 kind × 字段矩阵

> 本文件由 plugin/skills 渐进披露 Level 3 加载（仅当上层 SKILL.md 指向本文件时才读取）。
> 事实来源：`web/schemas/proxyGroup.ts`、`web/lib/ai/actions/primitives/proxyGroupWrites.ts`、`web/lib/engine/resolve.ts`、systemPrompt L18。只记录被源码/原 system prompt 证实的字段与行为。

## 目录 (TOC)

- [两条正交轴：kind(形态) vs type(原生类型)](#两条正交轴)
- [形态总览（6 形态）](#形态总览)
- [kind × 字段矩阵](#kind-字段矩阵)
- [谁渲染时算](#谁渲染时算)
- [type 语义：select/url-test/fallback/load-balance](#type-语义)
- [每种 kind 一个最小示例](#最小示例)
- [AI 工具能设哪些（kebab 映射 + 必填校验）](#ai-工具能设哪些)
- [改名级联与删除守卫](#改名级联与删除守卫)

<a id="两条正交轴"></a>

## 两条正交轴：kind(形态) vs type(原生类型)

mihomo 原生的 proxy-group 只有 `type`。ProxyManager 额外加了 `kind` 元字段。两者正交、不要混淆：

- **`kind` = 成员从哪来（形态 / form）**。是 UI 预设的意图标记，**渲染器对所有 kind 一视同仁**（schema L15-17：`kind is intent, not behaviour`）；它只让预设表单能回填编辑 UI。用途（地区池 / 规则集出口 / 兜底…）不放 kind，放自由文本 `section`。
- **`type` = Mihomo 原生选路行为**。固定 v1.19.28 支持 `select/url-test/fallback/load-balance`；`relay` 已移除并会拒载。

枚举现状（schema L121）：`kind` 仅 5 个有效值 `raw / manual / filter / all / single-sub`。旧分类值（`region/service/system/rule-set-policy/collection-scope/all-auto-pair`）在解析时被 `LEGACY_KIND_REMAP` 透明映射（多数→`manual`，`region/service`→`filter`），`scripts/recategorize-proxy-groups.ts` 跑完后库里不再有旧值。

<a id="形态总览"></a>

## 形态总览（6 形态）

| kind               | 中文             | 成员来源                                                                                               | 状态                                                                                                                      |
| ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `manual`           | 手选             | `proxies` 列表（节点名 / 其它组名 / 内置 DIRECT·REJECT）                                               | 有效                                                                                                                      |
| `filter`           | 筛选             | `include-all-proxies` 纳入全部，再用 `filter` 正则筛（可加 `exclude-filter`、可加手选 `proxies` 补充） | 有效                                                                                                                      |
| `all`              | 全部             | `include-all-proxies`，无 `filter`                                                                     | 有效                                                                                                                      |
| `single-sub`       | 绑定订阅         | `bound_subscription_id`；`proxies` 渲染时算出                                                          | 有效                                                                                                                      |
| `raw`              | 逃生口           | 任意字段自己写，预设不约束                                                                             | 有效（默认值）                                                                                                            |
| `collection-scope` | 绑定聚合（遗留） | `bound_collection_id`；`proxies` 渲染时算出                                                            | **已弃用**：枚举不再含此值，落库被映射为 `manual`；仅遗留 `bound_collection_id` 数据仍在渲染时解析（resolve.ts L432-451） |

<a id="kind-字段矩阵"></a>

## kind × 字段矩阵

`✔`=该形态典型使用；`○`=可选补充；`—`=不用；`OUT`=该字段是渲染产物、**勿手填**（输入应留空，由绑定算出）。

| kind                     | proxies | filter | exclude-filter | include-all-proxies | bound_subscription_id | bound_collection_id |
| ------------------------ | :-----: | :----: | :------------: | :-----------------: | :-------------------: | :-----------------: |
| `manual`                 |    ✔    |   —    |       —        |          —          |           —           |          —          |
| `filter`                 |    ○    |   ✔    |       ○        |          ✔          |           —           |          —          |
| `all`                    |    —    |   —    |       ○        |          ✔          |           —           |          —          |
| `single-sub`             |   OUT   |   —¹   |       —        |          —          |           ✔           |          —          |
| `raw`                    |    ○    |   ○    |       ○        |          ○          |           —           |          —          |
| `collection-scope`(遗留) |   OUT   |   —    |       —        |          —          |           —           |          ✔          |

¹ **single-sub 不再自动生成 filter**：systemPrompt L18 —「成员=该源处理后的节点直接列为 proxies，无 node_prefix、不再自动生成 filter」。resolve.ts L414-429 直接把该源存活节点名写入 `proxies`。（schema L146-152 的 docstring 还描述了旧的「按 node_prefix 派生 filter」行为，已被现行实现取代，以 L18 / resolve.ts 为准。）

辅助字段（不在上表 6 列但同属成员/筛选范畴）：

- `exclude-type`：按节点 type 排除，用 `|` 分隔固定 AdapterType，如 `Direct|Reject`；不得含空白、空项或重复项。
- `empty-fallback`：动态成员最终为空时的明确出口。无显式成员的动态组默认补 `REJECT`；显式值只能是 concrete proxy 或内建目标，不能指向另一个组。
- `use` / `include-all-providers` / `include-all`：从 proxy-providers 取成员。本项目不管理 `proxy-providers`（原样透传），AI 工具未暴露这几个字段。

<a id="谁渲染时算"></a>

## 谁渲染时算

成员/筛选的解析分两个阶段，落在两套引擎：

**ProxyManager 渲染时算（resolve.ts，发生在下发前）**

- `single-sub` + `bound_subscription_id` → `proxies` = 该订阅源本次渲染的存活节点名。绑定源不存在或本轮无存活节点 → 整次渲染拒绝，不保留 stale 成员。
- `collection-scope` 遗留 + `bound_collection_id` → `proxies` = 成员订阅各自存活节点，按成员顺序 + 源内顺序去重；绑定不存在或最终为空同样拒绝。
- `include-all-proxies` / `include-all` 组：渲染时**自动追加一段锚定 `exclude-filter`**，剔除 chain-wrap 克隆。用户原字符串保持不变，再用反引号追加生成 pattern；不能用 `|` 包起来合并。
- 动态组没有显式成员且未设 `empty-fallback` 时，补 `empty-fallback: REJECT`，避免固定内核静默退到 `COMPATIBLE`。

**mihomo 运行时算（下发后由内核解析）**

- `include-all-proxies` + `filter` / `exclude-filter` / `exclude-type` 的成员集合：逐字下发，内核对真实节点池求交/差。
- `url-test/fallback/load-balance` 的健康检查与选路（按 `url`/`interval` 探测）。

`manual` / `raw` 的 `proxies` 是静态字面，两个阶段都不重算。

> 验证正则用 `preview_proxy_group_members`：它在 ProxyManager 侧按固定 regexp2 的安全公共子集对真实节点名试算，**改 `filter`/`exclude-filter` 前后都应调用**。常见坑：裸 `us` 会顺带吃进 Australia / Russia；应改用 `(?<![A-Za-z])US(?![A-Za-z])` 或国旗 emoji。

<a id="type-语义"></a>

## type 语义：select/url-test/fallback/load-balance

| type           | 行为                                        | 健康检查 | 专属字段                                                                                        |
| -------------- | ------------------------------------------- | :------: | ----------------------------------------------------------------------------------------------- |
| `select`       | 用户在客户端手动选当前出口                  |    否    | —                                                                                               |
| `url-test`     | 自动选健康检查延迟最低的成员                |    是    | `tolerance`（ms 容差，仅 url-test，schema L77-78：RTT 差超过它才换当前最优）                    |
| `fallback`     | 按 `proxies` 顺序，当前成员不健康才切下一个 |    是    | —                                                                                               |
| `load-balance` | 流量分摊到多个成员                          |    是    | `strategy`（仅 load-balance：`consistent-hashing`/`round-robin`/`sticky-sessions`，schema L88） |
| `relay`        | **已移除**：固定 v1.19.28 会拒载            |    —     | 迁移为 concrete proxy 的 `dialer-proxy`                                                         |

健康检查类型 = `HEALTH_CHECK_TYPES`（schema L42）：`url-test` / `fallback` / `load-balance`。仅这三种接受健康检查字段：`url` / `interval` / `lazy` / `expected-status` / `max-failed-times` / `timeout`（外加 url-test 的 `tolerance`）。`select` 不做健康检查；`relay` 不是可下发类型。

<a id="最小示例"></a>

## 每种 kind 一个最小示例

`manual` — 手选成员：

```yaml
name: 节点选择
type: select
kind: manual
proxies: [香港01, 日本01, DIRECT, REJECT]
```

`filter` — 纳入全部再正则筛（地区/服务组常用）：

```yaml
name: 香港
type: url-test
kind: filter
include-all-proxies: true
filter: "(?i)香港|HK|🇭🇰"
url: https://www.gstatic.com/generate_204
interval: 300
```

`all` — 全部节点，无筛选：

```yaml
name: 全部节点
type: select
kind: all
include-all-proxies: true
```

`single-sub` — 绑定一个订阅源（`proxies` 渲染时自动填，勿手写）：

```yaml
name: 机场A
type: select
kind: single-sub
# bound_subscription_id: <订阅源 id>   ← 在「订阅源」页绑定
# proxies 由该源存活节点渲染时算出，不要手填 filter/proxies
```

`raw` — 逃生口，字段全自定义（默认 kind）：

```yaml
name: 我的特殊组
type: select
kind: raw
proxies: [节点A, url-test组, DIRECT]
```

`collection-scope`（遗留，只读理解用）— 枚举已删，落库为 `manual`，仅旧 `bound_collection_id` 仍渲染：

```yaml
name: 自建池
type: url-test
kind: manual # 解析时 collection-scope → manual
# bound_collection_id: <聚合 id>   ← 仅遗留数据在渲染时解析为 proxies
```

<a id="ai-工具能设哪些"></a>

## AI 工具能设哪些（kebab 映射 + 必填校验）

`create_proxy_group` / `update_proxy_group` 暴露的可编辑字段（snake_case 输入 → kebab 原生键，proxyGroupWrites.ts L82-112）：

| 工具输入 (snake)      | 原生键 (kebab)                                                                  |
| --------------------- | ------------------------------------------------------------------------------- |
| `exclude_filter`      | `exclude-filter`                                                                |
| `include_all_proxies` | `include-all-proxies`                                                           |
| `exclude_type`        | `exclude-type`                                                                  |
| `empty_fallback`      | `empty-fallback`                                                                |
| `dialer_proxy`        | `dialer-proxy`                                                                  |
| 其余同名              | `type`/`kind`/`section`/`proxies`/`filter`/`url`/`interval`/`tolerance`/`notes` |

要点：

- AI 工具**不暴露** `bound_subscription_id` / `bound_collection_id` / `use` / `include-all-providers` / `include-all` / `strategy` / `lazy` 等。**因此 `single-sub`（及遗留 collection-scope）的绑定只能在「订阅源」页做，AI 走的是 raw/manual/filter/all**。systemPrompt L18：这两类成员渲染时算，「别手填 filter/proxies」。
- `create` 必填校验（L181-183）：必须有成员来源之一 —— `proxies` 手选 **或** `include_all_proxies`（可配 `filter`）**或** `filter`。
- `update` 校验：至少改一个字段；可空字段传 `null` 表示**清除**该键（含 `filter`/`exclude_filter`/`exclude_type`/`empty_fallback`/`dialer_proxy`/`section`/`notes`）。
- `default`：`type` 默认 `select`，`kind` 默认 `manual`（CreateInput L168-169）。
- 所有写操作经确认卡（preview→card→execute），发起后不要声称已改好。
- 新建组要生效，通常还需 `add_rule` 加规则把流量指向它，或把它加进其它组的 `proxies`（L188）。

<a id="改名级联与删除守卫"></a>

## 改名级联与删除守卫

由 `proxyGroupService` 强制（proxyGroupWrites.ts L6-11，工具直通该 service，行为与「策略组」页一致）：

- **改名级联**：`update_proxy_group` 改 `name` 会**自动级联改写**所有引用旧名的地方 —— 其它组的 `proxies` 与 `dialer-proxy`，以及规则的 policy（UpdateInput L217）。无需手动逐处改。
- **删除守卫**：`delete_proxy_group` 若该组仍被**其它组的 `proxies` / `dialer-proxy`** 或**某条规则的 policy** 引用，会被**拒绝**。须先改掉那些引用再删（L276-277）。
- **唯一性 / 模板存在性 / dialer-proxy 环检测**：service 在 create/update 时一并校验（L7-8）。
- **front-pool 不外露**：被另一组用 `dialer-proxy` 指向的组属于链式「前置池」（`frontPoolGroupNames`，schema L326-336，结构性识别、改名无关）。它们是内部管道，**不应**作为规则 policy 或其它组的成员（直接把流量打到前置池只到前段、到不了后端）。
