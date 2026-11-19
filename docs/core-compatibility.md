# 代理核心连通性矩阵

2026-11-19 本地实测。每项从 URI 经产品解析、Mihomo 校验，再对真实服务端发起
SOCKS 代理 HTTP 请求，响应必须匹配随机 nonce；不是仅凭配置检查成功判定。
服务端、HTTP 目标和 Reality 伪装站均在本机；不涉及生产节点。

## 版本与复现

| 核心 / 工具  | 版本                                           |
| ------------ | ---------------------------------------------- |
| Mihomo       | Meta v1.19.34，Linux amd64                     |
| sing-box     | 1.14.4                                         |
| Xray         | 26.11.9；Reality 对照服务端另用 1.8.24、25.3.6 |
| v2ray-plugin | 5.54.2                                         |
| Snell 服务端 | 4.1.1、5.0.1                                   |

```sh
cd web
npx tsx scripts/core-compat/selftest.ts
npx tsx scripts/core-compat/run.ts                 # 所有阶段，合并列
LAB_MODE=clients npx tsx scripts/core-compat/run.ts # 原生客户端
LAB_MODE=reality npx tsx scripts/core-compat/run.ts # Mihomo Reality unset/true
CASE_FILTER='^wireguard$' npx tsx scripts/core-compat/run.ts
```

需要项目依赖、curl、OpenSSL；核心默认放在 `~/cores/`。二进制覆盖变量、可选服务端
路径见 [实验脚本说明](../web/scripts/core-compat/README.md)。脚本不下载核心；无需 root/TUN。
结果、日志、临时证书及实验密钥写入被 Git 忽略的 `web/.tmp/core-compat/<时间>-<PID>/`，
不要提交或公开整个目录。存在失败时脚本退出码为 1。

Vitest 仅发现 `web/tests/**/*.test.ts`，不会执行 `scripts/core-compat/`；普通 lint、
typecheck 及构建的静态编译不启动实验进程，不需要这些核心。只有显式执行实验入口才运行核心。

## 连通性

`✓` = nonce 请求成功；`失败` = 实际尝试后失败；`不支持` = 不强行生成不等价配置；
`—` = 未测/无服务端。合并变体行中，每个变体均得到相同结果。
Mihomo YAML 列的 Reality 开关均为 **unset**。

原生客户端列使用**实验专用** Mihomo 节点→核心配置映射，不是新增产品输出格式，
也不等于已验证 v2rayN/NekoBox/Hiddify 自身的导入代码。

| 协议 / 变体                                | Mihomo YAML | Mihomo 分享链接导入 | sing-box 客户端 | Xray 客户端 | 说明                                          |
| ------------------------------------------ | ----------- | ------------------- | --------------- | ----------- | --------------------------------------------- |
| SS AEAD / 2022                             | ✓           | ✓                   | ✓               | ✓           |                                               |
| SS obfs HTTP / TLS                         | ✓           | ✓                   | ✓               | 不支持      | Xray 无对应原生插件                           |
| SS v2ray-plugin WS / WS+TLS                | ✓           | 失败                | ✓               | 不支持      | Mihomo 导入丢失 mux=false                     |
| SS shadow-tls v3                           | ✓           | 失败                | ✓               | 不支持      | Mihomo 导入忽略插件                           |
| SSR                                        | —           | —                   | 不支持          | 不支持      | 无 SSR 服务端；Mihomo 导入和选中节点通过      |
| VMess TCP / WS                             | ✓           | ✓                   | ✓               | ✓           |                                               |
| VMess WS+TLS                               | ✓           | ✓                   | ✓               | 不支持      | Xray TLS 策略限制，下同                       |
| VMess gRPC                                 | ✓           | ✓                   | ✓               | ✓           |                                               |
| VMess H2                                   | ✓           | ✓                   | ✓               | 不支持      | 新 Xray 已移除旧 H2 传输                      |
| VMess HTTPUpgrade                          | ✓           | ✓                   | ✓               | 失败        | Xray 与 sing-box 握手差异                     |
| VMess mKCP                                 | ✓           | 失败                | 不支持          | ✓           | Mihomo 导入缺 seed/options                    |
| VLESS TCP+TLS                              | ✓           | ✓                   | ✓               | 不支持      | TLS 策略                                      |
| VLESS WS / gRPC                            | ✓           | ✓                   | ✓               | ✓           |                                               |
| VLESS HTTPUpgrade                          | ✓           | ✓                   | ✓               | 失败        | 同上握手差异                                  |
| VLESS H2                                   | ✓           | ✓                   | ✓               | 不支持      | 旧 H2 已移除                                  |
| VLESS Reality Vision / gRPC → Xray 26.11.9 | 失败        | 失败                | 失败            | ✓           | 版本敏感的 Reality 握手                       |
| VLESS Reality Vision / gRPC → sing-box     | ✓           | ✓                   | ✓               | ✓           |                                               |
| VLESS XHTTP TLS                            | ✓           | ✓                   | 不支持          | 不支持      | sing-box 无 XHTTP；Xray TLS 策略              |
| VLESS XHTTP Reality → Xray 26.11.9         | 失败        | 失败                | 不支持          | ✓           |                                               |
| VLESS 加密 x25519 / ML-KEM                 | ✓           | ✓                   | 不支持          | ✓           | sing-box 无该加密字段                         |
| Trojan TLS / WS / gRPC                     | ✓           | ✓                   | ✓               | 不支持      | TLS 策略                                      |
| Hysteria v1                                | ✓           | ✓                   | ✓               | 不支持      | Xray 仅实现 v2                                |
| Hysteria2 原生 / salamander                | ✓           | ✓                   | ✓               | 不支持      | TLS 策略                                      |
| Hysteria2 跳端口（1 秒）                   | ✓           | ✓                   | 不支持          | 不支持      | 原生客户端最小 5 秒；不静默放大间隔           |
| TUIC v5                                    | ✓           | ✓                   | ✓               | 不支持      | Xray 无 TUIC                                  |
| AnyTLS                                     | ✓           | ✓                   | ✓               | 不支持      | Xray 无 AnyTLS                                |
| Snell v4 / v5                              | ✓           | 失败                | 不支持          | 不支持      | Mihomo 分享链接转换器不支持 Snell             |
| WireGuard                                  | ✓           | 失败                | ✓               | ✓           | 产品导出与回解析一致；Mihomo 转换器拒绝该 URI |
| SOCKS5 / HTTP 认证                         | ✓           | ✓                   | ✓               | ✓           |                                               |
| HTTPS 认证                                 | ✓           | ✓                   | ✓               | 不支持      | TLS 策略                                      |
| Reality Vision / gRPC → Xray 1.8.24        | ✓           | —                   | ✓               | 失败        | 新 Xray 客户端与旧服务端不兼容                |
| Reality Vision / gRPC → Xray 25.3.6        | ✓           | —                   | ✓               | 失败        | 同上                                          |

分享链接阶段先 `proxiesToShareUris` → 产品回解析逐字段比较，再将
`buildBase64Subscription` 的正文直接交给 Mihomo file proxy-provider。
控制器必须确认恰好选中一个导入节点，禁止空 provider 回退 DIRECT 造成假阳性。
全部 47 个 fixture 的导出可回解析且无字段差异；旧服务端对照未重跑分享链接连通性。

WireGuard 修复使用已有解析器的平面方言：
`wireguard://<编码后的私钥>@host:port?publickey=…&address=…#名称`。
支持双栈地址、预共享密钥、reserved、MTU、UDP、keepalive、workers、刷新间隔；
不伪造 peers/allowed-ips/DNS 等无法表达的字段。Mihomo 导入失败不再归因为产品漏导出。
这不构成每个 GUI 都支持全部可选参数的保证。

## Reality 默认值不能统一改为 true

以下均为 Mihomo v1.19.34 客户端；Vision 和 gRPC 分别实测，结果相同。

| Reality 服务端  | 传输                  | unset | true |
| --------------- | --------------------- | ----- | ---- |
| Xray 1.8.24     | Vision / gRPC         | ✓     | 失败 |
| Xray 25.3.6     | Vision / gRPC         | ✓     | 失败 |
| Xray 26.11.9    | Vision / gRPC / XHTTP | 失败  | ✓    |
| sing-box 1.14.4 | Vision / gRPC         | ✓     | ✓    |

同一个运行中的旧服务端，unset 成功而 true 报 `REALITY authentication failed`。
因此 **true 会破坏已测旧服务端**，不能作为全局默认值。产品 YAML 校验器已接受并保留
`reality-opts.support-x25519mlkem768` 布尔值，本次仅加回归测试，不注入默认值。

已检查的 [Xray 分享链接约定](https://github.com/XTLS/Xray-core/discussions/716) 与
[v2rayN URI 映射](https://github.com/2dust/v2rayN/blob/master/v2rayN/ServiceLib/Handler/Fmt/BaseFmt.cs)
未提供该布尔值的显式能力信号。`fp` 是指纹，`pqv` 是 ML-DSA-65 验证材料，
VLESS `encryption=…` 不是 Reality 混合密钥交换开关；不能据此推断服务端代际。

## 字段差异与失败归因

- **Xray TLS 策略**：26.11.9 实际配置检查拒绝 `allowInsecure`，要求使用
  `pinnedPeerCertSha256` / `verifyPeerCertByName`。表中不支持的是 fixture 的
  `skip-cert-verify=true`，不是协议本身。节点没有证书 pin/额外信任策略，实验不从服务端
  偷填材料或用信任实验 CA 替换“不校验证书”。这不是解析器漏字段。
- **HTTPUpgrade**：Xray 26.11 发送 `Sec-WebSocket-Key`，sing-box 服务端明确拒绝该字段，
  实际日志为 `real websocket request received`。双方配置检查通过不代表 wire-compatible。
- **Mihomo URI 导入器**：v2ray-plugin 未保留 mux=false；shadow-tls 被忽略；VMess mKCP
  缺少 seed/options；Snell、WireGuard URI 被拒绝。对应直接 YAML 均成功，产品导出回解析无损。
- **Reality**：sing-box 客户端会移除混合 key share，Vision 对新 Xray 验证失败；gRPC 到达
  Reality fallback 后超时，内部具体错误暴露较少。当前 Xray 客户端对旧服务端也失败。
  归为版本互操作限制，不据此修改产品认证字段。
- **映射**：sing-box SS 插件选项变为 SIP003 字符串，shadow-tls 变为独立 outbound+detour；
  gRPC 服务名映射为 `service_name` / `serviceName`；WS early-data 映射为
  `max_early_data`、header 或 Xray 路径 `?ed=`；Reality 公钥/short ID 更换字段命名；
  Hysteria2 obfs/password 变为对象，跳端口变为数组和冒号范围（单端口也需 `n:n`），
  hop interval 变为 duration；TUIC 拥塞/relay 模式变为下划线字段；WireGuard 平面节点
  变为 userspace endpoint/peer。
- **边界**：WS early-data、显式 TUIC 选项及合法跳端口范围有映射断言，不等于新增网络实测；
  不承诺通用 UDP、WAN 性能或每个原生客户端实际发生端口切换。TLS 子进程信任实验 CA，
  成功请求也不能单独证明每种 insecure 拼写被核心采用。

矩阵来自分阶段运行，旧 YAML/分享链接结果与新原生客户端、旧版 Reality 对照合并，
不是一次同时运行；实验目录的 JSON 保留来源。未发现上述 fixture 的产品字段丢失，
但不能外推为所有核心版本、客户端导入器或任意 YAML 字段都支持。
