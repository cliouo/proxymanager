# 整体布局与设备层设计 v1

> 状态：IA、模版类型（T）与 P1 已落地；P2 设备级 Tailscale 已按本文修订合同实现。
> 四条线保持独立可发布。事实依据全部来自当前代码。
>
> **IA v4 修订（2026-07-24）**：设备提升为一级导航 `/devices`（设备工作台，吸收
> §9.4 的 /scenarios/tailscale 总览页，后者退为跳转壳）；Tailscale 只作为设备卡片与
> 设备详情中的能力出现，不再占侧栏入口；链式代理放进扁平的「高级配置」组。§1.2
> 目标侧边栏、§1.3 与 §7.1 设备入口按此更新：DevicePanel 由 /devices 页取代，
> 设置页仅保留一行设备摘要与按设备订阅链接。数据模型与 API（§2-§6、§9）不受影响。

---

## 0. 目标 · 术语 · 范围

**要解决的三个问题：**

1. 侧边栏核心编辑流与高级扩展混排，Tailscale 因双真相源重复出现两次。
2. 同一配置文件要服务多台设备，设备间存在小差异（端口/secret/external-ui/进程匹配/
   Tailscale hostname+key），目前只能靠克隆 profile，共享编辑会发散。
3. 模版（simple/general 系列）与普通配置文件同型，缺少类型区分。

**术语：**

| 词                | 含义                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| 共享层            | profile 拥有的 base / 策略组 / 规则 / 链式代理等，改一次全设备生效     |
| 设备 (Device)     | 挂在 profile 下的差量实体，UI 用词统一「设备」，不用「变体」           |
| 补丁 (base_patch) | RFC 7386 语义的顶层键差量，作用于**最终渲染产物**                      |
| 设备级功能        | scope 声明为 device 的场景（P2），整个功能按设备启用，Tailscale 属此类 |

**非目标（明确不做）：**

- 条目级设备差异（「这条规则仅桌面」）→ P3 预留，本文不设计细节。
- 按 profile「启用后才显示」的动态扩展侧边栏 → 扩展 ≥6 个再议。
- 把规则/策略组抽回共享库+引用 → 推翻 per-profile ownership，拒绝。
- 设备补丁修改策略组成员/节点过滤 → 那实质是另一个 profile，用克隆。

---

## 1. 信息架构（Phase 0，独立发布）

### 1.1 病根

- `components/nav.ts:24` 把 Tailscale 硬编码进 PROFILE_NAV；
- `components/Sidebar.tsx:17` 的 `PROMOTED_SCENARIOS` 未含 tailscale，「更多场景」
  动态组把它又渲染一遍；
- 场景中文名 override 表在 `Sidebar.tsx:25` 与 `scenarios/page.tsx:15` 各一份。

三处真相源 → 收敛为 `nav.ts` 一处。

### 1.2 目标侧边栏

```
[配置文件切换器]
◎ 概览
── 当前配置文件 ──          ← 核心编辑流水线，顺序即数据流
{} 结构 base
⌥ 策略组
#  规则
▣ 最终配置
▤ 设备                      ← 共享基准、设备差异与设备功能（见 §7）
⚙ 配置文件设置
── 高级配置 ──
⛓ 链式代理
── 资源库 · 共享 ──
⇣ 订阅源    ≣ 规则集
── 系统 ──
↺ 操作历史  ✦ AI 配置  ❡ API 文档  ⏻ 退出
```

### 1.3 改动清单

| 文件                              | 改动                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `components/nav.ts`               | `PROFILE_NAV` 保留设备，`ADVANCED_NAV` 只放链式代理；Tailscale 不再建立第二个管理入口                                         |
| `components/Sidebar.tsx`          | 删除场景动态拼装和单项折叠层；渲染扁平的「高级配置」组                                                                        |
| `lib/scenarios/*/scenario.ts`     | descriptor 的 title/description 中文化（chained-proxy「链式代理」、rule-anchor-append「规则编辑」、dev-echo「Echo（调试）」） |
| `app/(authed)/scenarios/page.tsx` | 删两份 override 表；标题改「扩展中心」                                                                                        |
| `app/api/v1/scenarios/route.ts`   | 生产环境过滤 dev-echo（`NODE_ENV !== 'development'` 时剔除）                                                                  |

URL 全部不动（`/scenarios/*` 保持，legacy 桥不受影响）。
风险：测试若断言英文 descriptor title 会挂 → 跑 vitest 修正断言。

---

## 2. 设备层数据模型（Phase P1）

### 2.1 Schema（`web/schemas/device.ts`，导出进 `schemas/index.ts`）

```ts
export const DeviceSchema = z.object({
  id: z.uuid(),
  /** kebab-case，进订阅 URL。复用 profile 的 NAME_REGEX (schemas/profile.ts:31) */
  name: z.string().min(1).regex(NAME_REGEX),
  display_name: z.string().max(120).optional(),
  notes: z.string().optional(),
  /**
   * RFC 7386 JSON Merge Patch，作用于最终渲染配置的顶层。
   * 对象逐字段深合并；数组整段替换；null 删除该键。
   * 静态约束见 §3.2。
   */
  base_patch: z.record(z.string(), z.unknown()).default({}),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
```

Create/Update schema 仿 `ProfileCreateSchema`/`ProfileUpdateSchema`
（profile.ts:69-93）。`name` 在 profile 内唯一（409）。

### 2.2 存储（`web/lib/repos/devicesRepo.ts`）

- Key：`devices:${profileId}` Hash，field = device id —— 镜像 `rules:${profileId}`
  模式（`lib/redis/keys.ts:12`），注册进 `REDIS_KEYS`。
- 每次写在同一 `multi()`/Lua 里 `INCR config:version`（`keys.ts:103`），与
  rulesRepo/profilesRepo 一致 —— 这是渲染缓存自动失效的前提（§4）。
- 写提交用 `config:version` Lua CAS，模式照抄
  `profileConfigMutationRepo.ts:23-61`（preflight 拿到的版本 = 提交时版本，否则 412 重试）。
- 删除 profile 时在同一 multi 里 `DEL devices:${profileId}`（改
  `profilesRepo.deleteProfile`）。

### 2.3 上限（防 preflight 放大与滥用）

- 每 profile 设备数 ≤ **16**；
- `base_patch` 序列化 ≤ **32 KB**，嵌套深度 ≤ **8**；
- 超限 422 结构化错误。

### 2.4 copy_from 语义

`POST /api/v1/profiles` 的 `copy_from`（profile.ts:81）扩展为**连设备一起深拷贝**
（新 id，name 保留）。P2 的设备级功能实例**不拷贝**（含 hostname/auth-key 等唯一性
字段，拷贝必然冲突，要求在新 profile 上重新启用）。

---

## 3. 补丁语义与静态约束

### 3.1 合并算法（`web/lib/engine/devicePatch.ts`，纯函数）

```
applyDevicePatch(sharedDoc: Record<string, unknown>, patch): Record<string, unknown>
```

严格 RFC 7386：对象递归合并；数组/标量整体替换；`null` 删除键。作用对象是
**最终渲染 YAML parse 出的顶层对象**（锚点已解析，无 YAML 玄学）。
不做按索引列表 patch（索引漂移必炸），不做按 key 列表合并（需要逐字段 schema 知识）。

### 3.2 静态校验（apply 之前，422 短路）

1. patch 必须是对象；
2. **管控键黑名单**：`proxies`、`proxy-groups`、`rules`、`rule-providers` 出现即拒
   —— 这些区块由共享层管理，设备差异走 §9 设备级功能或 P3；
3. 尺寸/深度上限（§2.3）；
4. 值类型与 base 校验器约束一致：patch 后的顶层对象需通过 `/api/v1/base` 保存所用的
   同一套 base 结构校验（复用现有校验入口，不新写规则）。

### 3.3 动态校验（apply 之后）

patch 后的完整 YAML 走 `validateFinalRenderedConfig(content)`
（`lib/engine/resolve.ts:1321`，即 resolveConfig 内部对最终产物做的 mihomo 全量校验：
组类型/重名/DAG/规则策略目标/参数）。**正确性不靠合并引擎聪明，靠产物全量校验。**

### 3.4 敏感键与审计

`SENSITIVE_PATCH_KEYS = ['secret', 'auth-key', 'authentication', 'password',
'private-key', 'token']`（含嵌套命中）。审计事件的 before/after 快照对这些键的值
做 `***` 掩码 —— 精确沿用 tailscale 场景的先例（`scenario.ts:174-186` 的
redactNode / hasAuthKey）。**推论：触碰敏感键的补丁变更不可 undo**（与
`update-auth-key` 无 inverse 的既有决策一致，`scenario.ts:802-806`）；不含敏感键的
变更正常注册 inverse（恢复前一份 patch 快照）。

`AuditTarget`（`lib/scenarios/_shared/types.ts:35-40`）增
`{ kind: 'device'; id: string }`；操作历史页显示「设备 · {name}」。

---

## 4. 渲染管线与缓存

### 4.1 管线

```
共享渲染 renderProfileConfig(profileName)      ← 现有，缓存 render:${profile} 原样命中
   │  (renderCache.ts:258)
   ▼
parse YAML → applyDevicePatch → [P2: 注入该设备的功能产物] → validateFinalRenderedConfig
   ▼
序列化 → 设备最终 YAML
```

新入口：`renderDeviceConfig(profileName, deviceName, opts)`（renderCache.ts 内实现，
内部先调 `renderProfileConfig` 复用共享缓存与其全部选项语义：`noCache`、
`providerUrlBase`）。

### 4.2 缓存

- 设备层缓存 key：`render:${profile}:device:${deviceId}`（注册进 `keys.ts`）。
- 条目校验四元组与共享层完全一致（`renderCache.ts:288-294`）：
  `epoch === RENDER_CACHE_EPOCH && version === config:version && providerUrlBase 相同
&& 未过期`。**设备写入会 INCR config:version（§2.2），因此无需任何显式失效逻辑**，
  与现有机制同构。
- P1 不改变共享渲染的产出 → **不 bump `RENDER_CACHE_EPOCH`（当前 17，
  renderCache.ts:104）**。P2 若改共享渲染行为再按 AGENTS.md 约定 bump。

---

## 5. 校验不变量：单挂钩点

AGENTS.md 的 save-time invariant 由 `preflightProfileConfig(profileId, buildCandidate)`
（`lib/services/configPreflight.ts:133-173`）唯一实现，**所有**写路径都经它
（base route、rules batch/reorder、proxyGroupService ×7、tailscale/rule-anchor
场景、undo —— 见 configPreflight 调用清单）。设备层只在这一个函数里扩展：

```
preflightProfileConfig 现有流程（version-bracketed 快照 → 候选 → 无副作用完整渲染）
  └─ 追加：for each device of profile:
        applyDevicePatch(候选渲染产物, device.base_patch) → validateFinalRenderedConfig
        失败 → 聚合为结构化 issue，附 device name
```

**推论（这是本设计最重要的正确性保证）：**

- 改共享层（base/规则/策略组/场景/undo）会自动 preflight 全部设备——任何入口都
  不可能绕过，因为它们本来就都走这一个函数；
- 改设备走同一函数（该设备单独 preflight）+ 同一 Lua CAS 提交模式；
- 失败即阻断保存，错误信息点名设备与冲突键
  （如「设备 home-server 的补丁与新 base 冲突：secret 类型错误」）。
  用户的出路：先改/删该设备的补丁，再改共享层。不提供强制覆盖开关。
- 成本：N ≤ 16 次纯内存 patch+validate（无网络、无上游 fetch，候选渲染只做一次），
  可忽略。

---

## 6. API 面

### 6.1 设备 CRUD（REST，与 profiles 同风格；设备是实体不是场景 op）

| 方法   | 路径                                               | 说明                                                     |
| ------ | -------------------------------------------------- | -------------------------------------------------------- |
| GET    | `/api/v1/profiles/{id}/devices`                    | 列表（含 base_patch，管理界面用；admin 鉴权同 profiles） |
| POST   | `/api/v1/profiles/{id}/devices`                    | 创建（name 唯一 409；preflight 后 CAS 提交）             |
| PATCH  | `/api/v1/profiles/{id}/devices/{deviceId}`         | 改名/备注/base_patch（改 patch 必 preflight）            |
| DELETE | `/api/v1/profiles/{id}/devices/{deviceId}`         | 删除（审计；订阅链接随之 404，UI 确认时明示）            |
| GET    | `/api/v1/profiles/{id}/devices/{deviceId}/preview` | `{ shared: yaml, device: yaml, issues }`，diff 由前端算  |

### 6.2 分发

- 新路由：`/api/sub/{token}/{profile}/{device}`
  （`app/api/sub/[token]/[profile]/[device]/route.ts`）。与既有兄弟字面量段
  `collection`/`source` 无冲突（Next 字面量优先于动态段）。
- 语义与 `[profile]/route.ts` 完全对齐：`guardSubToken(request, token, profile)`
  —— **令牌资源作用域仍是 profile**（设备是 profile 的子资源，不引入第三种令牌；
  `auth.ts:29-31` 的 deriveSubToken 不动，rotate 机制自然生效）；
  支持 `?noCache=1`、`?format=base64`；`maxDuration = 60`；
  Content-Disposition 文件名 = `{display_name || proxymanager-{profile}}-{device}`。
- `/api/sub/{token}/{profile}` 保持 = 共享渲染，**现有设备链接一根不断**。

### 6.3 与 ops 的边界

P1 设备 CRUD 与 P2 设备级功能都不走 `/api/v1/ops`。设备功能使用
`/api/v1/profiles/{id}/devices/{deviceId}/features/{feature}` 专用子资源，由
`deviceService` 在版本括号内从同一份设备快照完成查找、候选构造、preflight 与
config-version CAS。这样不会把 profile-scoped dispatcher 扩成第二条设备写入路径。

---

## 7. 前端 UX

心智模型一句话：**配置文件是底，每台设备 = 底 + 几张差异贴纸。**
四条铁律：用户学的名词是「设备」；看的永远是「差异」，不提供合并后全量编辑视图；
共享层反向标注被覆盖的键；删除差异 = 回到共享值。

### 7.1 设备工作台（`devices/page.tsx`）

设备是当前配置文件的一级任务。页面先展示共享配置基准，再展示每台设备的差异与设备能力：

```
┌ 共享配置 ─────────────────────────────────────────┐
│ 基础配置、代理策略、分流规则与链式代理   [编辑] [链接] │
└───────────────────────────────────────────────────┘
                         ↓ 所有设备继承
┌ home-server ───────────┐  ┌ iphone ───────────────┐
│ 配置差异：4 项          │  │ 配置差异：1 项          │
│ Tailscale：已启用       │  │ Tailscale：未配置       │
│ [复制链接] [查看设备]   │  │ [复制链接] [查看设备]   │
└────────────────────────┘  └────────────────────────┘
```

删除不出现在总览卡片上，只保留在设备详情危险区。共享订阅链接放进共享配置区域，
设备卡片只复制自己的订阅链接。

### 7.2 设备详情页（新路由 `profiles/[id]/devices/[deviceId]/page.tsx`）

```
┌ Topbar: home-server                    [复制订阅链接] ┐
│                                                    │
│ [配置差异] [Tailscale] [生效预览]                    │
│                                                    │
│ 配置差异分栏：                                       │
│   ┌ external-controller  0.0.0.0:9090             ┐│
│   ┌ secret               ***（已设置）  [重新生成]  ┐│
│   ┌ external-ui          ui                       ┐│
│   ┌ find-process-mode    off                      ┐│
│   [＋ 添加差异 ▾]  ← 常用键选单 + 自定义键 + raw 补丁 │
│                                                    │
│   raw 补丁（逃生舱，CodeMirror YAML）                 │
│   语义说明一行：对象逐字段合并 · 数组整段替换 ·        │
│   null 删除该键 · proxies/proxy-groups/rules 不可写  │
│                                                    │
│ 生效预览分栏（只读 diff：共享渲染 vs 本设备渲染）       │
│   ← GET .../preview，CodeMirror merge 视图          │
│                                                    │
│ Tailscale 分栏：本设备功能卡片（三态）                 │
│                                                    │
│ 设备管理：删除设备（确认语句明示订阅链接将 404）         │
└────────────────────────────────────────────────────┘
```

结构化卡片与 raw 补丁是**同一份 base_patch 的两个视图**：卡片编辑编译进 patch 对象，
raw 里手写的未知键在卡片区显示为「自定义键」卡。保存前端先跑静态约束（黑名单/尺寸），
保存后端 preflight，错误结构化回显到具体键。

### 7.3 新建设备向导

名称 + 类型预设（纯前端建议贴纸，不落库为类型）：

- **服务器**：external-controller 改端口、secret（前端生成随机值）、external-ui、
  external-ui-url；
- **手机**：`find-process-mode: off`；
- **桌面** / **自定义**：空清单。

### 7.4 共享层反向标注

`/base` 编辑器页头加载 `GET /api/v1/profiles/{active}/devices`，对被任一设备补丁
覆盖的顶层键渲染徽章「N 台设备覆盖」，点开列出 设备名 → 覆盖值（敏感键掩码）。
纯客户端计算，无新后端。防 overlay 系统头号投诉「我改了怎么这台设备没生效」。

### 7.5 空状态

- profile 无设备：设备 panel 显示引导文案 +「添加设备」，其余一切照旧
  （**零设备 = 现状，行为完全不变**，这是向后兼容的锚点）。

---

## 8. 模版类型（Phase T，独立发布）

### 8.1 模型

`ProfileSchema` 增 `kind: z.enum(['normal','template']).default('normal')`
—— 存量记录 parse-forward，无需回填即兼容。

**kind 只影响三件事，其余语义与普通 profile 完全一致（含可编辑、可预览）：**

1. **分发拒绝**：`/api/sub/{token}/{profile}`（及设备子路由）对 template 返回 404
   （在 route 层查 profile.kind，先于渲染）；`DistributeDrawer` 对 template 显示
   「模版不可分发」；
2. **UI 分组与标识**：切换器（`Sidebar.tsx` ProfileSwitcher）把模版列在分隔线下的
   「模版」小节并加徽章 —— **允许激活**（激活即编辑模版内容，这正是模版的维护方式），
   激活时概览页顶栏显示「正在编辑模版」横幅；`profiles/page.tsx` 列表分「配置文件 /
   模版」两栏；
3. **新建流引导**：`NewProfileModal`（profiles/page.tsx:271-525）的 copy_from 选择器
   把模版置顶为「从模版新建」。

语义界碑（写进 UI 文案）：**模版 = 拷贝一次、此后分道扬镳；设备 = 持续跟随共享层、
只存差量。**

### 8.2 迁移

`migrate:profile-kind` → `scripts/migrate-profile-kind.ts`（命名循
`package.json:19-28` 既有模式，dry-run 默认 + `--apply`）：按名单（simple*/general*
系列）打 `kind: 'template'`，输出前后对照。

---

## 9. P2：设备级功能

### 9.1 scope 合同

`ScenarioDescriptor`（`_shared/types.ts:119-128`）增：

```ts
/** 功能作用层：profile = 共享层（默认，现状）；device = 按设备启用。 */
scope?: 'profile' | 'device';
```

- `chained-proxy`、`rule-anchor-append` 等 → `'profile'`（不写即默认，零迁移）；
- `tailscale` → `'device'`。

### 9.2 设备级功能的存储与渲染

设备实体增类型化的 `features`。当前只开放 `features.tailscale`，不接受任意
`Record<string, unknown>`，避免未知功能数据绕过专用 schema 与写入闸口。Tailscale
实例包含 hostname、authKey、controlUrl、stateDir、acceptRoutes、udp、ephemeral、
exitNode、exitNodeAllowLanAccess、nodeName、groupName 与 extraCidrs。

渲染注入点在 §4.1 管线第三步：
`共享渲染 → RFC 7386 patch → emitDeviceFeaturesYaml → 最终结构与 Mihomo 校验`。
Tailscale 纯函数向该设备的最终文档注入节点、单成员 select 组与 CIDR 规则。设备路由
是显式覆盖，固定放在最终规则链开头，避免被更早的共享 IP 规则静默截获。共享层
`/base` 不再产生新的 Tailscale 节点，避免一套 hostname 与密钥被所有设备共用。

### 9.3 约束与校验

- 同 profile 内相同 `controlUrl + hostname` 阻断为 409；跨 profile 因无法证明是否属于
  同一 tailnet，只给出明确警告，不误拦独立 Headscale 环境；
- 模版不保存 Tailscale 设备身份；从模版新建普通配置后，再在具体设备上启用；
- auth-key 只允许专用 PUT 写入，省略表示保留、null 表示清除；所有读取面只返回
  `hasAuthKey`，预览继续递归掩码，设备审计使用类型化投影移除 camelCase
  `authKey`，不能只依赖 YAML 键名脱敏；
- 设备功能与补丁共享 preflight + config-version CAS，不新增旁路；
- 旧共享 Tailscale 与设备实例不能同时渲染，必须显式迁移。

### 9.4 迁移与页面

- `migrate:tailscale-device`：把存量 base 里的 `type: tailscale` 节点 + 关联组/规则
  迁为「某设备的 tailscale 实例」。要求精确传入 `--profile` 与 `--device`，dry-run
  默认，`--apply` 后用单次 Lua CAS 同时改 base、设备、组、规则、版本与备份；任何
  多节点、复杂组、非标准规则或无法保真的字段都拒绝迁移。因为设备规则固定插在规则链
  开头，迁移器还必须证明旧规则原本就在该位置连续排列；否则会跨过其它规则并改变
  Mihomo 首条命中语义，必须先手动调整顺序。Lua 在第一笔写入前校验所有 Redis key
  类型与备份键不存在，存储形状异常时 fail closed；
- 设备总览页负责展示各设备的 Tailscale 接入状态，并跳转到设备详情页的 Tailscale
  分栏；旧 `/scenarios/tailscale` 只做 `/devices` 兼容跳转，不留死链。
- 共享渲染行为改变（base 不再含 tailscale 产物）→ 按 AGENTS.md bump
  `RENDER_CACHE_EPOCH`。

---

## 10. 边界情况清单（正确性核对表）

| #   | 情形                                               | 行为                                                                 |
| --- | -------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | patch 含 proxies/proxy-groups/rules/rule-providers | 422，指出键名与去处（设备级功能/P3）                                 |
| 2   | patch 非对象 / >32KB / 深度>8                      | 422                                                                  |
| 3   | 共享层保存使某设备渲染非法                         | 阻断保存，422 列出设备名+issue；先修/删设备补丁                      |
| 4   | 设备保存与共享层保存并发                           | config:version Lua CAS，落后方 412 重试（既有模式）                  |
| 5   | 设备重名（同 profile）                             | 409                                                                  |
| 6   | 删除设备                                           | 确认语句明示订阅链接 404；审计；不可 undo 的部分（敏感键）明示       |
| 7   | 删除 profile                                       | 同 multi 级联删 `devices:${profileId}`                               |
| 8   | copy_from 克隆                                     | 深拷贝设备补丁；P2 功能实例不拷贝（唯一性字段）                      |
| 9   | 零设备 profile                                     | 一切行为与现状比特级一致（回归锚点）                                 |
| 10  | template 被请求分发                                | 404（渲染之前拦截）                                                  |
| 11  | 敏感键出现在审计/徽章/预览                         | 值一律 `***`；触敏感键的变更无 inverse                               |
| 12  | 渲染缓存过期性                                     | 设备写 INCR config:version → 共享+设备缓存同机制失效，无显式失效代码 |
| 13  | `?noCache=1` 设备路由                              | 透传给共享渲染（强刷上游）+ 跳过设备缓存读                           |
| 14  | active profile 是 template                         | 允许（编辑模版的正规方式），概览横幅提示                             |

---

## 11. 测试计划

- **devicePatch 单元**：7386 语义全覆盖（深合并/数组替换/null 删除/嵌套 null）、
  黑名单、尺寸/深度上限、敏感键掩码；
- **preflight 集成**：共享层保存破坏设备 → 阻断且 issue 带设备名；设备保存自身
  preflight；CAS 竞争 412；
- **渲染**：设备缓存命中/失效（version bump）、`noCache` 透传、零设备回归
  （共享渲染字节不变）；
- **sub 路由**：设备链接 200 / 未知设备 404 / template 404 / base64 格式 / 令牌
  （master、profile 派生、rotate）；
- **copy_from**：设备补丁随拷、名称保留；
- **T**：kind parse-forward、切换器分组、分发 404、迁移脚本 dry-run 幂等；
- **IA**：nav 渲染快照、titleForPath 回归、生产隐藏 dev-echo；
- P2 落地时补：emitForDevice 注入+DAG、hostname 全局查重、迁移脚本。

---

## 12. 实施分期与规模

| Phase         | 内容  | 规模                                                                                                                            | 依赖           |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 0 IA          | §1    | ~8 文件，全小改                                                                                                                 | 无             |
| T 模版        | §8    | ~6 文件 + 1 迁移脚本                                                                                                            | 无             |
| P1 设备补丁   | §2-§7 | **~20 文件**（schema、repo、devicePatch、preflight 挂钩、renderCache、5 条 API route、3 个页面/组件、审计、测试）——规模显式确认 | 无             |
| P2 设备级功能 | §9    | 中等（scenario 框架 + tailscale 改造 + 迁移）                                                                                   | P1             |
| P3 条目标签   | 预留  | —                                                                                                                               | 需求触发再设计 |

每期独立可合并：0/T/P1 互不依赖可并行；P1 落地后零设备行为不变即可发布。

---

## 13. 脆弱假设（明示）

1. **所有设备差异可归入：顶层键补丁 / 设备级功能 / (P3) 条目标签。**
   反例出现（如「同一策略组在手机上成员不同」）→ 模型不扩展，答案是克隆 profile。
2. **preflightProfileConfig 是且将继续是唯一保存闸口。** 新增绕过它的写路径会同时
   破坏现有不变量与设备保护 —— AGENTS.md 已约束，设备层不新增风险，只放大既有约束
   的价值。
3. **补丁作用于渲染产物而非渲染输入。** 若未来需要设备影响渲染输入（按设备选节点源），
   那是 profile 级差异，不进设备层。
