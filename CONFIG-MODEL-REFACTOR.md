# 配置模型重构：单一真源视图 + 全规则托管

> 创建：2026-05-26 · 状态：**全部 5 阶段已实现并验证（2026-05-26）**。迁移已 commit（详见文末实施记录）。
> 目标：消除"基础配置看着像全文其实不全""一部分规则项目管不了"的设计缺陷。
> 决策已锁定（用户确认）：
> 1. **「最终配置」= 完整渲染配置的只读实时视图**，作为核心页（取代导航里的"基础配置"）。
> 2. **项目托管全部规则**（不再有"静态规则=碰不得的文本"）；`GEOIP,lan,直连`、`DST-PORT,9993`、整串 `RULE-SET`、`MATCH` 等手写规则全部纳入规则系统。
> 3. **骨架编辑器零 rules**：`rules:` 块只剩锚点标记，整段由渲染器生成；骨架编辑器只编辑"别处表单可视化不了的部分"。
> 4. 不需要在最终配置全文里直接打字改规则（只读视图足够）。

---

## 1. 现状 vs 目标

**现状（拆得不彻底）**
- `base:content`：骨架 + `rules:` 块（含手写静态规则 + 锚点标记 + 大量注释掉的旧规则）。
- `rules` hash：仅 manual 锚点的托管规则（当前 62 条，全 import）。
- `renderBase(base, rules)`：把 hash 规则按 rank 注入 `# === ANCHOR: name ===` 标记处；静态规则保留为文本。
- 痛点：基础配置编辑器混着"会渲染的静态规则 + 注入占位 + 注释"，分不清原文；且静态规则项目无法结构化管理。

**目标（单一真源 + 全托管）**
- `base:content`：**纯骨架**——dns / proxy-groups / sniffer / tun / proxies / proxy-providers / rule-providers / rule-anchor / 顶层标量；`rules:` 块**只含锚点标记**（无任何规则行）。
- `rules` hash：**全部规则**（prelude + manual + late + MATCH，含 no-resolve 等修饰符、含停用规则）。
- `renderBase`：`rules:` 整段由锚点+hash 生成。
- 「最终配置」只读视图 = `renderBase` 输出（所见即下发）。

## 2. 已核实事实（实现依据，非占位）
- `RuleTypeSchema`（`web/schemas/common.ts`）已含 `GEOIP/GEOSITE/DST-PORT/SRC-PORT/IP-CIDR/IP-CIDR6/IP-ASN/SRC-IP-CIDR/PROCESS-NAME/PROCESS-PATH/NETWORK/RULE-SET/MATCH/DOMAIN*`。**无需扩类型。**
- `renderRule`（`web/lib/engine/renderer.ts:18`）已特判 `MATCH`→`MATCH,policy`，其余 `type,value,policy`。**缺修饰符拼接。**
- `renderBase` 已按锚点注入、组内按 `rank` 升序。
- 内建策略（DIRECT/REJECT/REJECT-DROP/PASS/COMPATIBLE）已在 `parseBase().policies` 中，规则 policy 用它们可通过 `ensureValidAnchorAndPolicy`。
- 规则编辑 UI 住在 `/rules`（IA v3 起为真身；`/scenarios/rule-anchor-append` 是跳转壳，方向与早期相反）。
- 导航 `PRIMARY_NAV`（`web/components/Sidebar.tsx:9`）：总览 / 基础配置(/base) / 规则集(/rule-sets) / 订阅源 / 操作历史。

## 3. Schema 变更（唯一的数据契约改动）
`web/schemas/rule.ts` 的 `RuleSchema` 增两字段、放宽 value：
```ts
value: z.string().default(''),          // MATCH 无 value；其余必填(由 superRefine 保证)
options: z.array(z.string()).optional(),// 修饰符，如 ['no-resolve']；renderRule 追加在末尾
enabled: z.boolean().default(true),     // false = 暂存/停用，不参与渲染（承接注释掉的旧规则）
```
- `superRefine`：`type!=='MATCH'` 时要求 `value` 非空；`MATCH` 时忽略 value。
- `RuleCreate/Replace/Patch` 同步带上 `options`/`enabled`。
- `renderRule` 改为：`MATCH`→`MATCH,policy`；否则 `[type,value,policy,...(options??[])].join(',')`。
- `renderBase`/`groupRulesByAnchor`：**跳过 `enabled===false`** 的规则。
- 向后兼容：旧规则无 options/enabled，default 生效（enabled=true、options 无）。

## 4. 锚点迁移映射（渲染逐字节同序，已验证逻辑）
当前 `rules:` 块实际顺序（来自真实 dump）：
```
GEOIP,lan,直连,no-resolve / DST-PORT,9993,直连 / RULE-SET,zerotier_classic,直连   ← 在 prelude 标记之前
# === ANCHOR: prelude ===   (空)
# === ANCHOR: manual ===    ← 62 条 hash 规则
IP-CIDR,70.36.96.102/32,DIRECT,no-resolve / IP-CIDR,45.62.108.198/32,DIRECT,no-resolve
RULE-SET,ehentai_domain,ehentai … （整串 domain RULE-SET）… RULE-SET,geolocation-!cn,其他
RULE-SET,telegram_ip,Telegram / RULE-SET,cn_ip,国内
# === ANCHOR: late ===      (空)
MATCH,其他                  ← 在 late 标记之后
```
迁移后（每条规则归一个锚点，base `rules:` 只剩三个标记）：
| 锚点 | 装入的规则（按 rank 升序） |
|---|---|
| **prelude** | GEOIP,lan,直连,no-resolve → DST-PORT,9993,直连 → RULE-SET,zerotier_classic,直连 |
| **manual** | 现有 62 条（不动） |
| **late** | IP-CIDR×2(no-resolve) → 整串 domain RULE-SET → telegram_ip → cn_ip → **MATCH,其他（rank 最大，永远最后）** |

> 渲染顺序证明：原顺序 = head → (prelude空) → manual → tail → (late空) → MATCH；
> 新顺序 = prelude(head) → manual → late(tail+MATCH)。两者**实际规则行顺序完全一致**（空标记不产出）。
> base `rules:` 迁移后只剩：
> ```yaml
> rules:
>   # === ANCHOR: prelude ===
>   # === ANCHOR: manual ===
>   # === ANCHOR: late ===
> ```

注释掉的旧规则（`# - DOMAIN,…`）：迁移为 `enabled:false` 的暂存规则（按所在区域归锚点），**零丢失**，可在规则页启用/删除。

## 5. 页面 / 导航
- **新增「最终配置」页** `app/(authed)/config/page.tsx`：调用 `GET /api/v1/preview/{profile}`（已存在，跑 `renderBase`）展示完整 YAML，只读（shiki/暗色块），带"复制/下载"+ 订阅 URL 提示；focus/保存后自动刷新（实时反映）。
- **「基础配置」→「结构」**：`/base` 页保留 YAML 编辑器，但：
  - 导航 label 改「结构」（或「骨架/模板」），定位为"编辑表单不覆盖的部分"。
  - **保存校验**：`rules:` 块只允许出现注释/锚点标记，**出现任何规则行则拒绝保存**并提示"规则请到规则页管理"——强制零 rules。
- **规则页** `/scenarios/rule-anchor-append`：从"只显示 manual"扩为**按锚点分组显示全部规则**（prelude/manual/late…），支持 options(no-resolve)、MATCH(无 value)、enabled 开关（停用/启用）、按 anchor 调序。
- **导航最终态**：总览 / **最终配置** / **结构** / **规则**(/scenarios/rule-anchor-append) / 规则集 / 订阅源 / 操作历史。
- 规则集(rule-providers 声明)保持独立页；规则页中的 `RULE-SET,<provider>,<policy>` 规则会与之呼应（"一起管理"由此达成；完全合并 UI 列为可选后续）。

## 6. 迁移脚本（一次性，`web/scripts/migrate-rules-into-hash.ts`）
1. **先备份**：把当前 `base:content` 存到 `base:content:backup:<ts>`（Redis）并打印，防丢。
2. 读 `base:content`，解析 `rules:` 块逐行（保序）。
3. 每条规则行（含注释行→enabled:false）解析为 `{type,value,policy,options}`：
   - `MATCH,policy` → type=MATCH,policy,value=''；
   - 其余 `TYPE,VALUE,POLICY[,mod...]` → split(',')，options=第 4 段起。
   - 按所在区域定 anchor（prelude 前→prelude；manual 区已是 hash，跳过；manual 与 late 间→late；late 后→late 末尾），rank 步长 10 递增，MATCH 取最大 rank。
4. `校验`：每条 `ensureValidAnchorAndPolicy`（anchor/policy 必须存在）。
5. 写入 hash（新静态规则 source 用 `'import'`；可加来源备注）。
6. **重写 `base:content`**：`rules:` 块替换为仅三个锚点标记，其余骨架原样保留（用 yaml Document 或字符串替换，保注释）。
7. **渲染等价验证**：迁移后 `renderBase(newBase, allRules)` 的"非注释规则行序列" 必须 == 迁移前 `renderBase(oldBase, oldRules)` 的规则行序列（逐行 assert）。不一致则报错回滚（不写）。

## 7. AI 工具对齐（Tier C/D）
- `add_rule`/`update_rule` 输入加 `options?`、`enabled?`；`add_rule` 现在可面向任意锚点（prelude/manual/late），描述更新。
- `delete_config_section`/`set_config_section`：**禁止编辑 `rules` 路径**（rules 由规则 action 管理）——在 `assertEditablePath` 加 `rules` 到禁区。
- system prompt：说明规则统一走 add/update/delete_rule，骨架区块走 config-section，`rules:` 块不可经 config-section 改。

## 8. 分阶段实施
- **阶段 1**：最终配置只读视图 + 导航主位（独立、零风险、先交付核心）。
- **阶段 2**：schema(options/enabled/MATCH value) + renderRule/renderBase + 单测。
- **阶段 3**：迁移脚本 + 备份 + 渲染等价验证（先 dry-run 打印 diff，确认后再写）。
- **阶段 4**：规则页全锚点 UI（options/enabled/MATCH/调序）；「结构」改名 + rules-only-anchors 保存校验；导航最终态。
- **阶段 5**：AI 工具对齐 + 文档更新。

## 10. 实施记录（2026-05-26 完成）

- **阶段 1** ✅ 最终配置只读视图 `app/(authed)/config/page.tsx`（`GET /api/v1/preview/default`，readOnly 编辑器 + 锚点注入/未匹配/订阅地址检查栏，focus 自动刷新）；导航主位。
- **阶段 2** ✅ `RuleSchema` 加 `options?`/`enabled?`、`value` 默认 ''；`RuleCreate/Replace` superRefine（非 MATCH 必填 value）；`renderRule` 拼 options、`renderBase` 跳过 `enabled===false`；scenario create/replace/batchCreate 透传新字段。单测：renderer + schema + openapi 生成守护。
- **阶段 3** ✅ `scripts/migrate-rules-into-hash.ts`（默认 dry-run，`--commit` 原子写）。**已 commit**：62→106 条规则（44 迁移：20 生效 + 24 停用），base `rules:` 块仅剩三锚点标记，渲染等价 82→82 逐行一致。分区注释写入规则 note。备份键 `base:content:backup:1779789143156` 等（见项目记忆）。
- **阶段 4** ✅ 规则页全锚点分组 UI（启停/options/MATCH/行内编辑/↑↓ 调序/整理排序/显示停用）；`baseService.rulesBlockViolations` 服务端拦截 base `rules:` 块里的规则行（PUT+validate 两路径）；导航最终态 总览/最终配置/结构/规则/规则集/订阅源/操作历史，「基础配置」改名「结构」。
- **阶段 5** ✅ AI 对齐：`add_rule`/`update_rule` 支持 `options`/`enabled` 与任意锚点、MATCH 无 value；`list_rules` 返回 options/enabled；`assertEditablePath` 把 `rules` 列入禁改根（config-section 不能改规则）；system prompt 区分规则 action vs 骨架 config-section；助手 rule-list 卡片显示修饰符/停用态。

测试：158 passed。typecheck / lint 干净。

## 9. 风险 / 显式取舍
- **数据安全**：迁移前 Redis 备份 base；渲染等价验证不过不写。用户另有原配置备份。
- **重复规则**：当前 hash 有重复（`www.023168.xyz`×2 等）；迁移**保持现状不自动去重**（先保证等价），去重作为阶段 4 的可选清理（规则页"查重并删"）。
- **value='' 兼容**：仅 MATCH 用；其余 superRefine 强制非空，避免脏数据。
- **回滚**：阶段 1 纯新增可删；阶段 2 schema 向后兼容（default）；阶段 3 有备份 key 可还原 base。
