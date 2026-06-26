# filter 正则 cookbook

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向它时才读取。

策略组的 `filter`（配 `exclude_filter`）怎么写才不误伤、怎么先试算再落地，以及和「节点处理算子」的配合。所有结论均出自 `web/lib/proxies/filterMatch.ts`、`web/lib/proxies/regions.ts`、`web/lib/proxies/operators.ts`、`web/lib/ai/actions/primitives/proxyGroupWrites.ts` 与 system prompt L18/L22-24。

## 目录 (TOC)
- [filter 的语义（先搞清匹配规则）](#filter-的语义先搞清匹配规则)
- [单词边界 \bUS\b 防 A-us-tralia / R-us-sia](#单词边界-busb-防-a-us-tralia--r-us-sia)
- [常用地区正则表（可复制）](#常用地区正则表可复制)
- [exclude-filter 模式](#exclude-filter-模式)
- [preview_proxy_group_members 试算演练（改 filter 前必做）](#preview_proxy_group_members-试算演练改-filter-前必做)
- [与算子 rename / flag-emoji 的配合](#与算子-rename--flag-emoji-的配合)

## filter 的语义（先搞清匹配规则）

来自 `filterMatch.ts` 头注与 `preview_proxy_group_members` 描述：

- `filter` 是对**节点名**的**非锚定**正则（Go RE2 语义）：命中即保留。
- 再用 `exclude_filter`（落盘字段名 `exclude-filter`）把命中里匹配的节点**剔除**。
- 仅对 `kind=filter` 且 `include_all_proxies=true` 的组生效：先纳入全部节点，再正则筛。
- 非正则的 `exclude_type` 是另一回事：按节点类型排除（如 `Direct,Reject`），不要拿它筛地区。

正则引擎的两处工程细节（`compileGoRegex`）务必记牢：

| 事实 | 含义 |
|---|---|
| 预览用 **JS RegExp** 编译，mihomo 下发用 **Go RE2** | 二者都支持 `\b`；但 JS 独有的环视等特性可能**预览通过、mihomo 加载失败** |
| 仅 pattern **开头**的内联 flag 组 `(?i)` / `(?is)` / `(?ism)` 会被抬升成 JS flag | 只保留 `i`/`s`/`m`，其余 Go-only flag 丢弃。要忽略大小写就把 `(?i)` 放最前 |
| 非法正则不抛异常 | 返回 `regexError` 字符串（预览里能直接看到），不会让调用崩溃 |

> 结论：下发 filter 只用 `\b` 单词边界做锚定，**不要**用 `(?<!...)`/`(?=...)` 环视——RE2 不支持，会过了预览却炸内核。

## 单词边界 \bUS\b 防 A-us-tralia / R-us-sia

system prompt L18 明列的经典坑：

```
裸 us  →  误吃 A-us-tralia / R-us-sia
正确    →  \bUS\b   或   国旗 emoji 锚定
```

- 裸 `us`/`hk` 这类两三字母码是**子串**匹配，会钻进 Australia、Russia、HKG 之类的更长单词里。
- 用 `\b` 单词边界把码两侧钉死：`\bUS\b`、`\bHK\b`。RE2 与 JS 都支持，下发安全。
- 要大小写都认：`(?i)\bus\b`（`(?i)` 必须在最前，才会被 `compileGoRegex` 抬升）。
- 更稳的做法是锚定**国旗 emoji**（见地区表），名字里只要带 🇺🇸 就唯一确定地区，根本不会撞子串。

> 旁证：`regions.ts` 的内部地区识别用的是更严格的 `(?<![A-Za-z])US(?![A-Za-z])`（`code2()`），它能同时挡住前后两侧。但那是 JS 侧识别器；**RE2 不支持环视**，所以写进策略组 filter 仍用 `\bUS\b`。

## 常用地区正则表（可复制）

下表的「地区码 / alpha-3 / 国旗 / 关键词」均取自 `regions.ts` 的 `REGIONS`。识别走**两路**：① 国旗 emoji；② 地区码——**alpha-2 与 alpha-3 都认**（`HK` 与 `HKG`、`SG` 与 `SGP` 等价），且都加了单词边界。下发 filter 时把这两路用 `|` 或起来最稳。

| 地区 | code | alpha-3 | 国旗 | 关键词（节点名里常见） | 建议 filter（含 emoji + 边界码） |
|---|---|---|---|---|---|
| 香港 | HK | HKG | 🇭🇰 | 香港/港岛/Hong Kong | `(?i)🇭🇰\|香港\|\bHKG?\b` |
| 台湾 | TW | TWN | 🇹🇼 | 台湾/臺灣/台北/Taiwan | `(?i)🇹🇼\|台湾\|臺灣\|\bTWN?\b` |
| 日本 | JP | JPN | 🇯🇵 | 日本/东京/大阪/Tokyo | `(?i)🇯🇵\|日本\|东京\|\bJPN?\b` |
| 韩国 | KR | KOR | 🇰🇷 | 韩国/首尔/Korea/Seoul | `(?i)🇰🇷\|韩国\|首尔\|\bKOR?\b` |
| 新加坡 | SG | SGP | 🇸🇬 | 新加坡/狮城/Singapore | `(?i)🇸🇬\|新加坡\|狮城\|\bSGP?\b` |
| 美国 | US | USA | 🇺🇸 | 美国/洛杉矶/纽约/United States | `(?i)🇺🇸\|美国\|\bUSA?\b` |
| 英国 | GB | GBR | 🇬🇧 | 英国/伦敦/London（码 UK 与 GB 都认） | `(?i)🇬🇧\|英国\|\b(UK\|GBR?)\b` |
| 德国 | DE | DEU | 🇩🇪 | 德国/法兰克福/Frankfurt | `(?i)🇩🇪\|德国\|\bDEU?\b` |
| 法国 | FR | FRA | 🇫🇷 | 法国/巴黎/Paris | `(?i)🇫🇷\|法国\|\bFRA?\b` |
| 荷兰 | NL | NLD | 🇳🇱 | 荷兰/阿姆斯特丹/Amsterdam | `(?i)🇳🇱\|荷兰\|\bNLD?\b` |
| 加拿大 | CA | CAN | 🇨🇦 | 加拿大/多伦多/Toronto | `(?i)🇨🇦\|加拿大\|\bCAN?\b` |
| 澳大利亚 | AU | AUS | 🇦🇺 | 澳洲/悉尼/Sydney | `(?i)🇦🇺\|澳洲\|澳大利亚\|\bAUS?\b` |
| 俄罗斯 | RU | RUS | 🇷🇺 | 俄罗斯/莫斯科/Moscow | `(?i)🇷🇺\|俄罗斯\|\bRUS?\b` |
| 印度 | IN | IND | 🇮🇳 | 印度/孟买/Mumbai | `(?i)🇮🇳\|印度\|\bIND?\b` |

注：
- `\bHKG?\b` 这种写法一条同时盖 `HK` 和 `HKG`（`G?` 可选第三字母）；觉得绕就直接 `\b(HK\|HKG)\b`。
- `REGIONS` 还含 TR/MY/TH/VN/PH/ID/IT/ES/BR/AR/CN/DK/IS/PL/AE/NG/PK/UA 等（结构同上：code + alpha3 + emoji + 关键词），需要时按同一套路拼。
- 表里关键词只列了高频项，`REGIONS` 每个地区的 `patterns` 还有更多别名/城市；拿不准就**先 preview 再下发**。

## exclude-filter 模式

`exclude_filter` 在 `filter` 命中之后再做一轮减法（同样非锚定正则）。常见用法：

| 目的 | exclude_filter 示例 |
|---|---|
| 排掉测速/官网/到期等非落地条目 | `(?i)官网\|剩余\|过期\|到期\|流量\|expire\|traffic\|GB` |
| 排掉高倍率节点 | `(?i)\b[2-9]x\b\|[2-9]\.0x\|倍率` |
| 地区组里再剔除某子区/中转 | `(?i)中转\|relay\|游戏\|game` |
| 只排某类型节点 | 用 `exclude_type`（如 `Direct,Reject`），不是 `exclude_filter` |

要点：`filter` 负责「圈进来」，`exclude_filter` 负责「再剔出去」；两者都对**同一份节点名**跑。能用一条 `filter` 精确表达就别堆 `exclude_filter`，链路越短越好预测。

## preview_proxy_group_members 试算演练（改 filter 前必做）

system prompt L18 硬性要求：**改地区组 / 筛选组的 `filter` 或 `exclude_filter` 之前，先 `preview_proxy_group_members` 拿候选正则对真实节点名试算，确认命中正是想要的，再发 `update_proxy_group`。** 该工具只读、不改配置。

入参（`id` / `filter` / `exclude_filter` 至少给一个）：

| 入参 | 说明 |
|---|---|
| `id` | 已有组 id（先 `list_proxy_groups` 拿）；只给 id 时默认用该组**现有的** filter/exclude-filter |
| `filter` | 候选 filter，给了就**覆盖**该组现有 filter 来试算 |
| `exclude_filter` | 候选 exclude-filter，给了就覆盖现有的 |

返回（`data`）：`group`、`filter`、`exclude-filter`、`poolSize`（候选池节点总数）、`matchedCount`、`matched`（命中名单，超量会截断，`truncated=true`）、`regexError`（正则非法时的报错串）、`hint`。

标准演练流程：

1. `list_proxy_groups` 找到目标组 id 与现状。
2. `preview_proxy_group_members` 传**候选** filter（先别带 `id` 的旧值，或带 id 看现状基线）跑一遍。
3. 看 `matched`：该进的进了吗？看 `matchedCount` vs `poolSize`：是不是裸 `us` 把 Australia/Russia 也吃进来了？看 `regexError`：是否写错。
4. 不对就改正则重跑（试 `\bUS\b`、加 emoji 路、补 `exclude_filter`），直到名单干净。
5. 满意后才 `update_proxy_group`（需用户确认）。

> 优化前后都该 preview：改前确认旧行为、改后确认新行为，对比 `matched` 差异。

## 与算子 rename / flag-emoji 的配合

策略组 filter 跑在**渲染期**、面对的是「节点处理算子」管线产出的**最终节点名**。所以让 filter 稳，常常先在上游用算子把名字规整好（system prompt L22-24）：

- **flag-emoji（add）**：按名字里的地区码补国旗，**alpha-2(HK)/alpha-3(HKG) 都认**；`tw2cn` 让台湾用中国旗。上游统一加了 emoji，下游 filter 就能锚 `🇺🇸` 这种唯一标识，彻底躲开子串坑。
- **rename-regex**：`pattern` + `replacement`（空 `replacement` = 删除匹配），默认 flag `g`。可把杂乱命名统一成「`🇺🇸 US-01`」式，让 `\bUS\b` / emoji 都好命中。
- **顺序敏感**：算子按管线顺序依次作用，「先重命名再过滤」≠「先过滤再重命名」。
- **改名/过滤前先 `preview_node_operators` 干跑**：看 before/after 与每步增删改，并看 `orphanedReferences` / `orphanWarning`——按名字钉进**链式代理后端**的引用一旦悬空，会让整份配置在 mihomo 里**加载失败**。有引用先告知用户、提议一并更新，再落地。
- 分工别混：要「多/少节点」得改订阅源本身；算子只过滤/改写/排序已有节点；策略组 filter 只在已有节点里圈选。三层各管各的。
