# proxymanager MCP bridge — 接线说明

把 ProxyManager 应用内的 action 注册表（约 30 个工具）以 **MCP** 形式暴露给任何支持 skill 的
客户端（Claude Code / Codex / …），让它们驱动**同一个后端、同一套服务端写入门控**。

这是**桥接**不是重写：工具 schema 实时取自 `/api/v1/assistant/bootstrap`，调用代理到
`/api/v1/assistant/tool`，写入第二步代理到 `/api/v1/assistant/confirm`。

## 数据流

```
skill-aware client ──stdio──► proxymanager-mcp.mjs ──HTTPS(Bearer ADMIN_KEY)──► ProxyManager
  (CC / Codex)                 (本桥接)                                          Next.js API
     │                            │  GET  /assistant/bootstrap  → 工具 schema (启动时)
     │  tools/list ◄──────────────┤
     │  tools/call(add_rule) ─────► POST /assistant/tool {name,input}
     │                            │      ← envelope{kind:'confirm-write', data:{summary,diff,confirmation_token}}
     │  (向用户展示 summary/diff，取得授权)
     │  tools/call(confirm_write,{token}) ─► POST /assistant/confirm {token} → 执行(审计+可撤)
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXYMANAGER_BASE_URL` | `http://localhost:3000` | ProxyManager 实例地址 |
| `PROXYMANAGER_ADMIN_KEY` | （空） | `Authorization: Bearer <ADMIN_KEY>`，见 `web/lib/auth.ts:requireAdminBearer` |
| `PROXYMANAGER_PROFILE` | `default` | 作为 `?profile=` 注入，见 `web/lib/profileScope.ts`（query > cookie > default） |

## 安装 / 运行

```bash
cd plugin/servers
npm install          # 装 @modelcontextprotocol/sdk
PROXYMANAGER_BASE_URL=http://localhost:3000 \
PROXYMANAGER_ADMIN_KEY=xxxx \
node proxymanager-mcp.mjs      # 需要 ProxyManager 实例在线
```

通过 plugin 安装时，`.claude-plugin/plugin.json` 的 `mcpServers.proxymanager` 已用
`${CLAUDE_PLUGIN_ROOT}` 指到本文件，env 由用户在客户端侧提供。

## 非 plugin 客户端（Codex / 手动）的等价 `.mcp.json`

```json
{
  "mcpServers": {
    "proxymanager": {
      "command": "node",
      "args": ["/绝对路径/proxymanager/plugin/servers/proxymanager-mcp.mjs"],
      "env": {
        "PROXYMANAGER_BASE_URL": "http://localhost:3000",
        "PROXYMANAGER_ADMIN_KEY": "xxxx",
        "PROXYMANAGER_PROFILE": "default"
      }
    }
  }
}
```

## 写入门控为什么仍然安全（即便模型在客户端侧）

- token 由**服务端**铸造（`confirm.ts`，`randomBytes` hex，Redis TTL 300s，`getdel` 一次性消费），
  并绑定 `{actor, action, zod 校验后的 input, profileId}`——客户端模型无法夹带不同 payload 或改写目标 profile。
- `neverList.ts` 是硬黑名单，在 preview 和 execute 前各查一次（目前为空占位，随工具面扩张在此单点收口）。
- `<external_data>` 包裹与 `***` 脱敏由服务端做；这些**不在 SKILL.md 里**，模型无法绕过。
- skill 的工具子集（owned tools）只是**组织划分不是沙箱**——孤儿引用连带修复需要跨 skill 调
  `update_proxy_group`/`update_rule`，同一 server 照常可调。

## 已解决 / 已知缺口

- ✅ **`preview_proxy_group_members` 已是服务端 action**（`web/lib/ai/actions/primitives/proxyGroupWrites.ts`，
  在 `PROXY_GROUP_READ_ACTIONS` 里、有专测），故已在 registry → bootstrap → 本桥接里暴露，CC/Codex 照常可用。
  浏览器另有一份本地实现（`assistantTools.ts`，零往返快路），两份共用 `matchFilter` 保持一致——
  有意保留的 dual-impl，不是缺口。
- ✅ **bootstrap 的 systemPrompt 现由 skill 组装**（`web/lib/ai/systemPrompt.ts` ← `skills.generated.ts`
  ← `plugin/skills`）。本桥接仍忽略它（CC/Codex 原生读 skill 文件），只取其中的 `tools`。
- 🚧 **claude.ai / API 面**（本批不含）：需把本 server 暴露成 remote connector；注意 API code-exec
  无网络，`search_mihomo_docs`/`fetch_url` 在该面失效，需 `compatibility` 声明。
