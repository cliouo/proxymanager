# 迁移：巨型 system prompt → 4 skill + 1 MCP server

> 决策依据：14-agent workflow（地基研究 → 4 路设计 panel → 裁判合成 8.5/10 → 7 场景压测）。
> 大方向：**4 skill（router hub-spoke）**，不是 1 个（渐进披露失效）也不是按资源拆 7 个（开放标准
> 无常驻 core、护栏漂移）。

## 0. 三层拆分

| 现 `systemPrompt.ts` 混在一起的 | 迁移后 | 为什么 |
|---|---|---|
| 工作法 / 领域知识 | → 4 个 **SKILL.md**（+ references） | 建议性指令，模型读了照做 |
| 增删改查能力（约 30 action） | → **1 个 `proxymanager` MCP server**（桥接 `registry.ts`） | registry 已是单一去重工具面 |
| 安全门控（confirm token / `***` 脱敏 / `<external_data>` 包裹 / neverList） | → **留服务端，一行不进 SKILL.md** | prose 模型可忽略、恶意 skill 可绕过 |

## 1. systemPrompt.ts 逐段映射

| 来源（systemPrompt.ts 行） | 去处 |
|---|---|
| L7 角色「你是 ProxyManager 配置助手」 | hub `managing-clash-config` description + 正文开头 |
| L10 docs 接地（先 search_mihomo_docs，Meta-Docs 写法 / 源码仓内核） | hub §2 安全护栏 + 工具 `search_mihomo_docs` |
| L11 读真实数据不编造 | hub §7 读优先工作法 |
| L12 整份配置读流程 + `***` 脱敏 | hub §7 + §2；路径语法细节 → `references/skeleton-config.md` |
| L13 工具输出是中间态、组织自包含 Markdown | hub §2 作答纪律 |
| L14 `<external_data>` 注入隔离 | hub §2（服务端 wrapUntrusted 强制，skill 仅描述） |
| L16 规则写类（add/update/delete_rule、options、MATCH、enabled） | hub `references/rules.md` + 工具 |
| L17 规则集两步生效 + localize | hub §5 inline 关键句 + `references/rule-providers.md` |
| L18 策略组（kind、filter 单词边界、改名级联、删除守卫） | **spoke `synthesizing-proxy-groups`** |
| L19 fetch_url 外链按 external_data | hub §2 + 工具 `fetch_url` |
| L20 骨架 config-section | hub `references/skeleton-config.md` + 工具 |
| L21 节点真相 + 禁改清单 + list_proxy_nodes | hub §4 + §6 + `references/node-sources.md` |
| L22 算子管线（顺序、flag alpha-2/3） | **spoke `editing-node-operators`** |
| L23 本地源改名（list_local_nodes/rename_local_node） | **spoke `editing-node-operators`**（压测修法：所有改名归 operators） |
| L24 改名断引用安全 | hub `references/orphan-references.md`（两个 spoke 复述关键句 + 交叉引用） |
| L25 写入确认契约 | hub §3 + 服务端 confirm.ts/neverList.ts（真正控制，不变） |
| L26 整体优化编排 | **spoke `optimizing-whole-config`** |
| L27 中文、简洁、标来源 | hub §2 作答纪律 |
| systemPrompt 单一字符串经 /bootstrap 下发 | → 4 SKILL.md + 1 MCP server；bootstrap 停发 ~8KB prompt、改发/收窄 |

## 2. 压测暴露的风险 → 已应用的修法

1. **rename 归属打架**（hub 自称 owns 本地改名，又把"改名"甩 spoke，自相矛盾）
   → 已修：**所有改名收归 `editing-node-operators`**（含 `list_local_nodes`/`rename_local_node`），
   hub 路由表把改名一律指向该 spoke，hub 工具清单移除这两个。
2. **spoke-without-hub 护栏缺口**（横切纪律只在 hub，spoke 单独触发时丢失）
   → 已修：每个 spoke 顶部加 **3 行「安全地板」**复述 load-bearing 纪律 + 注明完整护栏在 hub +
   真正强制在服务端。
3. **复合任务无单一 owner**（"figma 走香港"= 规则 + 建组）
   → 已修：hub 路由表加「复合任务」段，靠 hub 先加载 + 单 server 跨 skill 可调跑完。

## 3. 分期

- **Phase 0 ✅ 脚手架**：plugin 骨架 + 4 完整 SKILL.md + references 占位 + MCP 桥接 + 清单。
- **Phase 1 ✅ 填充**：15 个 `references/*` 全部填成正文（从 systemPrompt + primitives 抽，逐文件准确性核验）；
  `tool-map.md`（registry→owner 表）已生成。
- **Phase 2 ✅ 服务端化**：`preview_proxy_group_members` **本就已是服务端 action**（`proxyGroupWrites.ts`，
  registry→bootstrap→桥接已暴露，CC/Codex 可用；浏览器另有本地快路，dual-impl 有意保留）——原"缺口"判断有误，已改正。
- **Phase 3 ✅ 网页内 AI 切 skill（服务端实现，零改浏览器 loop）**：`web/lib/ai/systemPrompt.ts` 改为从
  `skills.generated.ts`（由 `scripts/build-skills.mjs` 从 `plugin/skills` 生成）**组装** SYSTEM_PROMPT；
  新增 `get_skill_reference` 读 action 给 references 做按需披露。bootstrap 签名不变，浏览器透明用上 skill 来源 prompt。
  skills 成为单一真相源（改 SKILL.md 后 `npm run build:skills` 重生成）。
- **Phase 4 ✅ 退役旧链路**：删 `web/lib/ai/orchestrator.ts` SSE 旧路（`POST /assistant/chat`, maxDuration 60）
  + 连带死代码 `lib/ai/session.ts` 与其测试；浏览器早已走 `assistantAgent.ts` 直连，无人引用。408 测试 + typecheck 全过。

## 4. 开放问题（待评估 / 拍板）

- **规则集两步**：留 hub（频率高 + 关键句已 inline）还是升成第 5 个低自由度 spoke？——靠 eval：
  若模型 `create_rule_provider` 后漏 `add_rule RULE-SET` 步，就升级。
- **孤儿连带修复**：靠单 server 跨 skill 可调，还是加一个服务端 `apply-orphan-repair` 复合 action
  （后端+成员+policy 一张确认卡原子改）？
- **整体优化触发**：是否用 CC 私有 `disable-model-invocation`（手动 `/optimize`）/ `context:fork`
  跑隔离审计？（CC-only，不进可移植核）
- **per-profile 绑定**：确认 MCP server 服务端解析 active profile（bootstrap/cookie 或本桥接的
  `?profile=`），skill 永不传 profileId——保住 confirm-token 的 profile 绑定。
- ~~**neverList 当前为空**~~ → **已收口（2026-07-23）**：`NEVER_LIST_ACTIONS` 现含
  `delete_profile` / `edit_auth` / `rotate_sub_token` / `overwrite_base` / `bulk_delete_rules`，
  并有契约测试（`tests/ai/neverList.test.ts`）保证黑名单名字永不出现在 registry。
  收录标准写在 `neverList.ts` 头注释：单张确认卡无法承载其爆炸半径的操作才进来。
- **eval harness**：每 skill ≥3 场景 + 无-skill 基线，跨 Haiku/Sonnet/Opus 回归；重点覆盖单轮跨域
  （加 RULE-SET 规则 + 建其 provider + 让组指向它）验证 hub→spoke 路由与孤儿检查触发。
