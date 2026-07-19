# ProxyManager

> 个人自部署的 Clash / Mihomo 订阅与配置管理平台 —— 结构化管理订阅源、规则、规则集与策略组，渲染出可直接交付客户端的完整配置。
>
> A self-hosted subscription & config manager for Clash / Mihomo, built to replace hand-maintained Sub-Store setups.

[![Deploy](https://img.shields.io/badge/deploy-Vercel-black?logo=vercel)](https://vercel.com)
[![Node](https://img.shields.io/badge/node-22.x-339933?logo=node.js&logoColor=white)](web/package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 为什么做这个

Sub-Store 式的"裸文件托管 + 人脑约定"在配置变多之后难以为继：哪个文件是主配置、哪个是规则集、订阅改名后哪些策略组会断，全靠记忆。ProxyManager 把这些东西全部**结构化**：

- 订阅源、节点、规则、规则集、策略组、Profile 都是一等实体，互相之间的引用关系可见、可校验；
- 每次写入前都会**预演最终渲染结果**，坏配置根本落不了盘；
- 删除被引用的资源会被拦下并告诉你"被谁引用"，重命名会提示级联影响范围。

## 功能特性

**订阅与节点**

- 多订阅源聚合，支持机场订阅、零散 SS / VLESS / Hysteria2 等单节点、本地手工节点
- 节点处理算子管线（顺序敏感、可拖拽重排）：正则过滤、批量重命名、去重、排序、加国旗 emoji、按类型/地区筛选、批量设置 udp / tfo / skip-cert 等属性，改动前可对真实节点预览效果
- 聚合订阅（节点池）：把多个来源合成一个逻辑节点集合，供策略组和分发复用
- 解析策略遵循 mihomo 语义：mihomo 会忽略的参数不拒绝，只拦真正矛盾的配置

**规则与规则集**

- 规则集中管理，支持启用/禁用、去重、排序
- 规则集（rule-providers）作为独立素材库维护，只有被引用的才会注入最终配置
- 浏览器扩展一键写入域名分流规则（见下文）

**策略组**

- 可视化策略组合成器：手选成员、正则自动纳入（filter / exclude-filter）、绑定订阅源/节点池三种来源自由组合
- 7 种预设形态（select / url-test / fallback / load-balance / relay 等）+ raw 逃生舱
- filter 改动前先对真实节点名试算，避免 `us` 误吞 A`us`tralia / R`us`sia 这类事故
- 智能前置池链式代理：filter + fallback/url-test 组成的前置池，订阅更新换节点名也不断链

**Profile 与渲染**

- 多 Profile：每个 Profile 独立拥有 base 骨架、策略组、规则，可从现有 Profile 克隆创建
- base.yaml 骨架（DNS、sniffer、TUN、端口等顶层配置）在线编辑，CodeMirror + YAML 高亮
- 保存前强制预检最终渲染配置，版本一致才提交；渲染结果带缓存，命中时开销极低
- 分发链接：完整配置订阅、节点-only 链接、`?format=base64` 通用 Base64 订阅，附二维码

**AI 助手**

- 内置 AI 配置助手，基于官方 Agent Skills 规范（4 个 skill + 1 个 MCP server）
- 能看懂并修改规则、规则集、策略组、算子管线、base 骨架，做整体配置优化
- 所有写操作先出 diff 确认卡，服务端留审计日志、可撤销备份与硬黑名单兜底
- 同一套 skill 也可装进 Claude Code / Codex 等客户端远程管理你的实例（见 [`plugin/`](plugin/)）

**浏览器扩展**

- 收集当前标签页触达的所有域名，经本地 Clash / Mihomo external controller 做分组延迟对比
- 选中最快的地区组一键写回后端，落成 `DOMAIN-SUFFIX,example.com,香港` 这样的规则

## 仓库结构

```
proxymanager/
├── web/         Next.js 16 全栈应用：管理 UI + API + 渲染引擎（部署到 Vercel）
├── extension/   Chrome MV3 扩展（WXT）：域名收集 + 测速 + 规则写回
├── plugin/      Claude Code 插件：4 个 Agent Skill + MCP↔HTTP 桥接
├── docs/        协议兼容性等文档
├── DESIGN.md    UI 设计规范（Signal Console）
└── REQUIREMENTS.md  需求与演进记录
```

## 快速开始

### 部署（Vercel + Upstash Redis，免费额度即可跑）

1. Fork 本仓库，在 [Vercel](https://vercel.com) 导入，**Root Directory 设为 `web`**
2. 项目 **Storage** 标签页 → Create Database → **Upstash Redis**（自动注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN`）
3. 添加环境变量：

   | 变量 | 说明 |
   | --- | --- |
   | `ADMIN_KEY` | 管理 API 与 Web UI 登录用的 Bearer token，自己生成一个强随机串 |
   | `SUB_TOKEN` | 订阅分发链接里的路径 token，同样生成一个强随机串 |
   | `DEEPSEEK_API_KEY` | （可选）站内 AI 助手使用的模型 key |

4. 部署完成后访问 `https://<你的域名>/`，用 `ADMIN_KEY` 登录即可开始添加订阅源。

订阅交付地址形如：

```
https://<你的域名>/api/sub/<SUB_TOKEN>/<profile>            # 完整 Clash/Mihomo 配置
https://<你的域名>/api/sub/<SUB_TOKEN>/<profile>?format=base64  # 通用 Base64 订阅（仅节点）
```

### 本地开发

```bash
cd web
npm install
npm run vercel:link      # 关联 Vercel 项目（一次性）
npm run vercel:env:pull  # 拉取环境变量到 .env.local
npm run dev              # http://localhost:3000
```

常用命令：

```bash
npm run test        # Vitest 测试套件（400+ 用例）
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm run format      # Prettier
```

API 自带交互式文档：本地启动后访问 `/docs`（Scalar UI，OpenAPI 3.1 由 Zod schema 自动生成）。

### 浏览器扩展

```bash
cd extension
npm install
npm run build   # 产物在 build/chrome-mv3/，Chrome 开发者模式 Load unpacked 加载
```

首次使用在扩展 Options 页填入后端地址、`ADMIN_KEY`、本地 Clash controller 地址即可。详见 [`extension/README.md`](extension/README.md)。

### Claude Code 插件

在 Claude Code 里两条命令装上，即可用自然语言管理你的实例：

```
/plugin marketplace add cliouo/proxymanager
/plugin install proxymanager@proxymanager
```

安装时会弹出配置表单（实例地址、Admin Key 等，密钥存系统 Keychain 不落明文）。详见 [`plugin/README.md`](plugin/README.md)。

## 技术栈

- **Web**：Next.js 16（App Router）· React 19 · TypeScript strict · Tailwind CSS 4 · CodeMirror 6
- **存储**：Upstash Redis（Vercel Marketplace 免费档）
- **Schema**：Zod 单一事实来源，自动生成 OpenAPI 3.1
- **AI**：Agent Skills + Model Context Protocol（stdio 桥接，esbuild 单文件 bundle 零依赖安装）
- **扩展**：WXT · Chrome Manifest V3
- **测试**：Vitest

## 设计原则

- **只画真实能力**：本产品是配置组装器，不连接节点，不显示虚构的延迟/在线状态；健康检查参数是写给客户端的静态字段。
- **写操作可追溯**：保存前有未保存标记，AI 写入必过 diff 确认卡，操作历史可撤销。
- **引用完整性可见**：删除、重命名都会先告诉你影响面。

完整设计规范见 [`DESIGN.md`](DESIGN.md)。

## 致谢

- [Sub-Store](https://github.com/sub-store-org/Sub-Store) —— 本项目的灵感来源与曾经的主力工具，其订阅处理思路（节点算子、文件托管）深刻影响了 ProxyManager 的设计。
- [mihomo](https://github.com/MetaCubeX/mihomo) —— 配置语义与校验规则的事实标准。

## 免责声明

本项目仅是代理客户端的**配置管理工具**，不提供任何代理服务或节点。请在遵守当地法律法规的前提下使用。

## License

[MIT](LICENSE)
