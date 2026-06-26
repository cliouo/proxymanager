# ProxyManager 配置助手 · Skill Plugin

把 ProxyManager 的内置 AI 从「一个巨型 system prompt + 浏览器自管的 tool loop」改造成**官方
Agent Skills 规范**的可移植包：**4 个 skill（1 hub + 3 深水区 spoke）** 坐在**一个 `proxymanager`
MCP server** 上。任何支持 skill 的客户端（网页内 AI / Claude Code 本地 / Codex）都能用同一套工作法
驱动同一个 ProxyManager 后端。

> 设计依据见 `MIGRATION.md`（含从 `web/lib/ai/systemPrompt.ts` 各段到 skill/文件的映射）。

## 结构

```
plugin/
├── .claude-plugin/plugin.json        # 清单 + mcpServers.proxymanager (stdio)
├── skills/
│   ├── managing-clash-config/        # hub：常驻入口 + 横切护栏 + 规则/规则集/骨架/读
│   ├── synthesizing-proxy-groups/    # spoke：策略组成员合成 + filter 试算
│   ├── editing-node-operators/       # spoke：算子管线 + 所有改名(含本地源)
│   └── optimizing-whole-config/      # spoke：整体优化编排
│       └── 每个 skill 含 SKILL.md + references/(占位) [+ assets/]
├── servers/
│   ├── proxymanager-mcp.mjs          # MCP↔HTTP 桥接(代理 registry，保住两步写入门控)
│   ├── package.json                  # @modelcontextprotocol/sdk
│   └── README.md                     # 接线说明 + 已知缺口
└── MIGRATION.md                      # 迁移映射 / 分期 / 开放问题
```

## 4 个 skill 一览

| skill | 何时触发 | 拥有工具(数) |
|---|---|---|
| `managing-clash-config` (hub) | 任何配置请求；规则 / 规则集 / dns/sniffer/tun / 节点真相 / 复合任务路由 | 18 |
| `synthesizing-proxy-groups` | 策略组成员 / filter / 地区组 / 组吃错节点 | 6 |
| `editing-node-operators` | 算子管线 / 重命名 / 加旗 / 去重 / 本地源改名 | 9 |
| `optimizing-whole-config` | 整体优化 / 通盘检查（单点小改不触发） | 7 |

> 工具有意跨 skill 复用（如 `add_rule` / `update_proxy_group`）：同一 MCP server，
> owned-tools 只是组织划分不是沙箱。

## 本地试用（Claude Code）

```bash
# 1) 起桥接依赖 + 确保 ProxyManager 在线
cd plugin/servers && npm install

# 2) 用 --plugin-dir 加载本插件
cd /Users/zetaai/Code/proxymanager
PROXYMANAGER_ADMIN_KEY=xxxx claude --plugin-dir ./plugin

# 3) 会话内核对
/help        # 应见 /proxymanager:managing-clash-config 等 4 个 skill
/mcp         # 应见 proxymanager (stdio) 已连接，工具已列出
```

校验插件结构：`claude plugin validate ./plugin`

## 当前状态

- ✅ 4 个 SKILL.md（完整 frontmatter + 正文，已应用压测修法：改名归并到 operators、spoke 安全地板、复合任务路由）
- ✅ 15 个 `references/*` 全部填成正文（逐文件对照 primitives 源码核验）
- ✅ MCP 桥接 server（可跑，代理 registry + 合成 `confirm_write`）+ plugin 清单
- ✅ **网页内 AI 已切到 skill 来源**：`web/lib/ai/systemPrompt.ts` 由 `scripts/build-skills.mjs`
  从本 plugin 的 SKILL.md **组装**（`skills.generated.ts`）；新增 `get_skill_reference` 工具按需读 references。
  改 SKILL.md 后跑 `cd web && npm run build:skills` 重生成。
- ✅ **旧 SSE 链路已退役**（删 `orchestrator.ts` / `chat` 路由 / `session.ts`）。408 测试 + typecheck 全过。
- 🚧 剩余开放项（eval / claude.ai 远程面 / neverList 收口）见 `MIGRATION.md` §4。
