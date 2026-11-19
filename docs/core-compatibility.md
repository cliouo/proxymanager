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
PSK 统一导出为 `presharedkey`（v2rayNG、Hiddify、Karing 可读）；导入同时接受
`psk` 和原有的 `pre-shared-key` / `pre_shared_key`，不改变内部 YAML 字段名。

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

## macOS 桌面客户端

2026-11-19，macOS 26.6.2 / Apple Silicon。用应用自身的订阅导入功能测 [Android 同款 46 个变体](#android-客户端)，另测 SSR。Base64 由 ProxyManager 的实际序列化器生成，YAML 由同一批解析和校验后的节点组成最小完整配置；未跑生产订阅路由。

| 客户端 · 官方版本 | 订阅 | 导入 | 已加载 | nonce 连通 |
| --- | --- | ---: | ---: | ---: |
| Hiddify 5.5.5 / 内嵌 Hiddify core | 完整 Base64（Snell v5 不支持） | 0/46 | 0 | 0 |
| Hiddify 5.5.5 / 内嵌 Hiddify core | 完整 YAML（Clash 转换器不支持 Snell 类型） | 0/46 | 0 | 0 |
| Clash Verge Rev 2.5.10 / Mihomo 1.19.33 | 完整 YAML | 46/46 | 46 | 41 |
| Hiddify 5.5.5 / 内嵌 Hiddify core | 去 Snell 的 Base64（诊断） | 40/44 | 39 | 33 |
| v2rayN 7.25.6 / 内置 Xray 26.10.10、sing-box 1.14.3 | 完整 Base64 | 41/46 | 41 | 20 |

下表每格的 **通过** 同时表示导入、加载和连通。**阻断** 表示有实验前提未满足，而非断言协议不支持。Hiddify 列为去 Snell Base64；Snell 两行是各自单独订阅，不计入该行合计。

| 节点 | Clash Verge Rev | Hiddify | v2rayN |
| --- | --- | --- | --- |
| `ss-aes-128-gcm` | 通过 | 通过 | 通过 |
| `ss-2022-blake3-aes-128-gcm` | 通过 | 通过 | 通过 |
| `ss-obfs-http` | 通过 | 通过 | 已加载、失败：Xray 生成 raw + HTTP header，未实现 SIP003 simple-obfs 握手 |
| `ss-obfs-tls` | 通过 | 通过 | 已加载、失败：Xray 生成纯 raw 出站，未保留 TLS obfs 插件 |
| `ss-v2ray-plugin-ws` | 通过 | 通过 | 通过 |
| `ss-v2ray-plugin-ws-tls` | 已加载、阻断：WSS 校验不信任本地 CA | 已加载、阻断：WSS 校验不信任本地 CA | 已加载、阻断：有 WS + TLS 出站，服务端记录客户端拒绝本地证书 |
| `ss-shadow-tls-v3` | 已加载、阻断：伪装 TLS 校验不信任本地 CA | 未加载、失败：出站报 `plugin not found: shadow-tls`，使用 hinvalid 占位 | 已加载、失败：Xray 生成纯 raw 出站，未保留 ShadowTLS 插件 |
| `vmess-tcp` | 通过 | 通过 | 通过 |
| `vmess-ws` | 通过 | 通过 | 通过 |
| `vmess-ws-tls` | 通过 | 通过 | 已加载、阻断：导入时保留 AllowInsecure，但 Xray 配置未带该值，拒绝本地证书 |
| `vmess-grpc` | 通过 | 通过 | 通过 |
| `vmess-h2` | 通过 | 未导入：VMess 的 `h2` 传输未转换入库；VLESS H2 行是另一个映射 | 已加载、失败：导入后 v2rayN 把传输记为 raw，生成的 Xray 出站不是 H2，且未保留 TLS insecure |
| `vmess-httpupgrade` | 通过 | 通过 | 已加载、失败：sing-box 服务端拒绝 Xray 握手：real websocket request received |
| `vmess-mkcp` | 通过 | 未导入：VMess 的 `kcp` 传输未转换入库 | 通过 |
| `vless-tcp-tls` | 通过 | 通过 | 已加载、阻断：Xray 出站未带证书信任或 insecure；服务端记录 bad certificate |
| `vless-ws` | 通过 | 通过 | 通过 |
| `vless-grpc` | 通过 | 通过 | 通过 |
| `vless-httpupgrade` | 通过 | 通过 | 已加载、失败：sing-box 服务端拒绝 Xray 握手：real websocket request received |
| `vless-h2` | 通过 | 通过 | 已加载、失败：v2rayN 生成的 Xray 出站是 raw 而不是 H2，且未保留 TLS insecure |
| `vless-reality-vision-xray26` | 已加载、失败：Xray 26 的 Reality 拒绝认证，落入伪装 TLS；不改 ML-KEM 默认 | 通过 | 通过 |
| `vless-reality-vision-sing-box` | 通过 | 通过 | 通过 |
| `vless-reality-grpc-xray26` | 已加载、失败：Reality 对 Xray 26 进入伪装 TLS，客户端报未知证书颁发者 | 通过 | 通过 |
| `vless-reality-grpc-sing-box` | 通过 | 通过 | 通过 |
| `vless-xhttp-tls` | 通过 | 已加载、失败：Xray 服务端协商 HTTP/2 后收到 HTTP/1.1 请求，报 error reading preface / bogus greeting | 已加载、阻断：Xray 出站未带证书信任或 insecure；服务端记录 bad certificate |
| `vless-xhttp-reality-xray26` | 已加载、失败：Reality 对 Xray 26 进入伪装 TLS，客户端报未知证书颁发者 | 通过 | 通过 |
| `vless-encryption-x25519` | 通过 | 通过 | 通过 |
| `vless-encryption-mlkem` | 通过 | 通过 | 通过 |
| `trojan-tls` | 通过 | 通过 | 已加载、阻断：Xray 出站未带证书信任或 insecure；服务端记录 bad certificate |
| `trojan-ws` | 通过 | 通过 | 已加载、阻断：Xray 的 WS 出站拒绝本地证书：x509: certificate signed by unknown authority |
| `trojan-grpc` | 通过 | 通过 | 已加载、阻断：Xray 的 gRPC 出站写 preface 时拒绝本地证书：x509: certificate signed by unknown authority |
| `hysteria-v1` | 通过 | 未导入：链接编解码器认得该 scheme，但客户端过滤掉此 v1 出站；未隔离过滤条件 | 未导入：分享导入器只有 Hysteria2 分支 |
| `hysteria2-plain` | 通过 | 通过 | 已加载、阻断：Xray 的 QUIC/TLS 出站拒绝本地证书：x509: certificate signed by unknown authority |
| `hysteria2-salamander` | 通过 | 通过 | 已加载、阻断：Xray 已生成 Salamander UDP mask；客户端调试日志为 x509: certificate signed by unknown authority |
| `hysteria2-port-hopping` | 通过 | 通过 | 已加载、阻断：Xray 的 QUIC/TLS 出站拒绝本地证书：x509: certificate signed by unknown authority |
| `tuic-v5` | 通过 | 通过 | 通过 |
| `anytls` | 通过 | 通过 | 通过 |
| `snell-v4` | 通过 | 通过 | 未导入：分享导入器未登记 Snell |
| `snell-v5` | 通过 | 未导入：单节点 Base64 同样被拒：snell: unsupported version: 5 | 未导入：分享导入器未登记 Snell |
| `wireguard` | 通过 | 通过 | 通过 |
| `socks5-auth` | 通过 | 未导入：转换器只登记 `socks://`，省略 `socks5://` | 通过 |
| `http-auth` | 通过 | 通过 | 未导入：分享导入器未登记 HTTP |
| `https-auth` | 通过 | 通过 | 未导入：分享导入器未登记 HTTPS |
| `vless-reality-vision-xray18` | 通过 | 已加载、失败：旧 Xray Reality 认证未成功，退回伪装 TLS | 已加载、失败：Xray 1.8.24 服务端记录 Reality processed invalid connection |
| `vless-reality-vision-xray25` | 通过 | 已加载、失败：旧 Xray Reality 认证未成功，退回伪装 TLS | 已加载、失败：Xray 25.3.6 服务端记录 Reality processed invalid connection |
| `vless-reality-grpc-xray18` | 通过 | 已加载、失败：连旧 Xray 的 Reality gRPC 超时；同服务端用 Mihomo 可通过 | 已加载、失败：Xray 1.8.24 服务端收到连接，但 Reality handshakeStatus=false |
| `vless-reality-grpc-xray25` | 通过 | 已加载、失败：连旧 Xray 的 Reality gRPC 超时；同服务端用 Mihomo 可通过 | 已加载、失败：Xray 25.3.6 服务端收到连接，但 Reality handshakeStatus=false |
| `ssr（补测）` | 通过 | 未导入：单节点 Base64 报无法识别配置格式，YAML 报不支持 ssr 类型 | 未导入：分享导入器未登记 SSR；单节点订阅下载后报 Failed to import subscription content |

### macOS 诊断与导出结论

- **Hiddify 的 SOCKS5**：原 `socks5://` 被忽略，只改为 `socks://` 后，Hiddify 和 v2rayN 均保留凭据并返回正确 nonce。Hiddify 的[分享转换表](https://github.com/hiddify/ray2sing/blob/ed1a4b1/ray2sing/convert.go#L19-L46)仅登记后者；[v2rayA 的解析器](https://github.com/v2rayA/v2rayA/blob/v2.2.7/service/core/serverObj/socks.go#L11-L16)仅登记前者，因此不改通用 Base64。单独导入 Snell v4 可连，v5 仍拒绝；不能用单节点通过代替整份订阅。
- **v2rayN 的 HTTP(S)**：[分享 URI 导入器](https://github.com/2dust/v2rayN/blob/7.25.6/v2rayN/ServiceLib/Handler/Fmt/FmtHandler.cs#L35-L102)没有 HTTP(S) 分支；[手动添加 HTTP](https://github.com/2dust/v2rayN/blob/7.25.6/v2rayN/v2rayN.Desktop/Views/MainWindow.axaml#L59)是另一入口。Naive 不是同一协议，不转换或改写分享链接。
- **TLS 阻断**：Clash Verge Rev 的 SS v2ray-plugin WS+TLS 和 ShadowTLS v3 在节点级加入实验用 SHA-256 证书指纹后均通过，未修改系统信任；这两项不混入基准。v2rayN 的内置 Xray 不使用 `allowInsecure`，十项止于本地证书校验，不能判作协议不支持。
- **Reality**：Clash Verge Rev 对较新 Xray 的三个变体失败、对旧版通过；v2rayN 恰好相反。保留 `support-x25519mlkem768` 的原有默认行为。

### macOS 验证边界

导入以应用实际节点清单为准；加载要求选中真实出站（占位符不计），v2rayN 另核对生成配置和监听的核心进程。连通要求经应用自身的 SOCKS 端口取得该节点唯一的 HTTP nonce，直连目标和不可用代理的负对照均无 nonce。v2rayN 使用应用保存的实验路由，避免默认 `geoip:private` 将合成目标绕过代理。系统代理与 TUN 关闭；Snell 服务跑在本地 Linux 来宾中。未测 WAN、通用 UDP、实际跳端口频次或有预共享密钥的 WireGuard 节点。

## Android 客户端

2026-11-19，Android 15 / API 35 Google APIs x86_64 模拟器；Karing 为 ARM64 转译。
客户端通过自身订阅功能读取产品实际输出，未用转换器代替导入。实验 CA 已加入系统信任库。
每个 PASS 均通过真实 VPN 发起 UID 2000 的 HTTP nonce 请求，并核对响应、宿主目标日志和
选中节点证据；不是延迟测试成功或仅启动成功。SSR 无可用服务端，不在这 46 个节点中。

| 客户端 | 应用版本 / 核心 | YAML 导入 | Base64 导入 | 实测结果 |
| --- | --- | --- | --- | --- |
| Clash Meta (CMFA) | 2.11.37.Meta / alpha-0455d0d-cmfa-2.11.37.meta | 46 | 未测 | 46 PASS |
| v2rayNG | 2.3.15 / Xray 26.10.31 | 未测 | 39 | 17 PASS、22 FAIL、7 未导入 |
| NekoBox | 1.4.2 / sing-box 1.12.19-neko-1 | 43 | 43 | Base64 的 43 个全部实测：34 PASS、9 FAIL；3 未导入 |
| Hiddify | 5.5.5 / sing-box 1.15.0-alpha.13¹ | 0 | 0 | 完整订阅均拒绝保存 |
| SFA | 1.14.4 | 0 | 0 | 远程配置要求 sing-box JSON；两种格式均解码失败 |
| Karing | 1.2.26.2934 / 声明核心 1.14.0² | 45 | 41 | 导入可用，VPN 启动 SIGILL，未逐节点测连通性 |

¹ 核心版本来自单独的 PSK 配置运行；没有用删减订阅替代完整订阅测试。
² Karing 未取得实际运行核心版本。两种导入的并集覆盖 46 个节点，不代表连通性通过。

下表 `未入` = 导入器省略；`拒绝` = 整份配置被拒，**不是逐协议失败**；
`阻断` = Karing 原生 VPN 启动崩溃，**不是该节点失败**；`阻断†` = 仅 Base64 导入。
CMFA 使用 YAML；v2rayNG、NekoBox 使用 Base64；Karing 优先使用导入更多的 YAML。

| 节点 | CMFA | v2rayNG | NekoBox | Hiddify | SFA | Karing |
| --- | --- | --- | --- | --- | --- | --- |
| ss-aes-128-gcm | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| ss-2022-blake3-aes-128-gcm | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| ss-obfs-http | PASS | FAIL VP | PASS | 拒绝 | 拒绝 | 阻断 |
| ss-obfs-tls | PASS | FAIL VP | PASS | 拒绝 | 拒绝 | 阻断 |
| ss-v2ray-plugin-ws | PASS | FAIL VP | PASS | 拒绝 | 拒绝 | 阻断 |
| ss-v2ray-plugin-ws-tls | PASS | FAIL VP | PASS | 拒绝 | 拒绝 | 阻断 |
| ss-shadow-tls-v3 | PASS | FAIL VP | FAIL NP | 拒绝 | 拒绝 | 阻断 |
| vmess-tcp | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vmess-ws | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vmess-ws-tls | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| vmess-grpc | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vmess-h2 | PASS | FAIL VH | PASS | 拒绝 | 拒绝 | 阻断 |
| vmess-httpupgrade | PASS | FAIL VU | PASS | 拒绝 | 拒绝 | 阻断 |
| vmess-mkcp | PASS | PASS | FAIL NT | 拒绝 | 拒绝 | 阻断 |
| vless-tcp-tls | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-ws | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-grpc | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-httpupgrade | PASS | FAIL VU | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-h2 | PASS | FAIL VH | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-reality-vision-xray26 | PASS | PASS | FAIL NR | 拒绝 | 拒绝 | 阻断 |
| vless-reality-vision-sing-box | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-reality-grpc-xray26 | PASS | PASS | FAIL NR | 拒绝 | 拒绝 | 阻断 |
| vless-reality-grpc-sing-box | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-xhttp-tls | PASS | FAIL VL | FAIL NT | 拒绝 | 拒绝 | 阻断 |
| vless-xhttp-reality-xray26 | PASS | PASS | FAIL NT | 拒绝 | 拒绝 | 阻断 |
| vless-encryption-x25519 | PASS | PASS | FAIL NE | 拒绝 | 拒绝 | 阻断 |
| vless-encryption-mlkem | PASS | PASS | FAIL NE | 拒绝 | 拒绝 | 阻断 |
| trojan-tls | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| trojan-ws | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| trojan-grpc | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| hysteria-v1 | PASS | 未入 | PASS | 拒绝 | 拒绝 | 阻断 |
| hysteria2-plain | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| hysteria2-salamander | PASS | FAIL VL | PASS | 拒绝 | 拒绝 | 阻断 |
| hysteria2-port-hopping | PASS | FAIL VL | FAIL NH | 拒绝 | 拒绝 | 阻断† |
| tuic-v5 | PASS | 未入 | PASS | 拒绝 | 拒绝 | 阻断 |
| anytls | PASS | 未入 | PASS | 拒绝 | 拒绝 | 阻断 |
| snell-v4 | PASS | 未入 | 未入 | 拒绝 | 拒绝 | 阻断 |
| snell-v5 | PASS | 未入 | 未入 | 拒绝 | 拒绝 | 阻断 |
| wireguard | PASS | PASS | 未入 | 拒绝 | 拒绝 | 阻断 |
| socks5-auth | PASS | PASS | PASS | 拒绝 | 拒绝 | 阻断 |
| http-auth | PASS | 未入 | PASS | 拒绝 | 拒绝 | 阻断 |
| https-auth | PASS | 未入 | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-reality-vision-xray18 | PASS | FAIL VR | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-reality-vision-xray25 | PASS | FAIL VR | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-reality-grpc-xray18 | PASS | FAIL VR | PASS | 拒绝 | 拒绝 | 阻断 |
| vless-reality-grpc-xray25 | PASS | FAIL VR | PASS | 拒绝 | 拒绝 | 阻断 |

失败原因（均为已测版本和实验条件，不外推所有版本）：

- **VP**：v2rayNG 导入器忽略部分 SIP003 插件；obfs HTTP 的 Xray 近似映射不兼容，TLS 无对应映射。
- **VL**：v2rayNG 保留 insecure 字段，但 Xray 构建配置时拒绝已移除的 `allowInsecure`；不是 CA 缺失。
- **VH**：Xray 拒绝已移除的旧 HTTP/H2 传输，导入的路径等字段仍存在。
- **VU**：请求到达 sing-box 服务端，日志 `real websocket request received`，对应 HTTPUpgrade 握手差异。
- **VR**：当前 Xray 到旧 Xray Reality 认证失败；同客户端的新 Xray / sing-box 对照成功。
- **NP**：NekoBox 启动报 `plugin not found: shadow-tls`，此 SIP003 路径没有转换为独立 ShadowTLS outbound。
- **NT**：NekoBox 保存传输名称但原生构建器无 mKCP / XHTTP 分支；XHTTP 服务端还记录了错误 preface。
- **NE**：NekoBox 未读取 VLESS 的 `encryption` 查询，服务端记录加密握手失败。
- **NR**：NekoBox 到当前 Xray Reality 失败，旧 Xray 和 sing-box 对照通过，属版本互操作限制。
- **NH**：NekoBox 保留全部 16 个 singleton 端口，但范围转换函数全部丢弃；不是据此断言最小间隔限制。
- **未入**：v2rayNG 无对应 Hysteria v1 / TUIC / AnyTLS / Snell / HTTP(S) URI 分派；NekoBox 省略 Snell 和 WireGuard。
- **Hiddify**：YAML 报 `不支持的类型 snell`；Base64 报 `snell: unsupported version: 5`，均未保存配置。
- **SFA**：YAML / Base64 分别报 `invalid character 'a'` / `'c' looking for beginning of value: row 1, column 1`；未保存配置，未写转换器。
- **Karing**：YAML 缺跳端口节点（具体原因未隔离）；Base64 缺 shadow-tls（String→int 转换错误）、Snell v4/v5、HTTP(S)（不支持的 scheme）。
- **Karing VPN**：同意 VPN 后 `libbox.so` 加载，再报 `Fatal signal 4 (SIGILL)`；栈含转译库、Sentry 和 libbox，未进一步隔离原生根因。

普通 WireGuard 行原本无 PSK，不能覆盖 PSK 兼容性。单独的 PSK 必需端点已证明：旧导出
`pre-shared-key` 被 v2rayNG 丢弃而失败；仅改为 `presharedkey` 即可通过 VPN nonce 和目标日志。
本次修复让产品直接输出后一拼写，并用新导出链接重新验证。Hiddify 可保留旧、新 PSK 拼写，
但单独 VPN 测试被其 Warp 补丁替换 `10.0.2.2` 私网端点所阻；Karing 的六种别名导入实验仅保留
`presharedkey` / `preSharedKey`，没有因其启动崩溃而声称网络通过。

实验原始 JSON、截图及日志保存在本地被忽略的 `web/.tmp/android-core/clients/`；不提交密钥、
凭据或完整运行配置。此表为前两轮真实客户端报告的合并，不表示本次重跑六个客户端。
v2rayNG 使用 Global 并禁用实验目标被 `geoip:private` 直连的规则；NekoBox 关闭 FakeDNS，
两项 LAN bypass 均为 false。选节点采用 UI / 客户端自身控制器或原生选择入口，未改导入字段。
通用 UDP、WAN 性能和真实跳端口多样性仍未验证。

## Windows 桌面客户端

2026-11-19，Windows Server 2022 实机。客户端通过自身订阅功能导入本地产品实例的实际输出
（默认 Clash YAML 或 `?format=base64`），实验服务端由 `web/scripts/core-compat/serve.ts`
启动（40 个节点，Snell 经 WSL）。实验 CA 已加入 Windows 根证书库。Mihomo 系客户端逐个
选节点并经客户端 mixed 端口取 nonce；其余客户端使用自身控制器或延迟/URL 测试，见下表“方法”。

| 客户端 | 版本 / 核心 | 格式 | 导入 | 结果 | 方法 |
| --- | --- | --- | --- | --- | --- |
| Clash Verge Rev | 2.5.10 / Mihomo 1.19.33 | YAML | 40 | 39 PASS | GUI 内核控制器选点 + nonce |
| Clash Party | 2.0.4 / Mihomo 1.19.32 | YAML | 40 | 39 PASS | 客户端生成的运行配置 + 自带内核 |
| Sparkle | 1.26.10 / Mihomo 1.19.33 | YAML | 40 | 39 PASS | 同上 |
| FlClash | 0.9.4 | YAML | 40 | 39 PASS | 客户端生成的运行配置 + Mihomo 1.19.34 |
| v2rayN | 7.25.6 / Xray 26.10.10 | Base64 | 35 | 15 PASS | 自带真连接延迟测试 |
| Hiddify | 5.5.5 / sing-box 1.15.0-alpha.13 | 两种 | 0 | 整份拒绝；删去 Snell 后 28/38 | clash API 选点 + nonce |
| Karing | 1.2.26.2934 / sing-box 1.14.4 | YAML | 40 | 29 PASS | clash API 逐节点延迟（外网 URL） |
| Throne | 1.4.2 / sing-box 1.15.0-alpha.13 + Xray 26.11.9 | Base64 | 37 | 33 PASS | 自带 URL 测试 |

四个 Mihomo 客户端唯一失败均为 `vless-xhttp-reality`（Xray 26 服务端，需
`support-x25519mlkem768`，见上文 Reality 一节，不改默认值）。

失败原因（已测版本，不外推）：

- **v2rayN**：未导入 Hysteria v1、Snell v4/v5、`http://`、`https://` 链接；所有自签 TLS 节点
  报 `x509: certificate signed by unknown authority`——Xray 26 已移除 `allowInsecure`（写入即启动失败），
  v2rayN 静默丢弃该字段；同一节点改用 `pinnedPeerCertSha256` 即通过，属客户端/内核限制。
  h2 被映射为 raw+TLS（Xray 26 移除 H2 传输）；HTTPUpgrade 到 sing-box 服务端报
  `real websocket request received`；Reality 到 Xray 25.3.6 报 `received real certificate`，
  到 Xray 26 的 xhttp-reality 通过；ss obfs / shadow-tls 跳过测试（Xray 无对应插件）。
- **Hiddify**：与 Android 相同，YAML 报 `不支持的类型 snell`、Base64 报
  `snell: unsupported version: 5`，整份订阅不保存。删去 Snell 的副本（非产品输出）中失败：
  v2ray-plugin、mKCP（按 TCP 拨号）、XHTTP、VLESS encryption、到 Xray 25.3.6 的 Reality
  （`reality verification failed`）；WireGuard 因实验目标需经隧道 DNS，结论不确定。
- **Karing**：Windows 版可正常启动（Android 为 SIGILL）。其 YAML 转换把 `network: h2` 写成
  sing-box `httpupgrade`，并忽略 `ws-opts.v2ray-http-upgrade: true` 写成 `ws`（404），均为客户端
  转换问题；另有 v2ray-plugin / shadow-tls EOF、mKCP 按 TCP 拨号、Snell v5 不支持、
  xhttp-reality 到 Xray 26 失败。
- **Throne**：未导入 shadow-tls（插件未知）、mKCP、Snell v5（仅支持 4 和 6）；失败为
  vless-xhttp-tls、到 Xray 25.3.6 的 Reality、WireGuard（Windows 上 `wsasendmsg` 回环地址无效，
  属实验环境）。

结论：Windows 未发现产品丢字段或输出错误；失败均为客户端导入器或内核版本限制。
主要用户可见风险：含 Snell（尤其 v5）的订阅会让 Hiddify 整份拒绝；v2rayN / Xray 26 系客户端
无法连接依赖 `skip-cert-verify` 的自签证书节点。
