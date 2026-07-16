# filter 正则 cookbook

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向它时才读取。

策略组的 `filter` / `exclude_filter` 用来对最终节点名做筛选。改写前后都必须用
`preview_proxy_group_members` 在真实节点池上试算。

## 语义与固定引擎

- `filter` 是非锚定匹配：任一 pattern 命中则保留。
- `exclude-filter` 在保留集合上做减法：任一 pattern 命中则剔除。
- 多条独立 pattern 用反引号分隔；`|` 只是一条 pattern 内的交替。
- `exclude_type` 不是正则：它用 `|` 分隔固定 AdapterType，例如 `Direct|Reject`，不得有空格、空项或重复项。
- `kind` 是 UI 意图标记，不改变内核字段语义；通常用 `kind=filter` + `include_all_proxies=true`。

固定 Mihomo v1.19.28 使用 `github.com/dlclark/regexp2`，不是 Go RE2。ProxyManager 预览只接受
有界、经 ReDoS 检查的 ECMAScript/regexp2 公共子集：

- 支持固定内核也支持的环视和反向引用，但仍要通过长度与 ReDoS 检查。
- pattern 开头可用 `(?i)` / `(?is)` / `(?ism)`；其它内联 flag 直接拒绝。
- 使用 `(?i)` 时，拒绝会参与 Unicode 大小写折叠的非 ASCII 字符及其 `\\u` / `\\x` 转义（如 `K`、`ß`、`ẞ`）；中文、日文、emoji 等无大小写字符仍可用。这避免固定 regexp2 的 Unicode fold 把不同分支折叠成指数回溯。
- 拒绝 JS 与 regexp2 语义不同的 `\b` / `\w` / `\d` / `\s` / `\p`，以及
  regexp2 不接受的 `[]` / `[^]` / `\u{...}`。
- 每条 pattern 与每个节点名最长 512 字符；最终渲染最多 32 条 pattern。
- 不安全或不可移植的正则会返回 `regexError`，不会被静默改写。

## 显式 ASCII 边界

裸 `us` 会误吃 A-**us**-tralia / R-**us**-sia。不要用已禁用的 `\bUS\b`；用明确字母边界：

```text
(?<![A-Za-z])US(?![A-Za-z])
```

要同时认 US/USA：

```text
(?i)(?<![A-Za-z])USA?(?![A-Za-z])
```

有国旗或中文地名时优先用它们，它们比字母码更不易误伤。

## 常用地区 filter

| 地区     | 建议 filter |
| -------- | ----------- | ------ | ------------------------------ | ------------------------------ | ------------------------------ |
| 香港     | `(?i)🇭🇰     | 香港   | (?<![A-Za-z])HKG?(?![A-Za-z])` |
| 台湾     | `(?i)🇹🇼     | 台湾   | 臺灣                           | 台北                           | (?<![A-Za-z])TWN?(?![A-Za-z])` |
| 日本     | `(?i)🇯🇵     | 日本   | 东京                           | (?<![A-Za-z])JPN?(?![A-Za-z])` |
| 韩国     | `(?i)🇰🇷     | 韩国   | 首尔                           | (?<![A-Za-z])KOR?(?![A-Za-z])` |
| 新加坡   | `(?i)🇸🇬     | 新加坡 | 狮城                           | (?<![A-Za-z])SGP?(?![A-Za-z])` |
| 美国     | `(?i)🇺🇸     | 美国   | (?<![A-Za-z])USA?(?![A-Za-z])` |
| 英国     | `(?i)🇬🇧     | 英国   | (?<![A-Za-z])(?:UK             | GB                             | GBR)(?![A-Za-z])`              |
| 德国     | `(?i)🇩🇪     | 德国   | (?<![A-Za-z])(?:DE             | DEU)(?![A-Za-z])`              |
| 澳大利亚 | `(?i)🇦🇺     | 澳洲   | 澳大利亚                       | (?<![A-Za-z])AUS?(?![A-Za-z])` |
| 俄罗斯   | `(?i)🇷🇺     | 俄罗斯 | (?<![A-Za-z])RUS?(?![A-Za-z])` |

表中只是候选；节点命名不统一时，以 preview 的实际名单为准。

## exclude-filter 与链式克隆

| 目的                   | `exclude_filter` 示例    |
| ---------------------- | ------------------------ | ------------------------------ | ---- | ----- | ---- | ------ | -------- |
| 排掉官网/到期/流量信息 | `(?i)官网                | 剩余                           | 过期 | 到期  | 流量 | expire | traffic` |
| 排掉中转/游戏线        | `(?i)中转                | relay                          | 游戏 | game` |
| 排掉类型               | 用 `exclude_type: Direct | Reject`，不是 `exclude_filter` |

对 `include-all-proxies` / `include-all` 组，渲染器会把用户现有 `exclude-filter` 原样保留，
再用反引号追加自动生成的链式克隆精确排除模式。不能用 `|` 拼接，否则会改变用户原 pattern 的分组语义。

动态组没有显式成员时，渲染器默认补 `empty-fallback: REJECT`，防止空结果静默落到
`COMPATIBLE`。显式 fallback 只能指向 concrete proxy 或内建目标，不能指向另一个策略组。

## preview 闭环

1. `list_proxy_groups` 拿目标 id 和现有字段。
2. `preview_proxy_group_members` 先跑现状，再传候选 `filter` / `exclude_filter`。
3. 核对 `poolSize` / `matchedCount` / `matched` / `regexError`，确认无漏选和误选。
4. 满意后才发起 `create_proxy_group` / `update_proxy_group` 确认卡。

算子先重命名、策略组再筛选时，要用 `preview_node_operators` 和
`preview_proxy_group_members` 分别验证两个阶段。任何节点改名/过滤都可能使按名字绑定的
链式后端、组成员或规则 policy 悬空；改写前必须先报告影响。
