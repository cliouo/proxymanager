# ProxyManager 需求文档

> 个人网络代理管理工具的需求梳理与设想，持续追踪、持续更新。
> 创建日期：2026-05-19

---

## 0. 项目目标（一句话）

打造一套**比 Sub-Store 更贴合个人使用习惯**的代理管理体系，重点解决：
1. **细粒度域名 → 节点策略**的快速测速与一键写入；
2. **订阅聚合 + 规则集 + 主配置**的结构化云端管理；
3. 在浏览器（首选）/ 桌面启动器（次选）侧提供顺手的操作入口。

---

## 1. 现状与痛点

### 1.1 当前栈

- **客户端**：Clash 系产品
- **订阅 / 配置托管**：Sub-Store（自部署或公共实例）
- **节点来源**：多个机场订阅 + 一些零散的 SS / VLESS 单节点
- **配置组织**：
  - 主 Clash 配置文件（静态文件）
  - 多个规则集文件（静态文件，由主配置 `rule-providers` 引用）
  - 全部用 Sub-Store 的**裸文件托管**承载，靠**人脑约定**区分哪个文件是规则集、哪个是主配置

### 1.2 痛点清单

| # | 痛点 | 触发场景 |
|---|------|----------|
| P1 | 一个网站的不同子资源（主站、图床、下载源）最优节点地区往往不同，但通用规则集只覆盖了头部域名，长尾域名一律走"默认 → 其他"策略组 | 浏览网页、看图、下载附件 |
| P2 | 手动给某个域名挑最优地区流程繁琐：开客户端 → 找测速入口 → 改测速 URL → 跑测试 → 看结果 → 编辑规则文件 → 推送 → 客户端重载 | 任何想给新域名打"标签"的时候 |
| P3 | 不是所有 Clash UI 客户端都允许自定义测速 URL，经常要切换客户端才能测 | 移动端尤其明显 |
| P4 | Sub-Store 只是裸文件托管，没有"主配置 / 规则集 / 订阅"语义层，结构化全靠自己维护 | 改规则、加订阅时 |
| P5 | 链式代理（前置代理 → 静态住宅）配置只能手写 YAML，没有可视化入口 | 用静态住宅代理时 |
| P6 | 多设备同步依赖各端订阅同一个 URL，改一处全局生效这点 Sub-Store 已经满足，但改的"过程"不够顺手 | 日常修改 |

---

## 2. 核心需求

按优先级排序，P0 = 必须，P1 = 重要，P2 = 后续再说。

### 需求 A：域名级智能代理路由（P0）

**目标**：在我浏览页面时，能**快速**对当前页面相关的任意域名跑一次"哪个地区节点最快"的测试，并把结果**一键**写入规则集，所有设备自动同步。

**展开**：

- A1. 抓取"当前页面 / 当前标签页"涉及的所有请求域名，列表展示
- A2. 对选中域名（单个 / 批量）发起测速，候选维度至少包含：
  - 各地区策略组（香港、日本、新加坡、美国 …）
  - 评估指标：延迟、下载带宽（可选）、丢包（可选）
- A3. 测速完成后，给出推荐策略组，**一键**写入对应规则集文件
- A4. 写入后触发本地 Clash 重载配置（通过 Clash External API）
- A5. 历史记录：哪个域名什么时候被打了什么标签，方便回顾 / 撤销

**已知调用接口**：

- 本地 Clash External Controller：默认 `http://localhost:9090`
  - `GET /proxies` 列策略组与节点
  - `GET /proxies/{name}/delay?url=...&timeout=...` 单节点测速
  - `PUT /configs` 重载配置
- Sub-Store 替代后端的写入接口（见需求 B）

---

### 需求 B：Sub-Store 替代 / 增强（P0）

**目标**：把"订阅聚合 + 规则集管理 + 主配置生成"做成**有语义结构**的服务，对外暴露稳定 API，让浏览器插件 / 启动器插件 / 移动端订阅 URL 都能用。

**展开**：

- B1. **订阅源管理**：多机场订阅 URL + 零散单节点（SS / VLESS / Trojan / Hysteria 等）的统一接入
- B2. **规则集管理**：
  - 按主题拆分（emby、ai、dev、media、self-hosted …）
  - 每条规则带元数据：来源（手动 / 测速推荐）、添加时间、目标策略组、备注
- B3. **主配置生成**：从订阅 + 规则集 + 模板生成最终下发给客户端的 Clash YAML
- B4. **链式代理可视化**（P5 痛点）：前置代理 → 落地代理的可视化串联
- B5. **API**：增改查规则、触发重新生成主配置、列出策略组等
- B6. **多设备订阅 URL**：客户端长期订阅一个稳定 URL，背后内容动态生成

**部署方案设想**：

- 首选 **Vercel**：免费公网、Edge Function、Vercel KV / Postgres 免费额度
- 替代选项：Cloudflare Workers + KV / D1
- 数据规模评估：规则条目预估 < 10k，订阅源 < 20 个，KV 完全够用

---

### 需求 C：操作入口（载体）

#### C1. 浏览器插件（P0，首选）

**优势**：

- 天然拿得到当前页面 URL、所有子请求域名（`webRequest` API）
- 可以直接调本地 `localhost:9090` 的 Clash API（注意 CORS / 本地 HTTP 权限）
- 可以直接调远端 Sub-Store 替代后端

**最小可用功能**：

1. Popup 列出当前 Tab 的所有请求域名
2. 单选 / 多选 → 触发测速
3. 显示测速结果 + 推荐策略组
4. 一键写入规则集 + 触发 Clash 重载
5. 历史记录 & 撤销

**待决策**：

- Chrome 优先还是 Firefox 优先？还是从一开始就 WebExtension 跨浏览器？
- 是否需要 Background Service Worker 常驻做定时巡检？

#### C2. uTools / Raycast 插件（P2，后续）

**劣势**：拿不到"当前正在浏览的 URL"，需要手动复制粘贴
**优势**：不限于浏览器场景，比如非浏览器流量也想打标签时
**结论**：先做浏览器插件，这块**搁置**，等核心链路跑通后视情况补

---

## 3. 架构设想（粗）

```
┌─────────────────────┐         ┌──────────────────────┐
│   Browser Extension │ ──────▶ │  ProxyManager Backend│
│  (Popup + BG SW)    │         │  (Vercel + KV)       │
└──────────┬──────────┘         │  - 订阅聚合           │
           │                    │  - 规则集 CRUD        │
           │ Clash API          │  - 主配置生成         │
           │ (localhost:9090)   │  - 订阅 URL 出口      │
           ▼                    └──────────┬───────────┘
┌─────────────────────┐                    │
│   Local Clash       │ ◀──────订阅 URL────┘
│   (Mihomo / etc.)   │
└─────────────────────┘
```

数据流：

1. 插件从浏览器拿到域名 → 调本地 Clash 测速 → 拿到推荐策略组
2. 插件把"域名 + 策略组"PUT 到后端 → 后端写入规则集存储
3. 后端按订阅 URL 被拉取时，动态生成最新主配置
4. 本地 Clash 收到新配置 → 生效

---

## 4. 技术栈候选

| 模块 | 候选 | 备注 |
|------|------|------|
| 后端运行时 | Vercel Functions（Node runtime） | 免费够用 |
| 后端存储 | **Upstash Redis**（经 Vercel Marketplace 接入） | 已决——base.yaml = string、rules = Hash；预估 ~1.1k 命令/月 |
| 后端语言 | TypeScript | 与前端共享类型 |
| 浏览器插件 | WebExtension + TypeScript + Vite / WXT / Plasmo | WXT 现代化较好 |
| 配置生成 | 自写 YAML 模板 + 锚点字符串替换 | 兼容 Mihomo 语法 |

### 4.1 存储模型（MVP 草案，2026-05-19）

基于真实 `mysub` 文件分析（~470 行、17 proxy-groups、13 rule-providers、~90 rules、DNS 含 40+ fake-ip-filter）后的拆分粒度结论：**只把"高频结构化改动"的 rules 单独拆，其他保留为整块 YAML 文本**。

#### 存储分布

| 内容 | 载体 | 写入频率 | 形态 |
|------|------|---------|------|
| 主配置骨架：dns / tun / sniffer / profile / proxy-providers / proxies / proxy-groups / rule-providers / rule-anchor / 顶层标量 | KV string 或 Vercel Blob（择一） | 低-中 | YAML 文本，保留注释与对齐，UI 用 Monaco 直接编辑 |
| 手动规则条目 | Redis Hash（单 key `rules`，每条 = 一个 field） | 高 | 结构化，浏览器插件 / API 增改 |

不拆 DNS / TUN 等独立块的理由：跟得上 Mihomo 升级、保留你手写的注释顺序、低频块用文本编辑器更顺手。

#### 多锚点设计

base.yaml 在 `rules:` 列表里通过注释标记若干**命名注入点**，每条手动规则归属一个锚点：

```yaml
rules:
  - GEOIP,lan,直连
  - DST-PORT,9993,直连
  - RULE-SET,zerotier_classic,直连
  # === ANCHOR: prelude ===        ← 早期豁免插入点
  # === ANCHOR: manual ===         ← 主手动规则插入点（测速默认进这里）
  - RULE-SET,geolocation-!cn,其他
  - RULE-SET,cn_ip,国内
  # === ANCHOR: late ===           ← 末尾覆盖
  - MATCH,其他
```

锚点名称由 base.yaml 自由定义；编辑 base.yaml 即可新增 / 重命名 / 删除锚点。

#### rules Hash schema

```typescript
// Redis: HASH "rules"
//   field: rule_id (uuid 或 hash(type+value+policy))
//   value: JSON 字符串
{
  anchor: "manual",            // 必填，对应 base.yaml 里某个锚点名
  type: "DOMAIN" | "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD"
      | "RULE-SET" | "IP-CIDR" | "GEOIP" | "DST-PORT" | ...,
  value: "emby.media",
  policy: "香港",               // 必须是 base.yaml 里已存在的 proxy-group 名
  rank: 1000,                  // 同 anchor 内升序排，建议步长 10 留余地
  source: "manual" | "speedtest" | "import",
  added_at: 1716000000,
  note: "Emby 主站测速 HK 最快"
}
```

#### 渲染流程（订阅 URL 被拉时）

1. 读 base.yaml（1 op）
2. `HGETALL rules`（1 op）
3. 按 `anchor` 分组，组内按 `rank` 升序
4. 逐锚点把渲染好的 YAML 片段替换到 `# === ANCHOR: xxx ===` 行
5. 返回完整 YAML

总开销：**2 个存储 op + 一次字符串处理，预期 < 50ms**。

#### proxy-providers 自引用

base.yaml 的 `proxy-providers` 不再指向外部 Sub-Store，而是指向本项目端点（如 `/api/sub/{name}`），由本项目内部聚合机场订阅 + 散节点。多份订阅集合用不同 `name` 区分。

#### 一致性边界

- 用户改 base.yaml 删除了某锚点 → 该锚点下的 rules 怎么办？候选策略：(a) 拒绝保存 base.yaml + 提示孤儿 rule，(b) 接受保存 + rule 状态标 orphan + 渲染时跳过。倾向 (a)。
- 用户改 base.yaml 删除了某 proxy-group → 引用该 group 的 rules 同上，倾向拒绝保存 + 列出影响。
- 这两类一致性检查在 base.yaml 保存时同步跑，开销忽略不计（< 1k 行的字符串扫描）。

### 4.2 鉴权（MVP 草案，2026-05-19）

混合鉴权：订阅类走 URL token、管理类走 Bearer header。

| 端点类型 | 路径示例 | 鉴权 | 凭据 env |
|---------|---------|------|---------|
| 订阅出口 | `GET /api/sub/{token}/{name}` | URL 路径 token | `SUB_TOKEN`（32+ 随机字符） |
| 管理 API（写） | `POST /api/rules`、`PUT /api/base` | `Authorization: Bearer {key}` | `ADMIN_KEY` |
| 元信息只读 | `GET /api/anchors`、`GET /api/policies` | Bearer | 同上 |

**设计理由**：

- 订阅必须走 URL token——Clash 系客户端跨平台对自定义 Header 支持不齐（Mihomo 行、Shadowrocket 等不一定行），URL 是唯一万能通道
- 管理 API 调用方是浏览器插件，Header 鉴权零成本且更安全（不留路径痕迹）
- 不用 Vercel Password Protection：Pro 才有，且对订阅 URL 不可行

**轮换策略**：MVP 单凭据。换 = 改 Vercel env vars + redeploy + 各端订阅链接更新一遍。后期可演进到双 token 灰度。

---

## 5. API 设计（MVP 草案，2026-05-19）

### 5.1 总体规范

| 维度 | 选择 | 依据 |
|------|------|------|
| 路径 | 管理 API `/api/v1/{resource}`（复数名词、URL 版本化）；订阅 URL `/api/sub/{token}/{profile}`（**不带 v1**） | 订阅 URL 客户端硬编码长期不变，演进靠请求参数和 header，不靠路径 |
| 方法 | GET / POST / PUT / PATCH / DELETE | 标准 REST |
| 自定义动作 | `POST /api/v1/{resource}:{verb}` | Google AIP-136 风格，如 `:batch` `:validate` |
| 成功响应 | `{ "data": ..., "meta": ... }` | 单层嵌套，便于扩展元信息 |
| 错误响应 | `application/problem+json` 遵循 RFC 7807 | 行业标准、可机读 |
| 并发控制 | base.yaml 用 `ETag` + `If-Match` 乐观锁 | 防止两个编辑器互相覆盖 |
| 幂等 | 批量写支持 `Idempotency-Key` header | Stripe 模式，重试安全 |
| 入参校验 | Zod schema | 校验失败 → 422 Problem Details |
| 文档 | `zod-to-openapi` 生成 OpenAPI 3.1，挂 `/api/v1/openapi.json` + Scalar UI 在 `/docs` | 自动同步、可机读 |
| CORS | 管理 API 允许浏览器插件 origin；订阅 URL 允许 `*` | 插件必须能跨域调 |
| 速率限制 | MVP 不做应用层，依赖 Vercel 自带 burst 防护；后期 Upstash Ratelimit middleware | 个人项目用量低 |

**HTTP 状态码语义**：200 / 201 / 204 / 400 / 401 / 403 / 404 / 409（资源冲突，如同名 rule）/ 412（ETag 不匹配）/ 422（语义校验失败，如孤儿引用）/ 429。

### 5.2 端点清单

#### 订阅出口（公开，URL token 鉴权）

```
GET /api/sub/{token}/{profile}     主端点，profile MVP 固定为 default
GET /api/sub/{token}                302 → /default（便利重定向）
```

**响应头**：
```
Content-Type: text/yaml; charset=utf-8
Subscription-Userinfo: upload=...; download=...; total=...; expire=...
Profile-Update-Interval: 24
Content-Disposition: attachment; filename="proxymanager.yaml"
Cache-Control: no-store
X-Build-Id: {short-hash}
```

#### 管理 API（Bearer 鉴权，JSON）

##### Rules
```
GET    /api/v1/rules                列表（查询: anchor, policy, type, q, sort, limit, offset）
POST   /api/v1/rules                创建
GET    /api/v1/rules/{id}           单条
PUT    /api/v1/rules/{id}           整体替换
PATCH  /api/v1/rules/{id}           部分更新（如只改 policy）
DELETE /api/v1/rules/{id}           删除
POST   /api/v1/rules:batch          批量增/改/删（支持 Idempotency-Key）
POST   /api/v1/rules:reorder        重排 rank
```

##### Base config
```
GET    /api/v1/base                 读：返回 content + etag + anchors + policies
PUT    /api/v1/base                 写：需要 If-Match header
POST   /api/v1/base:validate        干跑校验（不写入）
```

##### Subscriptions（机场订阅源）
```
GET    /api/v1/subscriptions
POST   /api/v1/subscriptions
GET    /api/v1/subscriptions/{id}
PUT    /api/v1/subscriptions/{id}
DELETE /api/v1/subscriptions/{id}
POST   /api/v1/subscriptions/{id}:refresh   主动拉取上游
```

##### Proxies（散节点）
```
GET / POST / GET-by-id / PUT / DELETE 同上模式
```

##### 派生只读
```
GET /api/v1/anchors                 解析 base.yaml 得到的锚点名列表
GET /api/v1/policies                解析得到的 proxy-group 名列表
GET /api/v1/preview/{profile}       渲染完整 YAML 但不发布（调试用）
GET /api/v1/health                  健康检查
```

### 5.3 资源 Schema（Zod 风格）

```typescript
const Rule = z.object({
  id: z.string().uuid(),
  anchor: z.string().min(1),
  type: z.enum([
    "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-REGEX",
    "RULE-SET", "GEOIP", "GEOSITE",
    "IP-CIDR", "IP-CIDR6", "IP-ASN",
    "SRC-IP-CIDR", "DST-PORT", "SRC-PORT",
    "PROCESS-NAME", "PROCESS-PATH", "NETWORK", "MATCH",
  ]),
  value: z.string(),                   // MATCH 可空
  policy: z.string(),                  // 必须存在于 base.yaml 的 proxy-groups
  rank: z.number().int(),              // 同 anchor 内升序，建议步长 10
  source: z.enum(["manual", "speedtest", "import"]),
  added_at: z.number().int(),
  updated_at: z.number().int(),
  note: z.string().optional(),
});

const Subscription = z.object({
  id: z.string().uuid(),
  name: z.string().regex(/^[a-z0-9-]+$/),
  url: z.string().url(),
  enabled: z.boolean(),
  ua_override: z.string().optional(),
  last_synced_at: z.number().int().optional(),
  last_traffic: z.object({
    upload: z.number(),
    download: z.number(),
    total: z.number(),
    expire: z.number(),
  }).optional(),
});

const Proxy = z.object({
  id: z.string().uuid(),
  name: z.string(),
  proxy_yaml: z.string(),              // 单节点 YAML 片段
  enabled: z.boolean(),
});

const BaseConfig = z.object({
  content: z.string(),
  anchors: z.array(z.string()),
  policies: z.array(z.string()),
  etag: z.string(),
  updated_at: z.number().int(),
});

const Problem = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z.array(z.unknown()).optional(),
});
```

### 5.4 示例

#### 创建规则

```http
POST /api/v1/rules
Authorization: Bearer ********
Content-Type: application/json

{
  "anchor": "manual",
  "type": "DOMAIN-SUFFIX",
  "value": "emby.media",
  "policy": "香港",
  "source": "speedtest",
  "note": "HK 81ms < JP 130ms"
}
```

```http
HTTP/1.1 201 Created
Location: /api/v1/rules/0a3f...
Content-Type: application/json

{ "data": { "id": "0a3f...", "rank": 1010, ... } }
```

#### 更新 base.yaml（乐观锁 + 一致性校验）

```http
PUT /api/v1/base
Authorization: Bearer ********
If-Match: "a1b2c3d4"
Content-Type: application/json

{ "content": "..." }
```

冲突：
```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json

{
  "type": "https://proxymanager/errors/etag-mismatch",
  "title": "Base config has been modified",
  "status": 412,
  "detail": "Current ETag is e5f6g7h8, your If-Match was a1b2c3d4"
}
```

一致性校验失败：
```http
HTTP/1.1 422 Unprocessable Entity
Content-Type: application/problem+json

{
  "type": "https://proxymanager/errors/orphan-references",
  "title": "Base would orphan existing rules",
  "status": 422,
  "errors": [
    {"rule_id": "0a3f...", "reason": "anchor 'manual' not present in new base"},
    {"rule_id": "0b4e...", "reason": "policy 'NewGroup' not found"}
  ]
}
```

#### 批量

```http
POST /api/v1/rules:batch
Authorization: Bearer ********
Idempotency-Key: 7c9e...
Content-Type: application/json

{
  "ops": [
    {"op": "create", "rule": {...}},
    {"op": "update", "id": "...", "patch": {"policy": "日本"}},
    {"op": "delete", "id": "..."}
  ]
}
```

返回每条 op 的结果数组，整体成功用 200、部分失败用 207 Multi-Status。

### 5.5 数据访问层映射

| 端点 | Redis 命令 | 备注 |
|------|-----------|------|
| `GET /rules` | `HGETALL rules` | 应用层过滤/排序 |
| `POST /rules` | `HSET rules {id} {json}` | 同时维护 `meta:rank_seq` 自增 |
| `PATCH /rules/{id}` | `HGET` → 合并 → `HSET` | 单 op 无需 transaction |
| `DELETE /rules/{id}` | `HDEL rules {id}` | |
| `:batch` | `MULTI` / `EXEC` | 原子 |
| `GET /base` | `GET base:content` + 解析得 etag/anchors/policies | etag 缓存到 `meta:base_etag` |
| `PUT /base` | `WATCH base:content` → 验 If-Match → `MULTI`/`SET`/`EXEC` | 防止竞态 |
| `GET /sub/...` | `GET base:content` + `HGETALL rules` + 渲染 | 2 op、< 50ms |

### 5.6 关键设计点

- **订阅 URL 不带 `v1`**：客户端配的 URL 永久稳定，演进通过查询参数（如 `?target=`）和响应头声明
- **管理 API 带 `v1`**：未来不兼容变更走 `v2`，老插件版本继续用 v1
- **ETag 算法**：`sha256(base.content).slice(0, 16)`，每次 PUT 后重算并存 `meta:base_etag`
- **rank 步长 10**：插入新规则取相邻两条 rank 的中位数，避免每次都全局重排；空隙耗尽时触发 `:reorder` 全量重排
- **profile 字段提前设计**：MVP 只支持 `default`，但 URL 结构里就有占位，未来加多 profile 不破坏现有客户端
- **解析的 anchors / policies 是派生数据**：写入 base 时解析并存 Redis 一份（`meta:anchors`、`meta:policies`），读取时 O(1)，不每次都 parse YAML
- **OpenAPI 自动生成**：Zod 是单一真实源，schema 改动自动反映到 `/api/v1/openapi.json` 和 `/docs`

---

## 6. 开放问题（待决策）

- **Q1**：要不要兼容 Sub-Store 的订阅 URL 格式，做成可平滑迁移？还是另起炉灶？
- ~~**Q2**：规则集存储用 KV 的 key-value，还是直接存 YAML 文本？前者灵活、后者直观~~ — 已决（见 §4.1）：base.yaml 整块文本 + rules 结构化 Hash + 多锚点注入
- **Q3**：测速时的"基准 URL"用什么？默认 Clash 测速 URL 是 `http://www.gstatic.com/generate_204`，但要测域名级别的真实速度，可能需要用该域名自己的小资源（favicon、robots.txt）
- **Q4**：浏览器插件调 `localhost:9090` 在 HTTPS 页面下会被 Mixed Content 拦，怎么绕？（用 background fetch / declarativeNetRequest？）
- **Q5**：链式代理可视化的优先级到底多高？是否进 MVP？
- **Q6**：移动端（iOS Shadowrocket / Loon / Stash, Android Clash Meta）的"写入后重载"怎么做？还是只在桌面端做自动重载？
- **Q7**：是否要做权限 / 多用户？还是纯个人单租户？（倾向单租户，简单优先）

---

## 7. 里程碑设想

- **M0 - 调研**：跑通本地 Clash API 调用、Vercel KV 存取、WebExtension MV3 hello world
- **M1 - 后端骨架**：订阅聚合 + 规则集 CRUD + 主配置生成 + 订阅 URL 出口（可替代当前 Sub-Store 用法）
- **M2 - 浏览器插件 MVP**：列当前 Tab 域名 + 测速 + 一键写入 + 触发本地重载
- **M3 - 体验完善**：历史 & 撤销、批量操作、链式代理可视化
- **M4 - 选做**：uTools / Raycast 插件、移动端伴侣

---

## 8. 变更记录

- 2026-05-19：初始版本，整理首次脑暴
- 2026-05-19：克隆参考项目到 `reference/`
  - `reference/mihomo/` —— Clash Meta 内核，参照 External API、规则语法、链式代理实现
  - `reference/Sub-Store/` —— Sub-Store，参照订阅解析、配置生成、模板系统
- 2026-05-19：MVP 范围定为"最小集"——订阅聚合 + 规则集存取 + 主配置生成（节点加工 / 链式代理可视化暂不做）
- 2026-05-19：核查 Neon 免费额度——100 个 project、100 CU-h/月够用（实际预估 ~12 CU-h/月）；KV 命令配额按 Hash 方案预估 ~1.1k 次/月，占免费额 3.7%
- 2026-05-19：基于真实 `mysub` 文件定下存储模型（§4.1）：base.yaml 整块 + rules Hash + 多锚点注入；proxy-providers 自引用本项目端点
- 2026-05-19：存储后端定为 Upstash Redis（经 Vercel Marketplace 接入），不引入 Blob / Neon；鉴权定为 §4.2 的混合方案（订阅 URL token + 管理 Bearer）
- 2026-05-19：API 设计落档（§5）：RESTful + `/api/v1/` 版本化 + RFC 7807 错误 + ETag/If-Match 乐观锁 + AIP-136 自定义动作 + Idempotency-Key 批量 + Zod schema → OpenAPI 3.1 自动生成；订阅 URL 不带 v1 保持长期稳定
- 2026-05-20：自定义动作改用子路由（`/rules/batch`、`/rules/reorder`、`/base/validate`）而非 `:verb`，避免文件名带冒号的跨平台风险；AIP-136 风格降级到 §5 描述层
- 2026-05-20：M1 项目骨架命名 `proxymanager-web`（不是 backend），目录 `web/`；后续浏览器插件用同级 `extension/`
- 2026-05-20：Tasks #1–#21 实现完成（脚手架、Upstash 接入、健康检查、Bearer/URL-token 鉴权 + CORS、RFC 7807 错误框架、Zod 4 schemas、zod-to-openapi + Scalar `/docs`、Repository 层、引擎三件套（parser/renderer/validator）+ 26 单元测试、Base 端点 GET/PUT/validate/anchors/policies、Rules 端点 list+CRUD+batch+reorder、订阅出口 `/api/sub/{token}/{profile}` + 302 重定向、`/preview/{profile}` 调试、mysub 导入脚本）。Task #22 preview 部署成功，待 Upstash 明文 KV_* 注入 .env.local 后跑 import + 推 prod + 完成 Task #23 真实 Clash 客户端端到端验证
- 2026-05-20：发现 Next.js 16 Turbopack 在 collect-page-data 阶段对 zod-to-openapi prototype mutation 不友好；workaround：build script 用 `next build --webpack`，schemas/index.ts 把 `@/lib/openapi/setup` 加为首位 side-effect 引入
- 2026-05-20：M1 收官——Production 部署 https://proxymanager.vercel.app 跑通，Mihomo 客户端订阅 https://proxymanager.vercel.app/api/sub/{SUB_TOKEN}/default 加载无误，手动规则方向正确
- 2026-05-20：parser 修正——policies 现包含 `proxy-groups[].name` + `proxies[].name`（如 `type: direct` 单节点别名）+ Mihomo 内置（DIRECT/REJECT/REJECT-DROP/PASS/COMPATIBLE），避免一致性校验把合法节点引用误判为孤儿
- 2026-05-20：M1b 落地——`subscriptions` 资源 CRUD + `POST /api/v1/subscriptions/{id}/refresh` 主动拉上游 + `GET /api/sub-providers/{token}/{name}` 公共 provider 出口（SUB_TOKEN 鉴权，输出 Clash provider YAML，转发 Subscription-Userinfo）。MVP fetcher 仅支持 Clash YAML 上游；base64 / 单节点 URI 列入后续。+11 单元测试（共 38 通过）
- 2026-05-20：Web UI 落地——Tailwind v4 + 手写 Button/Input/Card/Badge 极简组件，无 shadcn/Monaco/TanStack；4 个鉴权页（`/`/`/base`/`/rules`/`/subscriptions`）+ `/login`（admin key 存 sessionStorage）。`/api/v1/meta` 新增端点向 UI 暴露订阅 URL 和 provider base。`react-hooks/set-state-in-effect` 规则禁用（SPA fetch-on-mount 模式不可避）
- 2026-05-20：M1b + Web UI Production 部署 https://proxymanager.vercel.app（仍 alias 到主域）。base.yaml 中 `proxy-providers` 当前仍指向 substore.iouo.top；用户可按需在 Subscriptions 页添加机场后，把 base.yaml 里的 URL 改成自家 `/api/sub-providers/{token}/{name}` 完成完整切换
- 2026-05-20：M1c 落地——`rule-sets` 资源（用户自维护的规则集 YAML/text，如 emby.yaml / emby-stream.yaml / zerotier.yaml 这类原本托管在 Sub-Store 的静态文件）。新增 6 个管理端点 + 公开出口 `GET /api/rule-providers/{token}/{name}`（返回 raw 内容、Content-Type 按 format 选 yaml/plain、ETag 走 `{id}-{updated_at}`）。Web UI `/rule-sets` 页支持创建/行内编辑/删除/复制 provider URL；Sidebar 加导航；`/api/v1/meta` 暴露 `ruleProvidersBase`。+7 service 测试（共 45 通过）。至此 Sub-Store 三大用法（订阅聚合 / 主配置托管 / 规则集托管）均有本项目对位实现，剩下只需用户把 base.yaml 的 `rule-providers.*.url` 切到 `/api/rule-providers/{token}/{name}` 完成最后切换
- 2026-05-20：本地 git 仓库初始化（main 分支、单个 initial commit），`.gitignore` 双层防护排除 `reference/` `.vercel` `.env*` `node_modules` `.next` `.DS_Store`，远端暂未推送
- 2026-05-20：M2 浏览器插件骨架落地（`extension/`，WXT 0.20 + React 19 + Tailwind v4 + Manifest V3）。结构：`background.ts` 用 `webRequest.onBeforeRequest` 按 tabId 聚合域名（main_frame 导航时清空）；`lib/clash.ts` 调本地 Mihomo External Controller（`/proxies/{name}/delay?url=...&timeout=...` 测延迟、`PUT /configs?force=true` 重载）；`lib/backend.ts` 调 ProxyManager `/api/v1/policies` `/api/v1/rules`。Options 页配置后端 URL / ADMIN_KEY / Clash URL / 候选 proxy-groups，Popup 列当前 tab 域名、勾选 → speedtest → 表格显示各 group 延迟 → 一键写规则。MV3 + WXT 的 `browser` 全局自动注入，Mixed Content 通过"所有 fetch 由 SW 发起"绕开（REQUIREMENTS Q4 解）。Chrome build 产物 373KB
- 2026-05-20：插件发布工程化——自定义 SVG 图标（`extension/assets/icon.svg` → `npm run icons` 用 sharp 出 16/32/48/96/128 PNG），CRX 打包（`npm run pack:crx` 走 `crx3`，私钥 `key.pem` 首次自动生成、严格 gitignore），版本号 release 流程（`npm run release:{patch,minor,major}` = bump + build + pack + commit + tag `extension-v{version}`，不自动 push）。产出 `extension/dist/proxymanager-0.1.0.crx` ~118 KB
- 2026-05-20：M2 打磨 A 路线（`extension-v0.1.1`）——三件套合一：(1) 写规则后自动 `PUT /configs?force=true` 重载 Clash，Options 提供 `autoReloadClash` 开关（默认开），reload 失败 inline 提示但不算 write 失败；(2) 客户端 recent-writes ring buffer（`storage.local`，cap 20），popup 顶部可折叠卡片显示 policy chip + reloaded 状态点 + 相对时间戳；(3) 写规则前冲突预检——按当前 anchor 拉 `GET /api/v1/rules?anchor={...}&limit=500`，命中既有 DOMAIN-SUFFIX（或同 type 同 value）覆盖时显示 "Redundant"（同 policy）或 "Refines"（异 policy）警告条，不阻断写入。新增 `BackendRule` 契约类型 / `listRulesByAnchor` RPC / `lib/recent-writes.ts`。构建 394.8 KB
