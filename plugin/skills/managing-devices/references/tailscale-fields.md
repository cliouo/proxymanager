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
| `extra_cidrs`                | `extraCidrs`             | —    | `[]`                 | 除 `100.64.0.0/10` 外要走 Tailscale 的 IPv4/IPv6 CIDR；≤64 条、不重复；与 `service_routes` 互斥 |
| `service_routes`             | `routeMode` + `serviceRoutes` | —  | 三态                 | 精确分流：`[{ip, port}]`，ip 必须是 IPv4/IPv6 字面量、port 0–65535。**省略=保留已存路由 / null=显式切回 CIDR 模式 / 非空列表=切到服务模式**；`[]` 会被拒 |

## 语义要点

- **整份替换**：`set_device_tailscale` 每次都是完整 PUT——省略的可选字段会回到默认值，
  不是"保留原值"。两处例外：`auth_key` 与 `service_routes` 的三态（省略=保留）。
  改单项前先 `list_devices` 看现状。
- **只操作原实例**：这套工具永远指向设备上的原槽位。附加实例用
  `list_device_tailscale_instances` / `add_device_tailscale_instance` /
  `update_device_tailscale_instance` / `remove_device_tailscale_instance`。
  删除原实例不会把任何附加实例提升成原实例。
- **渲染注入**（`buildDeviceConfig` → `emitDeviceFeaturesYaml`）：往该设备的最终产物追加
  每个实例一个 `type: tailscale` 节点 + 一个单成员 `select` 组，并把它们的规则
  **splice 到 rules 最前**（防上游 IP-CIDR/DIRECT 规则遮蔽设备路由）。共享层与其它设备
  字节不动。原实例的默认节点名/组名/状态目录保持历史值不变。
- **冲突**：同 profile 内两台设备 `control_url+hostname` 相同 → 409；跨 profile 相同只在
  返回的 `warnings` 里提示（同 tailnet 的话请改 hostname）。
- **模版拒绝**：`kind=template` 的 profile 不存 Tailscale 身份，PUT 会 422。
- **审计不可撤**：含 auth key 的变更 `undoable:false`（脱敏快照无法还原 secret）。
- **附加实例**（同一设备可多挂）：各自带服务端生成的不可变 `id`、独立 hostname / auth key /
  状态目录 / 策略组。只能做精确分流（`service_routes` 必填，`extra_cidrs` 必须为空），
  默认状态目录按实例 id 生成，改 hostname 不会移动运行中的状态目录。
  同一设备上同一对「目标 IP + 端口」只能属于一个实例——冲突时 409 并点名冲突实例；
  等价的 IPv6 写法（`2001:DB8::1` vs `2001:db8:0:0:0:0:0:1`）视为同一目标。
- **规则顺序**：精确服务规则（`AND,((IP-CIDR,<ip>/32,no-resolve),(DST-PORT,<port>))`，
  IPv6 用 `/128` + `IP-CIDR6`）排在所有宽 CIDR 规则与共享规则之前，所以一台设备同时有
  CIDR 实例和服务实例时，具名服务仍然走它自己的实例。
- **服务模式互斥**：服务模式与额外 CIDR 不能同时配置；清空服务列表不会隐式恢复整个
  `100.64.0.0/10`，要回宽分流必须显式传 `service_routes: null`。
- 旧版「共享层 Tailscale 场景」已废弃为只读检测/迁移用途——不要往 base 里写 tailscale
  节点，一律走设备级 feature。
