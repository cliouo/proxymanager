# 算子 kind 全表

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才读取。
> 事实来源：`web/schemas/operator.ts`、`web/lib/proxies/operators.ts`、`web/lib/proxies/regions.ts`、`web/lib/ai/actions/primitives/operatorWrites.ts`、system prompt L22。本表只写源码已证实的字段与行为。

## 目录 (TOC)

- [总则](#总则)
- [公共字段](#公共字段)
- [9 种算子](#9-种算子)
  - [1. filter-regex 正则过滤](#1-filter-regex-正则过滤)
  - [2. filter-useless 去无用节点](#2-filter-useless-去无用节点)
  - [3. rename-regex 正则重命名/删除](#3-rename-regex-正则重命名删除)
  - [4. flag-emoji 国旗](#4-flag-emoji-国旗)
  - [5. filter-type 类型过滤](#5-filter-type-类型过滤)
  - [6. sort 排序](#6-sort-排序)
  - [7. set-prop 设属性](#7-set-prop-设属性)
  - [8. dedup 去重](#8-dedup-去重)
  - [9. filter-region 地区过滤](#9-filter-region-地区过滤)
- [顺序影响结果](#顺序影响结果)
- [多算子管线示例](#多算子管线示例)
- [写算子用的工具](#写算子用的工具)

## 总则

- 算子是订阅源(subscription)与聚合订阅(collection)上的一条**有序数组** `operators`，解析时(上游抓取并标准化后)按数组顺序逐个作用于已解析的 Clash 节点列表。
- **算子只过滤 / 改写 / 排序已有节点，绝不新增节点。** 9 种 kind 没有任何一种能造出节点；要真正多 / 少节点得改订阅源本身(加删源)。引擎对每个节点纯函数式处理:同样的节点 + 同样的算子恒得同样输出。
- 每步产出一条 trace(`OperatorStep`):`before` / `after` / `dropped`(被过滤数) / `changed`(改名或改属性数) / `applied`(disabled 时为 false)。`preview_node_operators` 返回这些以及 `orphanedReferences` / `orphanWarning`(改名/过滤会让链式后端、策略组成员、规则引用悬空的预警)。
- AI 给算子时**不要带 `id`**:服务端 materialize 时生成(add 用新 uuid,update 沿用原 id)。

## 公共字段

每种算子对象都含这两个公共字段(其余为各 kind 独有参数):

| 字段 | 类型 | 说明 |
|---|---|---|
| `kind` | 字面量 | 判别字段,见下 9 种 |
| `disabled` | `boolean?` | 可选。true=保留该步但本次跳过(不删除)。AI schema 仅省略 `id`,`disabled` 仍可设 |

> 注:`id` 在存储层存在(React key / 重排用),但 AI-facing schema 已 `omit id`——增删改算子时一律不填 id。

## 9 种算子

下表 default 即 zod schema 的 `.default(...)`;不给该字段时取此值。

### 1. filter-regex 正则过滤

按**节点名**正则保留或剔除。

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `mode` | `keep` \| `drop` | `keep` | keep=只留命中的;drop=剔除命中的 |
| `pattern` | string(非空,须能编译为 JS RegExp) | — | 必填 |
| `flags` | string(`[gimsuy]*`) | 省略 | 可选正则 flag |

行为细节(`compileTest`):测试用 `flags ?? 'i'`,即**默认大小写不敏感**;并会**剥掉 `g` / `y`** 以保证 `test()` 无状态。

```yaml
- kind: filter-regex
  mode: keep
  pattern: "\\bUS\\b"   # 用单词边界,避免裸 us 误吃 A-us-tralia / R-us-sia
```

### 2. filter-useless 去无用节点

剔除流量 / 到期 / 广告 / 官网等信息性节点。内置垃圾词表(case-insensitive,OR 连接)含:`剩余流量` `剩余` `到期` `过期` `重置` `距离` `官网` `网址` `续费` `订阅` `邀请` `失联` `客服` `群组` `频道` `公告` `更新于` `套餐` `维护` `购买` `充值` `此处` `请勿` `禁止` `expire` `traffic` `reset` `remaining` `t\.me` `telegram` `https?://`。

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `extra` | `string[]` | `[]` | 追加到内置词表的额外关键词/正则片段(空白项被忽略),与内置表一起 OR |

```yaml
- kind: filter-useless
  extra: ["测试", "备用"]
```

### 3. rename-regex 正则重命名/删除

对节点名做 `name.replace(re, replacement)`。

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `pattern` | string(非空,须能编译) | — | 必填 |
| `replacement` | string | `""` | **空字符串 = 删除匹配片段** |
| `flags` | string(`[gimsuy]*`) | 省略 | 可选 |

行为细节:`new RegExp(pattern, flags ?? 'g')`——**默认全局替换 `g`**(与 filter-regex 默认 `i` 不同)。

```yaml
- kind: rename-regex
  pattern: "^\\[.*?\\]\\s*"   # 删掉名字开头的 [机房] 前缀
  replacement: ""
```

### 4. flag-emoji 国旗

按节点名识别地区,加 / 去国旗 emoji。

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `action` | `add` \| `remove` | `add` | add=按地区加旗;remove=`stripFlags` 去掉名字里的旗 |
| `tw2cn` | `boolean?` | 省略 | 仅 add 生效:TW 节点渲染 🇨🇳 而非 🇹🇼。remove 时无效 |

add 流程:`detectRegion(name)` → 命中地区码 → 取 emoji → `"<emoji> " + stripFlags(name)`(先去旧旗再加,避免叠旗);识别不到地区则原样不动。

**alpha-2 与 alpha-3 都认**:`detectRegion` 对每个地区同时匹配 alpha-2(如 `HK` `JP` `SG`)与 alpha-3(如 `HKG` `JPN` `SGP`),`regionByCode` 也同时查两张表。所以节点统一命名成 3 位地区码也能正确加旗,**不必为加旗先把三位转两位**。

```yaml
- kind: flag-emoji
  action: add
  tw2cn: true
```

### 5. filter-type 类型过滤

按协议类型保留或剔除。

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `mode` | `keep` \| `drop` | `keep` | |
| `types` | `ProxyType[]` | `[]` | **空数组 = no-op**(原样返回) |

`ProxyType` 取值(`PROXY_TYPES`):`ss` `ssr` `vmess` `vless` `trojan` `hysteria` `hysteria2` `tuic` `snell` `anytls` `wireguard` `socks5` `http`。

```yaml
- kind: filter-type
  mode: drop
  types: [ss, ssr]
```

### 6. sort 排序

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `by` | `name` \| `type` \| `server` \| `region` | `name` | region 用 `detectRegion`,识别不到的排到末尾(键 `~~`) |
| `order` | `asc` \| `desc` | `asc` | |

排序用 `localeCompare('zh-Hans-CN', { numeric: true })`,稳定排序(同键保持原序)。

```yaml
- kind: sort
  by: region
  order: asc
```

### 7. set-prop 设属性

强制设置节点开关,三个字段全可选,**省略 = 保持原样**;仅当与现值不同才计入 changed。

| 参数 | 类型 | default | 写入节点字段 |
|---|---|---|---|
| `udp` | `boolean?` | 省略 | `udp` |
| `tfo` | `boolean?` | 省略 | `tfo` |
| `skipCertVerify` | `boolean?` | 省略 | `skip-cert-verify`(入参是 camelCase,落到节点是 kebab-case) |

```yaml
- kind: set-prop
  udp: true
  skipCertVerify: false
```

### 8. dedup 去重

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `by` | `name` \| `server-port` | `name` | server-port 用 `server:port` 作键 |
| `action` | `drop` \| `rename` | `drop` | drop=删重复;rename=保留并追加 ` #N`(N 为该键出现序号) |

无法算键的节点(如 server-port 模式下缺 server/port)**永不被去重**,原样保留。

```yaml
- kind: dedup
  by: server-port
  action: rename
```

### 9. filter-region 地区过滤

按 `detectRegion(name)` 得到的地区码保留或剔除。

| 参数 | 类型 | default | 说明 |
|---|---|---|---|
| `mode` | `keep` \| `drop` | `keep` | |
| `regions` | `string[]` | `[]` | **空数组 = no-op**。比较时转大写。**本参数须填 alpha-2 码(如 `HK` `JP`)**:引擎比对的是 `detectRegion(name)` 的返回值,而它恒为 alpha-2;填 `HKG` 这类 alpha-3 永不命中(节点名里写 `HKG` 不影响——`detectRegion` 仍认得并归一为 `HK`,但本参数得给 `HK`) |

```yaml
- kind: filter-region
  mode: keep
  regions: [HK, JP, SG, US]
```

## 顺序影响结果

算子按数组顺序依次作用,**顺序不同结果不同**。两类典型踩坑:

1. **先重命名再过滤 ≠ 先过滤再重命名**
   - `rename-regex` 改了名,后面的 `filter-regex` 是对**改后**的名匹配。
   - 例:先 `rename` 把 `HK01` 改成 `香港01`,再 `filter-regex pattern: HK` 就一个都命中不了。

2. **依赖名字识别地区的算子(`flag-emoji` / `filter-region` / `sort by region`)要排在"会抹掉地区线索的 rename"之前**
   - 这三者都靠 `detectRegion(name)`。若先 `rename` 删掉了名字里的地区码 / 中文地名,后面的 `flag-emoji` 加不出旗、`filter-region` 全落空。
   - 正确次序:先 `flag-emoji` / `filter-region` 吃到原始地区信息,再做会改写地区 token 的 rename。

落地任何正则类改动前,用 `preview_node_operators` 把整条候选管线对该源真实节点试算,看 before/after 与每步 dropped/changed 是否符合预期。

## 多算子管线示例

一条常见的"清洗→筛地区→加旗→去重→排序"管线(AI-facing 形态,不带 id):

```yaml
# 1) 先去掉流量/到期/官网等信息节点
- kind: filter-useless
  extra: ["测试", "回国"]
# 2) 删掉名字开头的 [机房] 前缀(只删方括号前缀,不动地区 token)
- kind: rename-regex
  pattern: "^\\[.*?\\]\\s*"
  replacement: ""
# 3) 只保留这几个地区(靠节点名识别;regions 这里一律填 alpha-2 码)
- kind: filter-region
  mode: keep
  regions: [HK, JP, SG, US]
# 4) 加国旗,台湾用中国旗
- kind: flag-emoji
  action: add
  tw2cn: true
# 5) 同名节点保留并编号
- kind: dedup
  by: name
  action: rename
# 6) 按地区排序
- kind: sort
  by: region
  order: asc
```

> 注:第 2 步那条 rename 只删机房方括号前缀,**不动地区 token**,所以放在 filter-region/flag-emoji 之前是安全的。如果某条 rename 会改写或删除地区码/地名,务必把它排到第 3、4 步之后。

## 写算子用的工具

- `list_node_sources` — 列出所有订阅源 / 聚合订阅及其算子(拿 source id 与算子 id)。
- `preview_node_operators` — 把整条候选管线对真实节点试算(只读,改正则前必做)。
- `add_operator` — 新增一步,可用 `position` 指定插入下标(0=最前,省略=追加)。
- `update_operator` — 按 `operator_id` 整条替换某步(可借此换 kind 或改任意参数,id 与位置不变)。
- `delete_operator` — 按 `operator_id` 删一步。
- `reorder_operators` — 传该源**全部**算子 id 的一个全排列以重排顺序。

以上写操作均需用户在确认卡中授权后才生效。
