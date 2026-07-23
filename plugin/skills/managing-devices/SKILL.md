---
name: managing-devices
description: >-
  Manages the per-device layer (设备) in ProxyManager — devices under a
  profile that reuse the shared render plus an RFC 7386 base_patch over
  top-level keys (ports / secret / external-ui / find-process-mode), the
  per-device subscription URL, and the typed device-scoped Tailscale feature
  (hostname / auth key / exit node / extra CIDRs). Use when the user creates,
  edits, previews, or deletes a device, wants per-device differences (不同端口
  / 不同 secret / 这台设备单独…), mentions 设备 / 设备差量 / 补丁 / 设备订阅链接
  / Tailscale, or asks why a template profile (模版) cannot distribute or hold
  a Tailscale identity. Always test-renders a candidate patch with
  preview_device_config before writing; never reveals Tailscale auth keys
  (hasAuthKey only). Deep-dive spoke of the managing-clash-config hub.
---

# 设备差量 (spoke)

**安全地板**（完整横切护栏在 `managing-clash-config` hub）：补丁里的 secret / password 等敏感值
已脱敏为 `***`，Tailscale auth key 永不回显（只有 `hasAuthKey` 布尔）——不获取、不猜测、
**绝不把 `***` 当真值写回**；写不立即生效，服务端出确认卡、用户授权才执行，发起后别声称已改好；
先 `search_mihomo_docs` 再答 mihomo 写法。这些 load-bearing 部分由服务端强制。

## 1. 心智模型：配置文件是底，设备 = 底 + 差异贴纸

- 共享层（base / 策略组 / 规则 / 链式代理）改一次**全设备生效**；设备只存自己那几项差异，
  永远跟随共享层。每 profile 最多 **16 台**设备。
- 差异 = `base_patch`，作用于**最终渲染产物的顶层键**（`port` / `secret` / `external-controller` /
  `external-ui` / `find-process-mode` 之类）。
- **管控键黑名单**：补丁碰 `proxies` / `proxy-groups` / `rules` / `rule-providers` /
  `proxy-providers` 会被直接拒（这些归共享层）。用户想"这台设备用不同的策略组成员 / 节点过滤"
  ——那实质是**另一份配置文件，引导克隆 profile**，不要往设备补丁里塞。
- 设备写入与共享层同一条流水线：候选渲染预检 + 版本 CAS + 审计可撤（含 secret 的变更不可撤销）。

## 2. base_patch 语义（RFC 7386 JSON Merge Patch）

- 对象逐字段**深合并**；数组和标量**整段替换**；`null` **删除**该键。
- `update_device` 的 `base_patch` 是**整份替换**存量补丁（补丁本身就是差量，不做「补丁的补丁」）：
  先 `list_devices` 拿现有补丁，改好后整份传回；清空全部差异传 `{}`。
- 上限：序列化 ≤32KB、嵌套 ≤8 层。
- 读到的补丁里敏感键是 `***` 掩码。整份传回时**把 `***` 原样带上即可**——系统会把每个恰好为
  `***` 的值还原为存量补丁同路径的真实值（与 auth_key 省略=保留同一精神）。要**改**敏感值就传
  新的真实值；`***` 出现在存量补丁没有的路径上会被拒（无从还原），此时让用户在设备页填写。

## 3. 写前必预览（本 spoke 招牌）

改补丁 / 新建设备前，先 `preview_device_config` 对**真实共享渲染**试算候选补丁——它校验合并结果、
管控键、尺寸/深度与最终配置合法性，非法时返回结构化 `issues`（不报错）。流程：

`list_devices` 拿现状 → 组出候选 `base_patch` → `preview_device_config` 试算（可传 `device_id`
用存量补丁，或传候选 `base_patch` 覆盖对比）→ 通过后 `create_device` / `update_device`。

需要看设备最终下发的完整 YAML 时传 `include_yaml: true`（已脱敏，较大，默认不返回）。

## 4. 设备级 Tailscale（typed feature，不进 base_patch）

Tailscale 是**类型化设备功能**，走 `set_device_tailscale` / `remove_device_tailscale`，
不通过 `update_device`（generic PATCH 不接受 features）。渲染时注入：一个 `type: tailscale`
出站节点 + 一个单成员 `select` 组 + tailnet 网段（`100.64.0.0/10` + `extra_cidrs`）的 IP-CIDR
规则**置于规则最前**（防上游 IP-CIDR/DIRECT 规则遮蔽）。

- `set_device_tailscale` 是**整份替换**：只改一项也要带上要保留的其它字段（先 `list_devices`
  看现状）。唯一例外 `auth_key` 三态：**省略=保留已存 key / null=清除 / 传值=替换**。
- auth key **永不回显**：所有读取只给 `hasAuthKey`。确认卡 diff 也只显示 presence 变化。
- 同一 profile 内 `control_url + hostname` 重复 → 409（每台设备要独立 hostname）；
  跨 profile 撞名只提示不拒绝。
- **模版 profile（kind=template）不存 Tailscale 身份**，写入会被拒——先从模版建普通配置，
  再到具体设备上启用。
- 字段表（hostname/exit_node/extra_cidrs…）见 `references/tailscale-fields.md`。

## 5. 名字与分发链接

- 设备 `name` 进订阅 URL：`/api/sub/{token}/{profile}/{device}`（token 是 profile 级令牌，
  AI 不经手）。**改名或删设备会使客户端已导入的旧链接失效**——落地前先提醒用户。
- `display_name` 才是客户端导入后的显示名（留空回退 `{profile 显示名}-{device}`），改它无副作用。
- 分发格式：默认 Clash YAML；追加 `?format=base64` 得到通用 Base64 订阅（v2ray 系客户端），
  无法表达为分享链接的节点会被跳过并在响应头标注。
- **模版 profile 不分发**：模版及其设备的订阅 URL 一律 404。

## 6. 模版（template）与设备

- `Profile.kind`：`normal` / `template`。模版与普通配置同型，仅三点不同：不分发、UI 单列、
  新建 profile 时置顶供克隆。
- 从模版（或任意 profile）克隆时设备**一并深拷贝**，但每台设备的 `features` **清空**——
  Tailscale hostname/key 是设备身份，克隆必冲突，需在新 profile 的设备上重新启用。
- 「从模版新建配置」用 hub 的 `create_profile`（`copy_from` 传模版 id）；克隆不继承模版的
  节点来源绑定，建完记得绑定订阅（`update_profile`）并切换作用域再动内容。

## 拥有的工具

读：`list_devices` · `preview_device_config`
写：`create_device` · `update_device` · `delete_device` · `set_device_tailscale` ·
`remove_device_tailscale`

> 跨界常见：设备补丁被拒说要改 `proxy-groups` → 那是共享层，回 hub 路由到
> `synthesizing-proxy-groups`，或引导克隆 profile。

## 参考资料

- `references/tailscale-fields.md` — 设备级 Tailscale 全字段表（含约束与默认值）
