# proxymanager MCP bridge — 接线说明

把 ProxyManager 应用内的 action 注册表（40+ 个工具，运行时从 bootstrap 实时拉取、不硬编码）以
**MCP** 形式暴露给任何支持 skill 的客户端（Claude Code / Codex / …），让它们驱动
**同一个后端、同一套服务端写入门控**。

这是**桥接**不是重写：工具 schema 实时取自 `/api/v1/assistant/bootstrap`，调用代理到
`/api/v1/assistant/tool`；写操作由 MCP host 的 form elicitation 向用户确认后，桥接内部再调用
`/api/v1/assistant/confirm`。一次性 token 不返回模型。

## 数据流

```
skill-aware client ──stdio──► proxymanager-mcp.mjs ──HTTPS(Bearer ADMIN_KEY)──► ProxyManager
  (CC / Codex)                 (本桥接)                                          Next.js API
     │                            │  GET  /assistant/bootstrap  → 工具 schema (启动时)
     │  tools/list ◄──────────────┤
     │  tools/call(add_rule) ─────► POST /assistant/tool {name,input}
     │                            │      ← envelope{kind:'confirm-write', data:{summary,diff,confirmation_token}}
     │  ◄── MCP host form elicitation：用户明确勾选确认
     │                            │  (token 留在桥接内) POST /assistant/confirm → 执行(审计+可撤)
```

## 环境变量

| 变量                             | 默认                    | 说明                                                                                                     |
| -------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `PROXYMANAGER_BASE_URL`          | `http://localhost:3000` | ProxyManager 实例地址                                                                                    |
| `PROXYMANAGER_ADMIN_KEY`         | （空）                  | `Authorization: Bearer <ADMIN_KEY>`，见 `web/lib/auth.ts:requireAdminBearer`                             |
| `PROXYMANAGER_PROFILE`           | `default`               | 作为 `?profile=` 注入，见 `web/lib/profileScope.ts`（query > cookie > default）                          |
| `PROXYMANAGER_TRUST_FULL_ACCESS` | `false`                 | `1`/`true` 时：客户端不提供 form elicitation（如 Codex 完全访问模式）则直接消费确认 token 写入而非拒绝 |
| `PROXYMANAGER_TIMEOUT`           | `30`                    | 单请求超时秒数（5–300）；confirm 超时按"结果未知"处理，不谎报未写入                                      |

通过 plugin 安装时这些值全部来自 `userConfig` 表单；Codex/手动 `.mcp.json` 用户按需自填。

## 构建 / 运行

发行形态是 **esbuild 单文件 bundle**（`dist/proxymanager-mcp.bundle.mjs`，提交进仓库），
终端用户零 npm 依赖。`.claude-plugin/plugin.json` 的 `mcpServers.proxymanager` 用
`${CLAUDE_PLUGIN_ROOT}` 指向 bundle，env 由安装时的 `userConfig` 表单填充
（`${user_config.base_url}` 等；Admin Key 标记 `sensitive`，存 Keychain）。

```bash
cd plugin/servers
npm install                    # 开发依赖(SDK + esbuild)
npm test                       # 桥接门控测试
npm run build                  # 改了 proxymanager-mcp.mjs 后重新打包,产物一并提交(CI 校验新鲜度)

# 直接跑源码调试(需要 ProxyManager 实例在线;后端离线也能起,tools/list 时才拉工具)
PROXYMANAGER_BASE_URL=http://localhost:3000 \
PROXYMANAGER_ADMIN_KEY=xxxx \
node proxymanager-mcp.mjs
```

## 非 plugin 客户端（Codex / 手动）的等价 `.mcp.json`

Bundle 是提交进仓库的单文件，**无需克隆整个仓库**，直接从 GitHub 下载即可：

```bash
curl -fsSL --create-dirs -o ~/.proxymanager/proxymanager-mcp.mjs \
  https://raw.githubusercontent.com/cliouo/proxymanager/main/plugin/servers/dist/proxymanager-mcp.bundle.mjs
```

```json
{
  "mcpServers": {
    "proxymanager": {
      "command": "node",
      "args": ["/Users/你/.proxymanager/proxymanager-mcp.mjs"],
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
  并绑定 `{actor, action, zod 校验后的 input, profileId}`。桥接不把 token 返回模型；只有 MCP host
  的 form elicitation 收到用户明确接受且勾选确认后才消费。客户端不支持表单时写操作直接停止——
  **除非**用户显式开启 `trust_full_access`（完全访问免确认）：此时无表单会话直接消费 token，
  Claude Code 侧则由插件的 Elicitation hook 仅在 `bypassPermissions` 模式下自动接受表单。
  该开关默认关闭，且不绕过 token 校验、服务端审计与 neverList。
- bridge 将 `select_profile` 与所有工具调用串行化，避免切换 profile 与写 preview 并发交错；确认表单
  也明确显示目标 profile。
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
