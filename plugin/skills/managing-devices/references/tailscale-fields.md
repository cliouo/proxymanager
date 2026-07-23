# 设备级 Tailscale 全字段表

> 本文件由 plugin/skills 渐进披露 Level 3 加载：仅当上层 SKILL.md 指向本文件时才读取。
> 事实镜像 `web/schemas/device.ts` 的 `TailscaleDeviceFeatureSchema`（对应 Mihomo v1.19.28
> `TailscaleOption` 出站）。工具入参为 snake_case，服务端存储为 camelCase。

## 字段表（`set_device_tailscale` 入参）

| 入参                         | 存储字段                 | 必填 | 默认                 | 约束 / 说明                                                                              |
| ---------------------------- | ------------------------ | ---- | -------------------- | ---------------------------------------------------------------------------------------- |
| `device_id`                  | —                        | ✅   | —                    | 设备 id，先 `list_devices` 拿                                                            |
| `hostname`                   | `hostname`               | ✅   | —                    | ≤63 字符，字母/数字/中划线（首尾须字母数字）；同 profile 内 `control_url+hostname` 唯一  |
| `auth_key`                   | `authKey`                | —    | 三态                 | `tskey-…`，≤256 无空白。**省略=保留已存 / null=清除 / 传值=替换**；读取只回 `hasAuthKey` |
| `control_url`                | `controlUrl`             | —    | 官方控制面           | http/https URL ≤512；不能带账号、密码、查询参数或片段（自建 headscale 用）               |
| `state_dir`                  | `stateDir`               | —    | —                    | ≤256，无控制字符                                                                         |
| `ephemeral`                  | `ephemeral`              | —    | `false`              | 临时节点，下线即从 tailnet 移除                                                          |
| `accept_routes`              | `acceptRoutes`           | —    | `true`               | 接受 tailnet 通告的子网路由                                                              |
| `udp`                        | `udp`                    | —    | `true`               |                                                                                          |
| `exit_node`                  | `exitNode`               | —    | —                    | 以某 tailnet 节点作出口，≤128                                                            |
| `exit_node_allow_lan_access` | `exitNodeAllowLanAccess` | —    | `false`              | 走 exit node 时仍允许访问本地局域网                                                      |
| `node_name`                  | `nodeName`               | —    | 自动生成             | 注入的 tailscale 出站节点名；≤128，不能含逗号/控制字符；与共享层节点撞名会拒渲染         |
| `group_name`                 | `groupName`              | —    | 自动生成             | 注入的单成员 `select` 组名；同上约束                                                     |
| `extra_cidrs`                | `extraCidrs`             | —    | `[]`                 | 除 `100.64.0.0/10` 外要走 Tailscale 的 IPv4/IPv6 CIDR；≤64 条、不重复                    |

## 语义要点

- **整份替换**：`set_device_tailscale` 每次都是完整 PUT——省略的可选字段会回到默认值，
  不是"保留原值"。唯一例外是 `auth_key` 的三态。改单项前先 `list_devices` 看现状。
- **渲染注入**（`buildDeviceConfig` → `emitDeviceFeaturesYaml`）：往该设备的最终产物追加
  `type: tailscale` 节点 + 单成员 `select` 组，并把 tailnet CIDR 的 `IP-CIDR`/`IP-CIDR6`
  规则 **splice 到 rules 最前**（防上游 IP-CIDR/DIRECT 规则遮蔽设备路由）。共享层字节不动。
- **冲突**：同 profile 内两台设备 `control_url+hostname` 相同 → 409；跨 profile 相同只在
  返回的 `warnings` 里提示（同 tailnet 的话请改 hostname）。
- **模版拒绝**：`kind=template` 的 profile 不存 Tailscale 身份，PUT 会 422。
- **审计不可撤**：含 auth key 的变更 `undoable:false`（脱敏快照无法还原 secret）。
- 旧版「共享层 Tailscale 场景」已废弃为只读检测/迁移用途——不要往 base 里写 tailscale
  节点，一律走设备级 feature。
