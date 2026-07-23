/**
 * 新建设备向导的类型预设 —— **纯前端建议**，不落库为「设备类型」。
 *
 * 刻意不做成实体：一台机器既可能是「服务器」也可能是「桌面」，把它固化成类型只会
 * 逼用户回答一个没有正确答案的问题。预设只是替用户把常见的几项差异预填进补丁，
 * 建完就是一份普通的 base_patch，随便改。
 */

/** 常用顶层键的中文说明 —— 差异卡片与「添加差异」选单共用。 */
export const COMMON_PATCH_KEYS: { key: string; label: string; hint: string }[] = [
  { key: 'external-controller', label: '外部控制器', hint: '监听地址与端口，如 0.0.0.0:9090' },
  { key: 'secret', label: '控制器密钥', hint: '外部控制器的访问密钥（敏感，回显掩码）' },
  { key: 'external-ui', label: '控制面板目录', hint: '本地面板静态文件目录，如 ui' },
  { key: 'external-ui-url', label: '控制面板下载地址', hint: '首次启动自动拉取面板的 URL' },
  { key: 'find-process-mode', label: '进程匹配', hint: 'off / strict / always；手机端通常 off' },
  { key: 'mixed-port', label: '混合端口', hint: 'HTTP/SOCKS 共用端口' },
  { key: 'allow-lan', label: '允许局域网', hint: 'true 时同网段设备可用它作代理' },
  { key: 'log-level', label: '日志级别', hint: 'silent / error / warning / info / debug' },
  { key: 'ipv6', label: 'IPv6', hint: '是否启用 IPv6 解析与出站' },
];

export interface DevicePreset {
  id: 'server' | 'phone' | 'desktop' | 'custom';
  label: string;
  blurb: string;
  /** 预填的补丁；`secret` 之类的随机值由 {@link buildPresetPatch} 现生成。 */
  patch: Record<string, unknown>;
  /** true = 该预设需要一个随机 secret。 */
  needsSecret?: boolean;
}

export const DEVICE_PRESETS: DevicePreset[] = [
  {
    id: 'server',
    label: '服务器',
    blurb: '开放外部控制器与面板，配一个随机密钥。',
    patch: {
      'external-controller': '0.0.0.0:9090',
      'external-ui': 'ui',
      'external-ui-url': 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip',
    },
    needsSecret: true,
  },
  {
    id: 'phone',
    label: '手机',
    blurb: '关掉进程匹配 —— 移动端拿不到进程名，开着只是白费匹配。',
    patch: { 'find-process-mode': 'off' },
  },
  {
    id: 'desktop',
    label: '桌面',
    blurb: '不预填差异，之后按需添加。',
    patch: {},
  },
  {
    id: 'custom',
    label: '自定义',
    blurb: '从空补丁开始。',
    patch: {},
  },
];

/**
 * 生成一个 URL-safe 的随机密钥。用 Web Crypto，不用 Math.random ——
 * 这个值会成为外部控制器的访问凭证，可预测的随机数等于没有密钥。
 */
export function randomSecret(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 展开预设为一份具体补丁（每次调用的随机密钥都不同）。 */
export function buildPresetPatch(preset: DevicePreset): Record<string, unknown> {
  const patch = { ...preset.patch };
  if (preset.needsSecret) patch.secret = randomSecret();
  return patch;
}

/**
 * 每个顶层键被哪些设备覆盖 —— `/base` 页的「N 台设备覆盖」徽章用。
 * 纯客户端计算，不需要新后端。
 */
export function overridesByTopLevelKey(
  devices: readonly { name: string; base_patch: Record<string, unknown> }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const device of devices) {
    for (const key of Object.keys(device.base_patch ?? {})) {
      const names = out.get(key) ?? [];
      names.push(device.name);
      out.set(key, names);
    }
  }
  return out;
}

/** 文本里出现的顶层键 → 行号（1-based）。`/base` 徽章要定位到具体行。 */
export function topLevelKeyLines(yamlText: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z0-9_.'"-]+):(\s|$)/.exec(lines[i]);
    if (match && !out.has(match[1])) out.set(match[1], i + 1);
  }
  return out;
}
