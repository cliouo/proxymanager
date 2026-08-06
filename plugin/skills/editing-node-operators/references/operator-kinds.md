# 算子 kind 全表

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才读取。
> 事实来源：`web/schemas/operator.ts`、`web/lib/proxies/operators.ts`、`web/lib/proxies/regions.ts`、`web/lib/ai/actions/primitives/operatorWrites.ts`、system prompt L22。本表只写源码已证实的字段与行为。

## 目录 (TOC)

- [总则](#总则)
- [公共字段](#公共字段)
- [10 种算子](#10-种算子)
  - [1. filter-regex 正则过滤](#1-filter-regex-正则过滤)
  - [2. filter-useless 去无用节点](#2-filter-useless-去无用节点)
  - [3. rename-regex 正则重命名/删除](#3-rename-regex-正则重命名删除)
  - [4. flag-emoji 国旗](#4-flag-emoji-国旗)
  - [5. filter-type 类型过滤](#5-filter-type-类型过滤)
  - [6. sort 排序](#6-sort-排序)
  - [7. set-prop 设属性](#7-set-prop-设属性)
  - [8. dedup 去重](#8-dedup-去重)
  - [9. filter-region 地区过滤](#9-filter-region-地区过滤)
  - [10. rename-template 名称统一（模板命名）](#10-rename-template-名称统一模板命名)
- [顺序影响结果](#顺序影响结果)
- [多算子管线示例](#多算子管线示例)
- [写算子用的工具](#写算子用的工具)

## 总则

- 算子是订阅源(subscription)与聚合订阅(collection)上的一条**有序数组** `operators`，解析时(上游抓取并标准化后)按数组顺序逐个作用于已解析的 Clash 节点列表。
- **算子只过滤 / 改写 / 排序已有节点，绝不新增节点。** 10 种 kind 没有任何一种能造出节点；要真正多 / 少节点得改订阅源本身(加删源)。引擎对每个节点纯函数式处理:同样的节点 + 同样的算子恒得同样输出。
- 每步产出一条 trace(`OperatorStep`):`before` / `after` / `dropped`(被过滤数) / `changed`(改名或改属性数) / `applied`(disabled 时为 false)。`preview_node_operators` 返回这些以及 `orphanedReferences` / `orphanWarning`(改名/过滤会让链式后端、策略组成员、规则引用悬空的预警)。
- AI 给算子时**不要带 `id`**:服务端 materialize 时生成(add 用新 uuid,update 沿用原 id)。

## 公共字段

每种算子对象都含这两个公共字段(其余为各 kind 独有参数):

| 字段       | 类型       | 说明                                                                           |
| ---------- | ---------- | ------------------------------------------------------------------------------ |
| `kind`     | 字面量     | 判别字段,见下 10 种                                                            |
| `disabled` | `boolean?` | 可选。true=保留该步但本次跳过(不删除)。AI schema 仅省略 `id`,`disabled` 仍可设 |

> 注:`id` 在存储层存在(React key / 重排用),但 AI-facing schema 已 `omit id`——增删改算子时一律不填 id。

> 注:`rename-template` 每个管线**最多一个**(schema 在列表层强制,重复会得到指向违规步骤的可操作报错);存储层遇到重复时按存储原样保留第一个(不强制其启用态),后续重复停靠为 disabled + `compatibility_issue`。

## 10 种算子

下表 default 即 zod schema 的 `.default(...)`;不给该字段时取此值。

### 1. filter-regex 正则过滤

按**节点名**正则保留或剔除。

| 参数      | 类型                              | default | 说明                            |
| --------- | --------------------------------- | ------- | ------------------------------- |
| `mode`    | `keep` \| `drop`                  | `keep`  | keep=只留命中的;drop=剔除命中的 |
| `pattern` | string(非空,须能编译为 JS RegExp) | —       | 必填                            |
| `flags`   | string(`[gimsuy]*`)               | 省略    | 可选正则 flag                   |

行为细节(`compileTest`):测试用 `flags ?? 'i'`,即**默认大小写不敏感**;并会**剥掉 `g` / `y`** 以保证 `test()` 无状态。

```yaml
- kind: filter-regex
  mode: keep
  pattern: "\\bUS\\b" # 用单词边界,避免裸 us 误吃 A-us-tralia / R-us-sia
```

### 2. filter-useless 去无用节点

剔除流量 / 到期 / 广告 / 官网等信息性节点。内置垃圾词表(case-insensitive,OR 连接)含:`剩余流量` `剩余` `到期` `过期` `重置` `距离` `官网` `网址` `续费` `订阅` `邀请` `失联` `客服` `群组` `频道` `公告` `更新于` `套餐` `维护` `购买` `充值` `此处` `请勿` `禁止` `expire` `traffic` `reset` `remaining` `t\.me` `telegram` `https?://`。

| 参数    | 类型       | default | 说明                                                              |
| ------- | ---------- | ------- | ----------------------------------------------------------------- |
| `extra` | `string[]` | `[]`    | 追加到内置词表的额外关键词/正则片段(空白项被忽略),与内置表一起 OR |

```yaml
- kind: filter-useless
  extra: ["测试", "备用"]
```

### 3. rename-regex 正则重命名/删除

对节点名做 `name.replace(re, replacement)`。

| 参数          | 类型                  | default | 说明                        |
| ------------- | --------------------- | ------- | --------------------------- |
| `pattern`     | string(非空,须能编译) | —       | 必填                        |
| `replacement` | string                | `""`    | **空字符串 = 删除匹配片段** |
| `flags`       | string(`[gimsuy]*`)   | 省略    | 可选                        |

行为细节:`new RegExp(pattern, flags ?? 'g')`——**默认全局替换 `g`**(与 filter-regex 默认 `i` 不同)。

```yaml
- kind: rename-regex
  pattern: "^\\[.*?\\]\\s*" # 删掉名字开头的 [机房] 前缀
  replacement: ""
```

### 4. flag-emoji 国旗

按节点名识别地区,加 / 去国旗 emoji。

| 参数     | 类型              | default | 说明                                              |
| -------- | ----------------- | ------- | ------------------------------------------------- |
| `action` | `add` \| `remove` | `add`   | add=按地区加旗;remove=`stripFlags` 去掉名字里的旗 |
| `tw2cn`  | `boolean?`        | 省略    | 仅 add 生效:TW 节点渲染 🇨🇳 而非 🇹🇼。remove 时无效 |

add 流程:`detectRegion(name)` → 命中地区码 → 取 emoji → `"<emoji> " + stripFlags(name)`(先去旧旗再加,避免叠旗);识别不到地区则原样不动。

**alpha-2 与 alpha-3 都认**:`detectRegion` 对每个地区同时匹配 alpha-2(如 `HK` `JP` `SG`)与 alpha-3(如 `HKG` `JPN` `SGP`),`regionByCode` 也同时查两张表。所以节点统一命名成 3 位地区码也能正确加旗,**不必为加旗先把三位转两位**。

```yaml
- kind: flag-emoji
  action: add
  tw2cn: true
```

### 5. filter-type 类型过滤

按协议类型保留或剔除。

| 参数    | 类型             | default | 说明                         |
| ------- | ---------------- | ------- | ---------------------------- |
| `mode`  | `keep` \| `drop` | `keep`  |                              |
| `types` | `ProxyType[]`    | `[]`    | **空数组 = no-op**(原样返回) |

`ProxyType` 取值(`PROXY_TYPES`):`ss` `ssr` `vmess` `vless` `trojan` `hysteria` `hysteria2` `tuic` `snell` `anytls` `wireguard` `socks5` `http`。

```yaml
- kind: filter-type
  mode: drop
  types: [ss, ssr]
```

### 6. sort 排序

| 参数    | 类型                                     | default | 说明                                                 |
| ------- | ---------------------------------------- | ------- | ---------------------------------------------------- |
| `by`    | `name` \| `type` \| `server` \| `region` | `name`  | region 用 `detectRegion`,识别不到的排到末尾(键 `~~`) |
| `order` | `asc` \| `desc`                          | `asc`   |                                                      |

排序用 `localeCompare('zh-Hans-CN', { numeric: true })`,稳定排序(同键保持原序)。

```yaml
- kind: sort
  by: region
  order: asc
```

### 7. set-prop 设属性

强制设置节点开关,三个字段全可选,**省略 = 保持原样**;仅当与现值不同才计入 changed。

| 参数             | 类型       | default | 写入节点字段                                               |
| ---------------- | ---------- | ------- | ---------------------------------------------------------- |
| `udp`            | `boolean?` | 省略    | `udp`                                                      |
| `tfo`            | `boolean?` | 省略    | `tfo`                                                      |
| `skipCertVerify` | `boolean?` | 省略    | `skip-cert-verify`(入参是 camelCase,落到节点是 kebab-case) |

```yaml
- kind: set-prop
  udp: true
  skipCertVerify: false
```

### 8. dedup 去重

| 参数     | 类型                    | default | 说明                                                  |
| -------- | ----------------------- | ------- | ----------------------------------------------------- |
| `by`     | `name` \| `server-port` | `name`  | server-port 用 `server:port` 作键                     |
| `action` | `drop` \| `rename`      | `drop`  | drop=删重复;rename=保留并追加 ` #N`(N 为该键出现序号) |

无法算键的节点(如 server-port 模式下缺 server/port)**永不被去重**,原样保留。

```yaml
- kind: dedup
  by: server-port
  action: rename
```

### 9. filter-region 地区过滤

按 `detectRegion(name)` 得到的地区码保留或剔除。

| 参数      | 类型             | default | 说明                                                                                                                                                                                                                                                |
| --------- | ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `keep` \| `drop` | `keep`  |                                                                                                                                                                                                                                                     |
| `regions` | `string[]`       | `[]`    | **空数组 = no-op**。比较时转大写。**本参数须填 alpha-2 码(如 `HK` `JP`)**:引擎比对的是 `detectRegion(name)` 的返回值,而它恒为 alpha-2;填 `HKG` 这类 alpha-3 永不命中(节点名里写 `HKG` 不影响——`detectRegion` 仍认得并归一为 `HK`,但本参数得给 `HK`) |

```yaml
- kind: filter-region
  mode: keep
  regions: [HK, JP, SG, US]
```

### 10. rename-template 名称统一（模板命名）

按**占位符模板 DSL** 重组节点名。执行器（`lib/proxies/naming.ts`）是**纯确定性**的：同样的节点 + 同样的模板恒得同样输出，保存后对自身输出重跑是幂等 no-op；执行**从不调用模型**。它**只改名字**——不增删节点（但同配置节点会按来源优先级去重，见下）、不改变顺序，是架构上的命名专用算子；filter / dedup / sort / filter-useless / set-prop 仍是通用管线算子，数组顺序照旧影响结果。**每个管线最多一个**（列表层强制；存储层遇到重复时，按存储原样保留**第一个**出现的 rename-template——不强制其启用态，存为 disabled 就保持 disabled——后续重复项停靠为 disabled + `compatibility_issue`）。

| 参数               | 类型                          | default | 说明                                                                                                                                                            |
| ------------------ | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template`         | string（占位符 DSL，≤512 字） | —       | **持久化的唯一真源**。`${字段}` 必选、`${?字段: 内容}` 可选片段、`$$` 转义字面 `$`                                                                              |
| `tw2cn`            | `boolean?`                    | 省略    | 台湾节点用 🇨🇳（与 flag-emoji 的 tw2cn 同一语义）                                                                                                                |
| `sourceAliases`    | `Record<src-句柄, string>`    | 省略    | 手工来源别名覆盖：**键必须是 src- 不透明句柄**（list_naming_targets / 工作台投影得到），值为展示别名；≤64 项、单项 ≤40 字。普通来源名 / slug / 原始键一律被拒绝 |
| `recognitionRules` | `[{pattern, field, value}]`   | `[]`    | 保存并经校验的识别覆盖（AI-rule 事实）：pattern 有界正则命中则把 field 事实替换为 value；≤32 条、pattern ≤100 字、value ≤24 字                                  |

占位符白名单（闭集，其它一律拒绝）：

| 占位符           | 输出成分                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `${emoji}`       | 国旗 emoji（识别到地区才输出）                                                                                               |
| `${region}`      | 地区中文名（香港）                                                                                                           |
| `${region_code}` | 地区 alpha-2 码（HK）                                                                                                        |
| `${entry}`       | 「入口」（仅当命中入口 token 时）                                                                                            |
| `${route}`       | 路由提示（中转 / 直连 / 落地 / 入口，保守词表命中才输出）                                                                    |
| `${vendor}`      | 服务商 / 机场提示（保守词表命中才输出）                                                                                      |
| `${source}`      | 来源订阅别名（单订阅 = 自身别名；聚合订阅 = 各成员别名）                                                                     |
| `${protocol}`    | 节点结构化 type 字段；`${protocol:upper}` / `${protocol:lower}` 控制大小写                                                   |
| `${rate}`        | 倍率（如 `2x`；**1x 默认省略**，`${rate:include1x}` 恒显示）                                                                 |
| `${index}`       | 按来源稳定的序号（01 / 02 …）；`${index:N}` 设宽度（**N 只能是 1–4 的整数**，0/5/9999 一律拒绝，渲染端再夹紧，杜绝超大输出） |
| `${note}`        | 识别后的残余名称片段（「备注」；默认模板**不含**它，可自行加）                                                               |

模板写法要点：

- **国旗 + 地区是一个视觉块**，用普通空格：`${emoji} ${region}` → `🇭🇰 香港`。
- 分隔符是**模板里的字面文本**，不是全局设置；写在可选片段内部，字段缺失时**整段（含分隔符）消失**，不留悬空分隔符。默认推荐模板：
  `${emoji} ${region}${?route: · ${route}}${?source: · ${source}}${?index: · ${index}}${?rate: · ${rate}}`（聚合含来源段；单订阅推荐模板不含 `${?source: …}`）。
- 校验拒绝：未知占位符、未闭合 `$ {`、可选片段嵌套 >2 层、长度 >512、无任何必填内容（可能渲染空）、以及任何 eval / 循环 / 任意代码形态。渲染为空时兜底回退原节点名。
- **最终改名阶段**：启用态的「名称统一」之后不允许再出现 rename-regex（非空 pattern）或 flag-emoji——会二次改名，保存 / 预览一律拒绝（错误指明步骤位置）；过滤 / 去重 / 排序 / 设属性 / 去无用仍可排在它之后。

识别（`recognizeName`）只取可靠信号，其余原样留在 base（note）：flag emoji 或地区词表（alpha-2 / alpha-3 都认）→ 地区码；保守词表（`中转` `直连` `落地` `入口`；`Nexitally` `TAG` `N3` 等）→ route / vendor；有界倍率正则（1–3 位整数 + ≤2 位小数 + `x`/`×`）→ rate。**语义识别跑在去掉已生成来源别名后的名字上**（避免别名成分偷走表序识别，如别名「香港」不能抢走更靠前的「日本」）；仅当剥离别名会让地区为空时，才用未剥离输入的识别结果补地区。来源别名已在名字里时不会重复输出（按分隔符边界剥离）；word-internal 出现（`机场A号`）不动。`recognitionRules` 在保守表之后确定性覆盖对应字段，并把命中跨度从残片中移除。

序号与碰撞（`applyRenameTemplate`）：

- **真去重按节点身份**（连接配置的规范指纹：类型 + 服务器 + 端口 + 凭证 + 协议结构字段），**不是名字**：同名不同配置的两个节点**都保留**；同配置不同名字只保留第一个（来源优先级 = 输入顺序），被丢弃者在 preview 的 `deduped` 里带诊断溯源。指纹在**抓取边界**就附着在不可变信封上（枚举 Symbol），任何算子（set-prop 等）之后都读同一个原始指纹——即使两个节点的配置在处理后趋同也**不会**被误并；跨源同名不同身份在托管路径下**双双存活**（后者加「来源名」确定性后缀，`collisions.resolvedTo` 报告），同身份才按来源优先级去重。身份指纹永不进入任何 API / AI 载荷。
- 序号解析顺序：**无歧义的上游序号**（`香港 05` 复用 05）→ **服务端持久化指派**（按 来源+指纹 单调不复用，只派发给没有上游序号的节点）→ 输入顺序。宽度 = max(2, 该来源最大序号的位数)。只读预览 / 保存预检与首次渲染、两个导出对每个节点算出**完全相同的序号与最终名**，且预览预检零写入（持久化指派值就是预览算出的输入顺序值）。
- 最终名**全局唯一**：先保留每个未改名节点的第一次出现（未改名的节点绝不被后来的改名节点挤走）；改名候选按输入顺序分配，冲突先用**有意义的「来源-序号」后缀**（` · 香港-01`）消歧，仍冲突再叠 ` #N`（N = 2, 3 …）。幂等：对自身输出重跑 secondChanged=0；碰撞出现在 preview 的 `collisions` 里。

旧版兼容：存量 preset / components / regionLabel / rateDisplay / separator 行**只读解码**，确定性投影为等价模板（国旗+地区合并为一个空格视觉块、legacy 分隔符保留在可选片段内、residual 映射到 `${?note: …}`）；原始字节在用户显式保存前**原样保留**（restoreRawOperators）。当前写接口**拒绝**模板与旧成分同时提交（ambiguous dual configuration）。

智能命名（**可选、辅助**，不是前置条件也不是算子替代）：工作台 /「智能命名」页可用 AI **组合式**命名循环——`list_naming_targets` → `inspect_naming_fields` / `inspect_source_name_clusters` / `inspect_naming_collisions` / `inspect_node_parse` / `preview_naming_recognition` / `inspect_naming_drift` → `preview_naming_target`（同一方案原样往返）→ `save_naming_plan`（**一张确认卡**、CAS 保存）。AI 只读迭代无需打断；**任何渲染相关写入都要确认卡**。所有 AI 载荷都过**有界脱敏投影**：原始节点名经结构化脱敏后可作为有界显示文本（`HK-01`、`IPLC`、`Nexitally`、`2x`、`家宽` 等安全标签保留），来源显示标签、规范协议、识别事实/规则/计数/置信度同样可见；**不发**订阅 URL / 内容、服务器 / 主机 / IP / 端口 / SNI、UUID / 密码 / 密钥、头 / Cookie / 会话、完整 proxy 对象、原始指纹、原始数据库 id、稳定存储键、无关配置或未限界诊断。节点用不透明句柄（`nd-` 前缀的 keyed HMAC-SHA256 令牌，服务端密钥签名，不可离线反推）。无 AI 配置时「智能命名」页照常工作（确定性推荐模板 + 手动编辑 + 预览）。

位置与顺序：rename-template 读的是**当前**名字，所以排在它前面的 rename-regex / 其它改名步骤会改变它看到的名字，排在它后面的识别类算子（flag-emoji / filter-region / sort by region）会看到重组后的名字——顺序影响规则对它同样成立。与 rename-regex 可并存（如先 rename-regex 清前缀、再 rename-template 统一命名）。

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

- `list_node_sources` — 列出所有订阅源 / 聚合订阅及其算子(拿 profile-bound 不透明 `ref` 与算子 handle；算子字段只含 handle/kind/disabled，不含正则等原文)。
- `preview_node_operators` — 把整条候选管线对真实节点试算(只读,改正则前必做)。
- `add_operator` — 新增一步,可用 `position` 指定插入下标(0=最前,省略=追加)。
- `update_operator` — 按 `operator_handle` 整条替换某步(可借此换 kind 或改任意参数,id 与位置不变)。
- `delete_operator` — 按 `operator_handle` 删一步。
- `reorder_operators` — 传该源**全部**算子 handle 的一个全排列以重排顺序；失效/过期 handle 会被拒绝，需重新 list_node_sources。

以上写操作均需用户在确认卡中授权后才生效。
