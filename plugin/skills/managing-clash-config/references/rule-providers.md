# 规则集 / rule-providers 两步生效

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才被读取。
> 事实来源：`web/lib/ai/actions/primitives/ruleProviderWrites.ts` 与 system prompt 规则集条款。只写源码证实的字段与行为。

## 目录 (TOC)
- [核心模型：两步才生效](#核心模型两步才生效)
- [list_rule_providers（读）](#list_rule_providers读)
- [create_rule_provider（写）](#create_rule_provider写)
- [字段速查表](#字段速查表)
- [创建示例：remote 与 local](#创建示例remote-与-local)
- [update_rule_provider（写）](#update_rule_provider写)
- [delete_rule_provider（写）与删除守卫](#delete_rule_provider写与删除守卫)
- [localize_rule_provider：remote→local（写）](#localize_rule_providerremotelocal写)
- [写操作通则](#写操作通则)

## 核心模型：两步才生效

规则集库（rule-providers / 「规则集」）由平台托管。base.yaml **不含** `rule-providers:` 块；渲染下发配置时，**只把被 RULE-SET 规则引用的规则集注入** `rule-providers:`。

因此让一个规则集真正生效需要两步：

| 步 | 动作 | 作用 |
|---|---|---|
| 1 | `create_rule_provider` | 仅入库（加入规则集库），**此时还不会注入下发配置** |
| 2 | `add_rule`（type=`RULE-SET`，value=规则集的 `name`） | 加一条引用，渲染时该集才被注入并生效 |

- 引用是**按 `name`（slug）匹配**的，不是按 id。
- 没有任何 RULE-SET 规则引用的规则集 = 留在库里但不下发。
- 别用 `fetch_url` 把外部规则内容经你中转写进来；外部 URL 让 mihomo 直接抓（remote），或用 `localize_rule_provider` 让平台抓取托管。
- 禁止用 `set_config_section` 去碰 `rule-providers` 路径，会被系统拒绝；只能走本组 action。

## list_rule_providers（读）

入参：无（`z.object({})`）。回答「有哪些规则集」「某规则集被谁引用」「改/删前拿 id」时调用。

每个条目返回字段：

| 字段 | 含义 |
|---|---|
| `id` | 规则集 id（update/delete/localize 都要它） |
| `name` | 被 RULE-SET 规则引用的名字（slug） |
| `source` | `local`（平台托管内容）或 `remote`（外部 URL），缺省视为 `local` |
| `format` | `yaml` / `text` / `mrs` |
| `behavior` | `classical` / `domain` / `ipcidr`，或 `null` |
| `url` | 仅当 `source=remote` 时有值，否则 `null` |
| `interval` | 刷新间隔（秒），或 `null` |
| `referenced` | 当前 profile 下有多少条 RULE-SET 规则引用此 `name`（计数） |
| `note` | 备注，或 `null` |

`referenced` 是判断「这个集在**当前 profile** 生没生效」的依据。注意：删除守卫扫的是**所有 profile** 的 RULE-SET 规则，所以 `referenced=0`（仅当前 profile 的计数）未必删得掉——别的 profile 还引用着同样会被拒。

## create_rule_provider（写）

在规则集库新增一条（local 托管内容 或 remote 外部 URL）。**需用户确认。** 新建只入库，要生效还需第 2 步 `add_rule` 加 RULE-SET 引用其 `name`。

入参 schema（`CreateInput`）：

| 字段 | 类型 / 约束 | 必填 | 说明 |
|---|---|---|---|
| `name` | string，正则 `^[a-z0-9_-]+$`，max 64 | 是 | 规则集名（slug），RULE-SET 规则用它引用 |
| `source` | `local` \| `remote`，默认 `local` | 否 | local=平台托管内容；remote=外部 URL |
| `format` | `yaml` \| `text` \| `mrs` | 是 | local 仅 `yaml`/`text`；remote 可用 `mrs` |
| `behavior` | `classical` \| `domain` \| `ipcidr` | 否 | mihomo rule-provider behavior |
| `content` | string，max 200000 | local 必填 | 规则集内容（如 `payload: ...`） |
| `url` | string，max 2000 | remote 必填 | mihomo 直接抓取的外部 URL |
| `interval` | 正整数 | 否 | 刷新间隔（秒），缺省 86400 |
| `proxy` | string，max 64 | 否 | 下载用的代理/策略名 |
| `note` | string，max 256 | 否 | 备注 |

交叉校验（`superRefine`，违反即拒绝）：

- `source=remote` 必须提供 `url`。
- `source=local` 必须提供非空 `content`。
- `source=local` 不支持 `format=mrs`（mrs 是二进制，只能 remote）。

### 字段速查表

| 选 source | 允许 format | 必填内容字段 | url |
|---|---|---|---|
| `local` | yaml / text | `content` | 不用 |
| `remote` | yaml / text / mrs | 不用 | `url` 必填 |

## 创建示例：remote 与 local

remote（外部 URL，mihomo 直接抓，可用 mrs）：

```json
{
  "name": "ads-block",
  "source": "remote",
  "format": "mrs",
  "behavior": "domain",
  "url": "https://example.com/ads.mrs",
  "interval": 86400
}
```

local（平台托管内容，仅 yaml/text，必带 content）：

```json
{
  "name": "my-direct",
  "source": "local",
  "format": "yaml",
  "behavior": "classical",
  "content": "payload:\n  - DOMAIN-SUFFIX,example.com\n  - DOMAIN-KEYWORD,intranet"
}
```

两例创建完都还需第 2 步：`add_rule` 加 `RULE-SET,<name>,<策略>`（如 `RULE-SET,ads-block,REJECT`）才会注入生效。

## update_rule_provider（写）

修改库中某条目的字段。**需用户确认。** 先用 `list_rule_providers` 拿 `id`。

入参 schema（`UpdateInput`）：

- `id`：uuid，必填。
- 可改字段（均可选）：`source` / `format` / `behavior` / `content` / `url` / `interval` / `proxy` / `note`。
- 约束（`refine`）：除 `id` 外**至少要改一个字段**，否则报「至少要修改一个字段」。

只把传入的非 `undefined` 字段并入 patch，其余保持原值。

## delete_rule_provider（写）与删除守卫

从库删除一条规则集。**需用户确认。** 入参仅 `id`（uuid，先用 `list_rule_providers` 获取）。

删除守卫：**若该规则集仍被任何 RULE-SET 规则引用，删除会被拒绝。** 先处理引用它的规则——用 `update_rule` 改掉那条规则的 value/类型，或 `delete_rule` 删掉它——把 `referenced` 降到 0，再删规则集。

## localize_rule_provider：remote→local（写）

把一个 `remote`（外部 URL）规则集转为本平台托管：确认后由**平台抓取其 URL 的当前内容**存为本地内容（`source` 改 `local`、`content` 填抓取结果、`url` 清空），之后由平台分发、可在平台内维护。**需用户确认。** 入参仅 `id`（uuid）。

适用条件（任一不满足即拒绝）：

| 条件 | 不满足时的拒绝原因 |
|---|---|
| `source` 必须是 `remote` | 「该规则集已是本地托管，无需转换。」 |
| 必须有 `url` | 「该规则集缺少 url，无法抓取。」 |
| `format` 不能是 `mrs` | 「mrs 为二进制格式，无法转为本地文本托管。」 |

抓取上限 2,000,000 字节（`safeFetchText` maxBytes）。即：**仅 `yaml` / `text` 可本地化，`mrs` 不行。** 不要改用 `fetch_url` 经你中转内容。

## 写操作通则

- 本组写 action（create / update / delete / localize）全部经 `rule-provider` 场景 dispatch，**审计 + 撤销自带**，绝不内联执行。
- 走确认握手：系统向用户出示确认卡，用户亲自授权后才执行。**发起后别声称已改好**，只简述这条改动会做什么、提示用户在卡片确认。
- 写前可用 `list_rule_providers` 拿 id、看 `referenced`；改/删涉及引用关系时配合 `list_rules` 定位 RULE-SET 规则。
