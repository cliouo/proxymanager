# 改名 cookbook（rename-regex / 本地源改名）

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才读取。
> 全部内容取自源码事实：`schemas/operator.ts`、`lib/proxies/operators.ts`、`lib/proxies/regions.ts`、`lib/ai/actions/primitives/{operatorWrites,localNodeWrites}.ts`，以及原 system prompt L22–L23（节点处理/算子 + 本地源改名条目，现已拆入本 spoke 的 SKILL.md §3–§4）。

## 目录 (TOC)
- [1. rename-regex 算子语义（先记死这几条）](#1-rename-regex-算子语义先记死这几条)
- [2. 远程源只能算子，本地源两条路](#2-远程源只能算子本地源两条路)
- [3. rename-regex cookbook（可直接复制）](#3-rename-regex-cookbook可直接复制)
- [4. 地区码两位↔三位归一化](#4-地区码两位三位归一化)
- [5. 与加旗的顺序配合（先归一后加旗）](#5-与加旗的顺序配合先归一后加旗)
- [6. 裸地区码的经典坑（边界）](#6-裸地区码的经典坑边界)
- [7. 改名会断引用：先 preview / 看 referencedBy](#7-改名会断引用先-preview--看-referencedby)

---

## 1. rename-regex 算子语义（先记死这几条）

字段（`RenameRegexOpSchema`）：

| 字段 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- |
| `kind` | 是 | — | 字面量 `rename-regex` |
| `pattern` | 是 | — | 非空，且必须能被 `new RegExp()` 编译，否则校验报「不是合法的正则表达式」 |
| `replacement` | 否 | `''`（空串） | 空 replacement = 删除匹配段 |
| `flags` | 否 | 见下 | 只允许 `[gimsuy]`，非法 flag 直接拒收 |

引擎行为（`operators.ts` `case 'rename-regex'`）：

```ts
const re = new RegExp(op.pattern, op.flags ?? 'g');   // 不给 flags 时默认 'g'
const next = name.replace(re, op.replacement ?? '');  // 原生 String.replace
```

- 只动节点的 **name** 字段，绝不增删节点（filter 才删，rename 永远 `dropped: 0`，只累加 `changed`）。
- **默认 flag 是 `g`**（全局替换整名所有命中），要忽略大小写得显式写 `flags: "gi"`。
- 用的是原生 `String.replace`，所以 `replacement` 里 `$1` / `$<name>` / `$&` 等捕获组反向引用照常生效。
- `pattern` 是你给的**原始正则**，引擎不会替你加任何单词边界（与地区检测里 `code2()` 的 `(?<![A-Za-z])…(?![A-Za-z])` 不同）——边界要自己写，见 §6。
- 一个 rename-regex 只有**一个固定 `replacement`**，无法在同一个算子里把 `HKG→HK`、`JPN→JP` 各映射到不同输出；多套映射 = 多个算子（或在 replacement 用捕获组做统一变换）。

## 2. 远程源只能算子，本地源两条路

| 源类型 | 直接改源内容 | rename-regex 算子 |
| --- | --- | --- |
| 远程订阅源（`kind != 'local'`） | ✗ 节点来自上游，不可直接编辑（`rename_local_node` 对其报 422，提示改用算子） | ✓ 唯一改名手段 |
| 本地订阅源（`kind == 'local'`，内容用户自填） | ✓ `rename_local_node` 单点精确改名 | ✓ 同样生效（批量 / 按正则） |
| 聚合订阅（collection） | ✗ 无自有原始内容 | ✓ 对合并后的成员节点跑算子 |

两条路的区别（都已被源码证实）：

- **算子（rename-regex，叠加层）**：写进 `sub.operators` / `collection.operators` 数组，**抗订阅更新**——每次 resolve 重新抓取后按管线重算。批量、可正则、可预览、可重排。改远程源唯此一途。
- **`rename_local_node`（改源本体，永久）**：直接改本地源 `content` 里那条节点的 `name`，其它配置与凭证（password/uuid/psk…）原样保留，落库时把内容标准化成 Clash `proxies:` YAML。只认本地源；`from` 必须精确匹配且唯一（重名会 409 让你先消歧，目标名已存在也 409）。脱敏：list/diff 都只露 name+type，绝不外泄凭证。

> 选择：本地源单点偶发改名 → `rename_local_node`；本地或远程的批量 / 规则化改名 → rename-regex 算子。

## 3. rename-regex cookbook（可直接复制）

下面每行给出 `pattern` / `replacement` / 建议 `flags` 三元组。空 replacement 写作 `""`。

| 目的 | pattern | replacement | flags | 说明 |
| --- | --- | --- | --- | --- |
| 删机场名前缀「XXX\|」 | `^[^\|]*\|` | `""` | `g` | 删到第一个竖线为止 |
| 删倍率标注（如 `1.5x`/`2倍`） | `\s*[\d.]+\s*[xX×倍]\s*` | `""` | `g` | 名里残留倍率信息 |
| 删各类括号注释 | `【[^】]*】\|\[[^\]]*\]\|（[^）]*）\|\([^)]*\)` | `""` | `g` | 中英文方/圆括号一并清 |
| 折叠多余空白 | `\s{2,}` | `" "` | `g` | 清洗后收尾 |
| 统一分隔符 `-`/`_`→空格 | `[\-_]+` | `" "` | `g` | — |
| 序号补零（1→01，捕获组） | `(?<![A-Za-z\d])(\d)(?![\d])` | `0$1` | `g` | 用 `$1` 反向引用演示 |
| 整段重打标签（含捕获） | `^.*(HK\|JP\|US).*$` | `节点-$1` | `g` | 提取地区码重排版式 |

落地前用 `preview_node_operators` 把整条候选管线对该源真实节点试算，核对 before/after 与每步 `changed`，确认命中无误再 `add_operator` / `update_operator`（均需用户确认）。

## 4. 地区码两位↔三位归一化

事实基础（`regions.ts`）：地区检测对 **alpha-2(`HK`)** 与 **alpha-3(`HKG`)** 都认（alpha-3 由 `alpha3` 字段经 `code2()` 追加为带边界的匹配）。所以这里的「归一化」是为了**显示统一**，不是加旗的前置必需（加旗本身不挑两位/三位，见 §5）。

由于一个算子只有一个固定 replacement，**每个地区一条 rename-regex**。模板（务必带边界，见 §6）：

- 三位 → 两位：`pattern = (?<![A-Za-z])HKG(?![A-Za-z])`，`replacement = HK`，`flags = gi`
- 两位 → 三位：`pattern = (?<![A-Za-z])HK(?![A-Za-z])`，`replacement = HKG`，`flags = g`（两位转三位别加 `i`，免得误伤大小写不同的真单词）
- 中文 → 码（顺带统一）：`pattern = 香港`，`replacement = HK`，`flags = g`

对照表（源自 `lib/proxies/regions.ts` 的 `REGIONS`，alpha-2 ↔ alpha-3）：

| 地区 | 2位 | 3位 | 地区 | 2位 | 3位 | 地区 | 2位 | 3位 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 香港 | HK | HKG | 美国 | US | USA | 意大利 | IT | ITA |
| 台湾 | TW | TWN | 英国 | GB | GBR | 西班牙 | ES | ESP |
| 日本 | JP | JPN | 德国 | DE | DEU | 巴西 | BR | BRA |
| 韩国 | KR | KOR | 法国 | FR | FRA | 阿根廷 | AR | ARG |
| 新加坡 | SG | SGP | 荷兰 | NL | NLD | 中国 | CN | CHN |
| 加拿大 | CA | CAN | 俄罗斯 | RU | RUS | 丹麦 | DK | DNK |
| 澳大利亚 | AU | AUS | 印度 | IN | IND | 冰岛 | IS | ISL |
| 土耳其 | TR | TUR | 马来西亚 | MY | MYS | 波兰 | PL | POL |
| 泰国 | TH | THA | 越南 | VN | VNM | 阿联酋 | AE | ARE |
| 菲律宾 | PH | PHL | 印尼 | ID | IDN | 尼日利亚 | NG | NGA |
| 巴基斯坦 | PK | PAK | 乌克兰 | UA | UKR | | | |

> 完整且权威的列表以 `lib/proxies/regions.ts` 的 `REGIONS` 为准（含每区的中文/英文/城市别名）。

## 5. 与加旗的顺序配合（先归一后加旗）

flag-emoji（add）的引擎事实：先 `detectRegion(name)` 识别地区（优先名里已有的旗，其次中文/英文/城市/地区码），命中后 `${emoji} ${stripFlags(name)}` —— **先剥掉旧旗再把新旗加到最前**。`tw2cn: true` 时把 TW 节点渲染成 🇨🇳。识别不到地区的节点原样跳过（不加旗）。

因此**管线顺序：rename-regex（归一/清洗）在前，flag-emoji（add）在后**：

1. 先用 rename 把地区 token 清洗/补全成可识别形态（中文或两位/三位码皆可），让 `detectRegion` 必中；
2. 再 flag-emoji add 加旗——它会自己 `stripFlags` 去旧旗、统一前缀。
3. 若顺序反过来（先加旗、后 rename），rename 的 pattern 一旦碰到名字开头就可能把刚加的旗 emoji 一起改坏。

注意：归一化**不是加旗的必要前提**——alpha-2 与 alpha-3 都被识别，把节点统一成 3 位码同样能正确加旗，不必为了加旗专门把三位转两位（本 spoke SKILL.md §3「flag-emoji 地区码」明确，源自原 system prompt L22）。归一主要服务于「名字整齐」本身。

顺序会改变结果是算子的通则（`reorder_operators` 描述亦载明「先重命名再过滤」≠「先过滤再重命名」）。

## 6. 裸地区码的经典坑（边界）

rename-regex 用你的**原始 pattern**，不会自动加边界。裸两位/三位码会咬进更长单词：

- `pattern: US`（无边界）→ 会命中 `R[us]sia`、`A[us]tralia` 内部，replace 后把单词改烂。
- `preview_node_operators` 描述里也点名此坑：裸 `us` 会顺带吃进 A-us-tralia / R-us-sia。

正确写法（与 `regions.ts` 的 `code2()` 同款 lookaround，Node/V8 支持 lookbehind，代码库本身就在用）：

```
(?<![A-Za-z])US(?![A-Za-z])
```

- 仅在两侧都不是拉丁字母时命中，`Russia`/`Australia`/`HKG` 内的子串不会误触。
- 改完务必 `preview_node_operators` 看 before/after 抽查，别凭空相信正则。

## 7. 改名会断引用：先 preview / 看 referencedBy

改名（rename-regex 或 rename_local_node）会改变节点名，而**节点是按名被引用的**——链式代理后端（chain-backend）、策略组成员、规则都可能按旧名钉住它。改名后旧名消失即 orphan（跨链 orphan-references）；其中 **chain-backend 引用悬空会让整份配置在 mihomo 加载时直接崩**。

两个只读前置工具会把这风险摆到台面，落地前必看：

- **`preview_node_operators`**：对消失的名字跑 `findNodeReferences`，返回 `orphanedReferences`；非空时附 `orphanWarning`（明确点名 chain-backend 会导致配置无法加载）。改算子前先跑它。
- **`list_local_nodes`**：每个本地节点带 `referencedBy`（被哪些 chain-backend / 策略组成员 / 规则按名引用）。某节点 `referencedBy` 非空就先警示用户、并提议一并更新这些引用，再 `rename_local_node`。

处置：若 preview 显示有引用悬空，先告知用户、提议在改名的同一轮里把这些引用一起更新（改策略组成员 / 规则 / 链式后端指向新名），切勿闷头改名后留下断链。
