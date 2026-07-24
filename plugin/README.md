# ProxyManager 配置助手 · Skill Plugin

把 ProxyManager 的内置 AI 从「一个巨型 system prompt + 浏览器自管的 tool loop」改造成**官方
Agent Skills 规范**的可移植包：**5 个 skill（1 hub + 4 深水区 spoke）** 坐在**一个 `proxymanager`
MCP server** 上。任何支持 skill 的客户端（网页内 AI / Claude Code 本地 / Codex）都能用同一套工作法
驱动同一个 ProxyManager 后端。

> 设计依据见 `MIGRATION.md`（含从 `web/lib/ai/systemPrompt.ts` 各段到 skill/文件的映射）。

## 结构

```
plugin/
├── .claude-plugin/plugin.json        # 清单 + userConfig(安装时弹表单) + mcpServers.proxymanager (stdio)
├── skills/
│   ├── managing-clash-config/        # hub：常驻入口 + 横切护栏 + 规则/规则集/骨架/读
│   ├── synthesizing-proxy-groups/    # spoke：策略组成员合成 + filter 试算
│   ├── editing-node-operators/       # spoke：算子管线 + 所有改名(含本地源)
│   ├── managing-devices/             # spoke：设备差量补丁 + 设备级 Tailscale + 模版/分发语义
│   └── optimizing-whole-config/      # spoke：整体优化编排
│       └── 每个 skill 含 SKILL.md + references/(占位) [+ assets/]
├── hooks/
│   └── elicitation-autoconfirm.mjs   # CC bypassPermissions + 信任开关时自动接受确认表单
├── servers/
│   ├── proxymanager-mcp.mjs          # MCP↔HTTP 桥接源码(代理 registry，保住两步写入门控)
│   ├── dist/proxymanager-mcp.bundle.mjs  # esbuild 单文件产物(plugin.json 指向这里,零运行时依赖)
│   ├── package.json                  # @modelcontextprotocol/sdk + `npm run build`
│   └── README.md                     # 接线说明 + 已知缺口
└── MIGRATION.md                      # 迁移映射 / 分期 / 开放问题

仓库根 .claude-plugin/marketplace.json   # 公开安装入口(单仓库同时是应用仓库和 marketplace)
```

## 5 个 skill 一览

| skill                         | 何时触发                                                                | 拥有工具(数) |
| ----------------------------- | ----------------------------------------------------------------------- | ------------ |
| `managing-clash-config` (hub) | 任何配置请求；规则 / 规则集 / dns/sniffer/tun / 节点真相 / 配置文件生命周期 / 复合任务路由 | 28 |
| `synthesizing-proxy-groups`   | 策略组成员 / filter / 地区组 / 组吃错节点                               | 11           |
| `editing-node-operators`      | 算子管线 / 重命名 / 加旗 / 去重 / 本地源改名                            | 9            |
| `managing-devices`            | 设备差量补丁 / 按设备不同 / 设备级 Tailscale / 模版与设备订阅链接       | 7            |
| `optimizing-whole-config`     | 整体优化 / 通盘检查（单点小改不触发）                                   | 7            |

> 工具有意跨 skill 复用（如 `add_rule` / `update_proxy_group`）：同一 MCP server，
> owned-tools 只是组织划分不是沙箱。

## 安装（Claude Code）

```
/plugin marketplace add cliouo/proxymanager
/plugin install proxymanager@proxymanager
```

安装/启用时 Claude Code 会自动弹出配置表单（来自 `plugin.json` 的 `userConfig`）：

| 配置项            | 必填 | 说明                                                                                 |
| ----------------- | ---- | ------------------------------------------------------------------------------------ |
| ProxyManager 地址 | ✅   | 实例 URL，默认 `http://localhost:3000`                                               |
| Admin Key         | ✅   | 部署 ProxyManager 时设置的 `ADMIN_KEY` 环境变量；存入系统 Keychain 不落明文          |
| 默认 Profile      |      | 初始配置文件名，默认 `default`；会话内可用 `select_profile` 切换                     |
| 完全访问免确认    |      | 默认关。开启后完全信任模式下写入不再弹确认卡（见下），审批类模式不受影响             |
| 请求超时(秒)      |      | 桥接访问 ProxyManager API 的单请求超时，默认 30                                      |

**完全访问免确认**开启后的行为，按客户端分两条路径：

- **Claude Code**：插件自带 `Elicitation` hook，检测到会话处于 `bypassPermissions` 模式时自动
  接受写入确认表单（不弹卡）；其他模式（default / acceptEdits / plan）照常弹卡。
- **Codex 等不提供确认表单的客户端**：完全访问模式下客户端不声明 form elicitation 能力，
  桥接原本会拒绝写入（fail-closed）；开启本项后改为直接消费确认 token 写入。切回
  "请求批准"模式后客户端恢复表单能力，确认卡照常弹出。
- 两条路径下服务端的审计日志、可撤销备份和 neverList 硬黑名单全部照旧生效。

非交互安装（脚本/CI）：`claude plugin install proxymanager@proxymanager --config base_url=… --config admin_key=…`

MCP server 是提交进仓库的单文件 bundle（`servers/dist/`），**无需任何 npm install**；
唯一前提是你的 ProxyManager 实例在线。需要较新版本的 Claude Code（≥ v2.1.207，`userConfig` 机制）。

### 更新

```
/plugin update proxymanager@proxymanager
```

第三方 marketplace 默认**不**自动更新；想跟随更新可在 `/plugin` 面板 → Marketplaces 打开 autoUpdate。
发版侧口径：改动插件必须 bump `plugin.json` 的 `version`，否则用户看不到新版本（CI 会校验 bundle 新鲜度）。

### 其他客户端（Codex / 手动 MCP）

不走 plugin 机制的客户端用等价 `.mcp.json` 手动接 bundle，见 `servers/README.md`。

## 本地开发

```bash
# 用 --plugin-dir 加载本插件（跳过 marketplace；启用时同样会弹 userConfig 表单）
claude --plugin-dir ./plugin

# 改了 servers/proxymanager-mcp.mjs 后重新打包（产物要一并提交）
cd plugin/servers && npm install && npm run build

# 校验清单
claude plugin validate ./plugin   # 插件
claude plugin validate .          # 仓库根 marketplace
```

会话内核对：`/help` 应见 `/proxymanager:managing-clash-config` 等 5 个 skill；`/mcp` 应见 proxymanager (stdio) 已连接。

## 当前状态

- ✅ 5 个 SKILL.md（完整 frontmatter + 正文，已应用压测修法：改名归并到 operators、spoke 安全地板、复合任务路由）
- ✅ 16 个 `references/*` 全部填成正文（逐文件对照 primitives 源码核验）
- ✅ MCP 桥接 server（可跑，代理 registry；写操作由 host form elicitation 展示脱敏 diff 并要求人类确认）+ plugin 清单
- ✅ **网页内 AI 已切到 skill 来源**：`web/lib/ai/systemPrompt.ts` 由 `scripts/build-skills.mjs`
  从本 plugin 的 SKILL.md **组装**（`skills.generated.ts`）；新增 `get_skill_reference` 工具按需读 references。
  改 SKILL.md 后跑 `cd web && npm run build:skills` 重生成。
- ✅ **旧 SSE 链路已退役**（删 `orchestrator.ts` / `chat` 路由 / `session.ts`）。408 测试 + typecheck 全过。
- ✅ **公开分发**：仓库根 `marketplace.json` + `userConfig` 配置表单（Admin Key 进 Keychain）+
  单文件 bundle（零安装依赖）+ 后端离线时懒加载不崩（`tools/list` 返回可读错误）+ plugin CI
  （测试 / bundle 新鲜度 / 双清单校验）。
- 🚧 剩余开放项（eval / claude.ai 远程面 / neverList 收口）见 `MIGRATION.md` §4。
