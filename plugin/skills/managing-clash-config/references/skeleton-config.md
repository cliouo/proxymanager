# 骨架区块 config-section

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才被读取。

骨架区块 = `base.yaml` 里**非规则、非规则集、非策略组、非节点**的部分：`dns` / `sniffer` / `tun` / 端口等顶层标量与 map。用 `set_config_section` / `delete_config_section` 做路径化写入（读取走 `get_config_section`），写前先 `get_config_section` 看现状。

## 目录 (TOC)
- [两个写工具的入参](#两个写工具的入参)
- [路径语法](#路径语法)
- [value 用 YAML 表达](#value-用-yaml-表达)
- [禁改清单（所有权表）](#禁改清单所有权表)
- [写入语义与护栏](#写入语义与护栏)
- [改 dns 的完整示例](#改-dns-的完整示例)

## 两个写工具的入参

| 工具 | 入参 | 约束 | 作用 |
|---|---|---|---|
| `set_config_section` | `path` (string), `value` (string) | path 1–200 字符；value 1–20000 字符、必须是合法 YAML | 新增或替换 path 处的内容 |
| `delete_config_section` | `path` (string) | path 1–200 字符 | 删除 path 处的内容 |

两者都是写操作，**不会立即生效**：系统先做 dry-run（套到临时文档上校验），通过后向用户出示确认卡，用户亲自授权才执行（走 `config-section` 场景，带审计 + 可撤销）。发起后不要声称已改好，只说明这条改动做什么、提示用户在卡片里确认。

## 路径语法

与 `get_config_section` 完全一致：

- **点分键**：`a.b.c` 逐层进 map。例：`dns.enhanced-mode`、`dns.fallback`。
- **具名序列**：`key[名字]` 选中序列里 `name:` 等于该名字的那一项。例：`proxy-groups[OpenAI]`、`rule-providers[openai_classic].behavior`。
- 形态：每段是 `键` 或 `键[选择器]`；点号分隔。

```
dns.enhanced-mode          # map 取标量字段
sniffer.sniff.HTTP.ports   # 多层 map 嵌套
tun                        # 整个顶层 map
```

> 注：`proxy-groups[...]`、`rule-providers[...]` 等具名序列写法**语法合法**，但这些根属禁改区（见下表），会被系统拒。具名序列写法主要用于**读取**。

## value 用 YAML 表达

`value` 是新值的 YAML 字面，会被 `yaml.parse` 解析成 JS 值后写入：

| 写什么 | path 示例 | value 示例 |
|---|---|---|
| 标量 | `dns.enhanced-mode` | `fake-ip` |
| 布尔 | `dns.enable` | `true` |
| 整组 map | `dns` | 一段完整的 YAML map（见末尾示例） |
| 列表 | `dns.fallback` | YAML 块序列或 `[a, b]` |

务必让 value 是**完整、正确**的 YAML：替换整组时，整组会被新值原样取代（不是浅合并），漏字段就会丢字段。所以替换整组前一定先 `get_config_section` 拿到当前全貌再改。

## 禁改清单（所有权表）

以下顶层根经 config-section 修改会被**直接拒绝**（`assertEditablePath` 的 Never-List）。每类有专属 action：

| 禁改根 | 原因 | 正确入口 |
|---|---|---|
| `proxies` | 节点由订阅源自动注入，base 不托管 | 「订阅源」页加删源 / 算子 |
| `proxy-providers` | 本项目不再管理，用户手写条目原样透传，AI 不要碰 | —（不归助手管） |
| `proxy-groups` | 存在 Redis hash，base 只剩 `# === PROXY-GROUPS ===` 标记 | `create_proxy_group` / `update_proxy_group` / `delete_proxy_group` |
| `rules` | 规则由平台托管，base 的 `rules:` 只剩锚点标记 | `add_rule` / `update_rule` / `delete_rule` |
| `rule-providers` | 规则集由平台托管，按需注入 | `create_rule_provider` / `update_rule_provider` / `delete_rule_provider` |

另外：**任意路径段命中敏感字段名**（`password` / `passwd` / `secret` / `token` / `uuid` / `psk` / `private-key` / `credential` / `auth`，大小写不敏感）也会被拒，不允许经 config-section 改凭证。

## 写入语义与护栏

`set_config_section`（基于 `yaml` Document，保留未触碰节点的注释/锚点/顺序）：

- **leaf 存在** → 替换该值，diff 记为 `update`。
- **leaf 不存在但父节点存在** → 创建该末段键，diff 记为 `add`。
- **末段是具名选择器 `[名字]` 且序列里没有该名字** → 追加一个新的具名序列项（append）。
- **中间段（非末段）不存在** → 报错 `路径 "X" 不存在` / `X[sel] 不存在`。即 config-section **不会**自动补建多层缺失的中间 map，只能创建最后一层 leaf；要建深层新分支，得逐层先把父级建出来，或一次写出含完整父级的整组。

`delete_config_section`：

- 目标路径必须存在，否则报 `要删除的路径不存在`。

**引用护栏（set 与 delete 都跑）**：改动后若有规则因此失去引用（policy / 锚点悬空），dry-run 阶段就拒绝，返回 `改动会让 N 条规则失去引用：…`，连确认卡都不会生成。托管策略组计入合法 policy 全集（渲染时注入，不在 base 字面里），不会被误判为悬空。

**读取脱敏**：`get_config_section` 返回的是 merge 解析后的「生效配置」，节点密码 / 订阅 URL 等凭证已脱敏为 `***`，不要尝试获取或猜测。

## 改 dns 的完整示例

**第一步：先看现状。**

```
get_config_section(path="dns")
```

**第二步（改单个字段）：把 enhanced-mode 切到 fake-ip。**

```
set_config_section(
  path="dns.enhanced-mode",
  value="fake-ip"
)
```

`dns` 已存在、`enhanced-mode` 是其下 leaf → diff 记为 `update`（若该字段原本没有则记 `add`）。

**第二步（替换整组 dns）：写一段完整 YAML map。**

```
set_config_section(
  path="dns",
  value="""
enable: true
ipv6: false
enhanced-mode: fake-ip
fake-ip-range: 198.18.0.1/16
nameserver:
  - https://dns.google/dns-query
  - https://1.1.1.1/dns-query
fallback:
  - tls://8.8.4.4:853
"""
)
```

要点：整组替换是**整体覆盖**，上面 value 会成为新的 `dns` 全貌，原有未列出的字段会丢失——所以务必先 `get_config_section(path="dns")` 拿到当前全部字段再增改。dns 各字段名以 `search_mihomo_docs` 查证为准，不要凭记忆臆造字段。

**删除某个 dns 子字段：**

```
delete_config_section(path="dns.fallback")
```

发起以上任一写操作后，等用户在确认卡里授权才会真正落地。
