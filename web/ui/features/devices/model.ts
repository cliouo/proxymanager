/**
 * Pure helpers for 设备 (device = shared config + a small patch).
 *
 * Limits and key lists are COPIED from `web/schemas/device.ts` and
 * `web/lib/engine/devicePatch.ts` — those modules pull zod / the render engine
 * into the bundle, so client code must not import them. Keep them in sync.
 */
import { parseDocument, stringify } from 'yaml';
import {
  Gamepad2,
  Laptop,
  Monitor,
  MonitorSmartphone,
  Router,
  Server,
  Smartphone,
  Tablet,
  Tv,
  type LucideIcon,
} from 'lucide-react';
import { COMMON_PATCH_KEYS, randomSecret } from '@/lib/profiles/devicePresets';

export { COMMON_PATCH_KEYS, DEVICE_PRESETS, buildPresetPatch, randomSecret } from '@/lib/profiles/devicePresets';
export type { DevicePreset } from '@/lib/profiles/devicePresets';

/* ─── limits (mirror of schemas/device.ts) ───────────────────────────── */

export const MAX_DEVICES_PER_PROFILE = 16;
export const MAX_BASE_PATCH_BYTES = 32 * 1024;
export const MAX_BASE_PATCH_DEPTH = 8;
export const DEVICE_NAME_RE = /^[a-z0-9-]+$/;
export const DISPLAY_NAME_MAX = 120;

/** Keys owned by the shared layer (mirror of MANAGED_PATCH_KEYS). */
export const MANAGED_PATCH_KEYS = ['proxies', 'proxy-groups', 'proxy-providers', 'rules', 'rule-providers'];
/** Keys whose values are masked in previews (mirror of SENSITIVE_PATCH_KEYS). */
export const SENSITIVE_PATCH_KEYS = ['secret', 'auth-key', 'authentication', 'password', 'private-key', 'token'];

const MANAGED = new Set(MANAGED_PATCH_KEYS);
const SENSITIVE = new Set(SENSITIVE_PATCH_KEYS);

export type Patch = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Patch {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(key.toLowerCase());
}

/* ─── key catalogue ──────────────────────────────────────────────────── */

export interface PatchKeyMeta {
  key: string;
  label: string;
  hint: string;
  /** Common keys come from the shared preset module; extras are ours. */
  common: boolean;
  options?: string[];
  port?: boolean;
}

const EXTRA_PATCH_KEYS: Array<Omit<PatchKeyMeta, 'common'>> = [
  { key: 'tun', label: 'TUN', hint: '虚拟网卡接管整机流量（透明代理）' },
  { key: 'dns', label: 'DNS', hint: '覆盖共享配置里的部分 DNS 设置，其余保持不变' },
  { key: 'port', label: 'HTTP 端口', hint: '只提供 HTTP 代理的端口' },
  { key: 'socks-port', label: 'SOCKS 端口', hint: '只提供 SOCKS5 代理的端口' },
  { key: 'redir-port', label: '透明代理端口', hint: 'Linux redirect 透明代理端口' },
  { key: 'tproxy-port', label: 'TProxy 端口', hint: 'Linux TProxy 透明代理端口' },
  { key: 'bind-address', label: '监听地址', hint: '允许局域网时绑定的地址，* 表示全部' },
  { key: 'mode', label: '代理模式', hint: 'rule 按规则分流 / global 全局 / direct 直连' },
  { key: 'interface-name', label: '出站网卡', hint: '指定流量从哪块网卡出去' },
  { key: 'sniffer', label: '域名嗅探', hint: '从流量里识别域名，改善分流准确度' },
  { key: 'unified-delay', label: '统一延迟', hint: '测速时去掉握手耗时，数值更可比' },
  { key: 'tcp-concurrent', label: 'TCP 并发', hint: '同时连接多个解析结果，用最快的那个' },
];

const ENUM_OPTIONS: Record<string, string[]> = {
  'find-process-mode': ['off', 'strict', 'always'],
  'log-level': ['silent', 'error', 'warning', 'info', 'debug'],
  mode: ['rule', 'global', 'direct'],
};

const PORT_KEYS = new Set(['mixed-port', 'port', 'socks-port', 'redir-port', 'tproxy-port']);

export const PATCH_KEYS: PatchKeyMeta[] = [
  ...COMMON_PATCH_KEYS.map((k) => ({ ...k, common: true })),
  ...EXTRA_PATCH_KEYS.map((k) => ({ ...k, common: false })),
].map((k) => ({ ...k, options: ENUM_OPTIONS[k.key], port: PORT_KEYS.has(k.key) }));

const META_BY_KEY = new Map(PATCH_KEYS.map((k) => [k.key, k]));

export function keyMeta(key: string): PatchKeyMeta | undefined {
  return META_BY_KEY.get(key);
}

export function keyLabel(key: string): string {
  return META_BY_KEY.get(key)?.label ?? key;
}

const DEFAULTS: Record<string, unknown> = {
  'external-controller': '127.0.0.1:9090',
  'external-ui': 'ui',
  'external-ui-url': 'https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip',
  'find-process-mode': 'off',
  'mixed-port': 7890,
  'allow-lan': true,
  'log-level': 'warning',
  ipv6: false,
  tun: { enable: true, stack: 'mixed', 'auto-route': true, 'auto-detect-interface': true },
  dns: { enable: true },
  port: 7891,
  'socks-port': 7892,
  'redir-port': 7893,
  'tproxy-port': 7894,
  'bind-address': '*',
  mode: 'rule',
  'interface-name': 'eth0',
  sniffer: { enable: true },
  'unified-delay': true,
  'tcp-concurrent': true,
};

/**
 * A sensible starting value for a newly added difference. Scalars start from
 * the shared value (booleans flipped — adding a switch means changing it), so
 * the user edits from what the device would otherwise get.
 */
export function defaultValueFor(key: string, shared: unknown): unknown {
  if (key === 'secret') return randomSecret();
  const fallback = DEFAULTS[key];
  if (typeof shared === 'boolean') return !shared;
  if (fallback !== undefined) {
    if (typeof shared === typeof fallback && (typeof shared === 'number' || typeof shared === 'string')) return shared;
    if (isPlainObject(fallback) && isPlainObject(shared) && typeof shared.enable === 'boolean') {
      return { ...fallback, enable: !shared.enable };
    }
    return structuredClone(fallback);
  }
  if (typeof shared === 'number' || typeof shared === 'string') return shared;
  if (isPlainObject(shared)) return {};
  return '';
}

/* ─── value kinds ────────────────────────────────────────────────────── */

export type ValueKind = 'string' | 'number' | 'boolean' | 'object' | 'null';

export function valueKind(value: unknown): ValueKind {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'string';
}

export const KIND_LABEL: Record<ValueKind, string> = {
  string: '文本',
  number: '数字',
  boolean: '开关',
  object: '对象（YAML）',
  null: '从共享配置中删除',
};

export function convertValue(value: unknown, kind: ValueKind, key: string): unknown {
  switch (kind) {
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : true;
    case 'object':
      return isPlainObject(value) || Array.isArray(value) ? value : isPlainObject(DEFAULTS[key]) ? structuredClone(DEFAULTS[key]) : {};
    case 'null':
      return null;
  }
}

/* ─── summaries ──────────────────────────────────────────────────────── */

export interface PatchChip {
  key: string;
  label: string;
  value?: string;
  tone: 'default' | 'remove' | 'secret';
}

function short(value: string, max = 24): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function chipFor(key: string, value: unknown): PatchChip {
  const label = keyLabel(key);
  if (value === null) return { key, label, value: '删除', tone: 'remove' };
  if (isSensitiveKey(key)) return { key, label, value: '已设置', tone: 'secret' };
  if (typeof value === 'boolean') return { key, label, value: value ? '开' : '关', tone: 'default' };
  if (typeof value === 'number') return { key, label, value: String(value), tone: 'default' };
  if (typeof value === 'string') return { key, label, value: short(value), tone: 'default' };
  if (Array.isArray(value)) return { key, label, value: `${value.length} 项`, tone: 'default' };
  if (isPlainObject(value)) {
    if (typeof value.enable === 'boolean') return { key, label, value: value.enable ? '开' : '关', tone: 'default' };
    return { key, label, value: `${Object.keys(value).length} 项`, tone: 'default' };
  }
  return { key, label, tone: 'default' };
}

export function summarizePatch(patch: Patch | undefined): PatchChip[] {
  return Object.entries(patch ?? {}).map(([key, value]) => chipFor(key, value));
}

/** Compact one-line rendering of a value from the shared config. */
export function inlineValue(key: string, value: unknown): string {
  if (value === undefined) return '未设置';
  if (value === null) return 'null';
  if (isSensitiveKey(key)) return '***';
  if (typeof value === 'string') return short(value, 40);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} 项列表`;
  if (isPlainObject(value)) {
    const n = Object.keys(value).length;
    if (typeof value.enable === 'boolean') return `enable: ${value.enable} · 共 ${n} 项`;
    return `${n} 项`;
  }
  return String(value);
}

/* ─── platform glyphs ────────────────────────────────────────────────── */

export type Platform = 'phone' | 'tablet' | 'laptop' | 'desktop' | 'router' | 'tv' | 'server' | 'console' | 'generic';

const PLATFORM_RULES: Array<[Platform, RegExp]> = [
  ['tablet', /ipad|tablet|平板|matepad|galaxy\s*tab/i],
  ['phone', /iphone|phone|android|pixel|galaxy|手机|xiaomi|redmi|huawei|honor|oppo|vivo|oneplus|meizu|小米|华为|荣耀/i],
  ['tv', /\btv\b|appletv|apple-tv|电视|盒子|firetv|fire-tv|shield|chromecast|投影/i],
  ['router', /router|openwrt|immortalwrt|路由|gateway|网关|ikuai|爱快|lede|padavan|merlin|梅林/i],
  ['console', /ps[45]|playstation|xbox|steam\s*deck|游戏机|\bswitch\b/i],
  ['server', /server|vps|\bnas\b|服务器|homelab|ubuntu|debian|centos|docker|群晖|synology|unraid|truenas|proxmox|\bpve\b/i],
  ['laptop', /macbook|laptop|notebook|笔记本|thinkpad|xps|surface|matebook|zenbook/i],
  ['desktop', /desktop|\bpc\b|imac|mac-?mini|mac\s*studio|台式|windows|\bwin\b|workstation|主机|电脑/i],
];

export function guessPlatform(...names: Array<string | undefined | null>): Platform {
  const text = names.filter(Boolean).join(' ');
  for (const [platform, re] of PLATFORM_RULES) if (re.test(text)) return platform;
  return 'generic';
}

export const PLATFORM_META: Record<Platform, { icon: LucideIcon; label: string }> = {
  phone: { icon: Smartphone, label: '手机' },
  tablet: { icon: Tablet, label: '平板' },
  laptop: { icon: Laptop, label: '笔记本' },
  desktop: { icon: Monitor, label: '电脑' },
  router: { icon: Router, label: '路由器' },
  tv: { icon: Tv, label: '电视' },
  server: { icon: Server, label: '服务器' },
  console: { icon: Gamepad2, label: '游戏机' },
  generic: { icon: MonitorSmartphone, label: '设备' },
};

/* ─── names ──────────────────────────────────────────────────────────── */

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** URL slug for a new device: from the display name, else the platform, unique in the profile. */
export function suggestSlug(displayName: string, taken: Set<string>): string {
  let base = slugify(displayName);
  if (!base) {
    const platform = guessPlatform(displayName);
    base = platform === 'generic' ? 'device' : platform;
  }
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export function nameError(name: string, taken: Set<string>): string | null {
  if (!name) return '请填写链接名';
  if (!DEVICE_NAME_RE.test(name)) return '只能用小写字母、数字和中划线';
  if (taken.has(name)) return '这份配置里已有同名设备';
  return null;
}

export type DeviceLinkVariant = 'clash' | 'shadowrocket' | 'base64';

export function deviceLink(subscriptionUrl: string, name: string, variant: DeviceLinkVariant = 'clash'): string {
  const url = `${subscriptionUrl}/${encodeURIComponent(name)}`;
  if (variant === 'shadowrocket') return `${url}?client=shadowrocket`;
  return variant === 'base64' ? `${url}?format=base64` : url;
}

/* ─── validation (mirror of assertValidDevicePatch + a port check) ───── */

export interface PatchProblem {
  key?: string;
  message: string;
}

function measureDepth(value: unknown): number {
  if (Array.isArray(value)) return 1 + value.reduce<number>((max, item) => Math.max(max, measureDepth(item)), 0);
  if (isPlainObject(value)) return 1 + Object.values(value).reduce<number>((max, v) => Math.max(max, measureDepth(v)), 0);
  return 0;
}

export function patchBytes(patch: Patch): number {
  return new TextEncoder().encode(JSON.stringify(patch)).length;
}

export function validatePatch(patch: unknown): PatchProblem[] {
  if (!isPlainObject(patch)) return [{ message: '差异必须是「键: 值」形式的映射，例如 mixed-port: 7891' }];
  const problems: PatchProblem[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!key.trim()) problems.push({ key, message: '键名不能为空' });
    else if (MANAGED.has(key)) {
      problems.push({
        key,
        message: `${key} 由共享层统一管理（节点、策略组、规则、规则集），设备不能单独修改；确实需要不同，请另建一份配置文件。`,
      });
    } else if (key === '<<') problems.push({ key, message: '不支持 YAML 合并键 <<' });
    if (PORT_KEYS.has(key) && value !== null) {
      const ok = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535;
      if (!ok) problems.push({ key, message: '端口必须是 0–65535 的整数' });
    }
  }
  const bytes = patchBytes(patch);
  if (bytes > MAX_BASE_PATCH_BYTES) {
    problems.push({ message: `差异太大（${Math.ceil(bytes / 1024)} KB，上限 32 KB）` });
  }
  const depth = measureDepth(patch);
  if (depth > MAX_BASE_PATCH_DEPTH) {
    problems.push({ message: `嵌套太深（${depth} 层，上限 ${MAX_BASE_PATCH_DEPTH} 层）` });
  }
  return problems;
}

/* ─── YAML ───────────────────────────────────────────────────────────── */

export function toYaml(value: unknown): string {
  if (isPlainObject(value) && Object.keys(value).length === 0) return '';
  return stringify(value, { lineWidth: 0 });
}

export function parseYamlValue(text: string): { value: unknown; error: string | null } {
  if (!text.trim()) return { value: null, error: null };
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const line = first.linePos?.[0]?.line;
    const message = first.message.split('\n')[0];
    return { value: undefined, error: line ? `第 ${line} 行 YAML 有误：${message}` : `YAML 有误：${message}` };
  }
  return { value: doc.toJS(), error: null };
}

/** Parse the whole patch from source mode. Empty text = empty patch. */
export function parsePatchText(text: string): { patch: Patch | null; error: string | null } {
  if (!text.trim()) return { patch: {}, error: null };
  const { value, error } = parseYamlValue(text);
  if (error) return { patch: null, error };
  if (value === null || value === undefined) return { patch: {}, error: null };
  if (!isPlainObject(value)) {
    return { patch: null, error: '差异必须是「键: 值」形式的映射，例如 mixed-port: 7891' };
  }
  return { patch: value, error: null };
}

/* ─── local preview (mirror of renderDevicePatchedYaml + redaction) ─── */

export function applyMergePatch(target: Patch, patch: Patch): Patch {
  const out: Patch = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value)) {
      const current = out[key];
      out[key] = applyMergePatch(isPlainObject(current) ? current : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function redactSensitive<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Patch = {};
    for (const [key, v] of Object.entries(value)) out[key] = isSensitiveKey(key) ? '***' : redactSensitive(v);
    return out as unknown as T;
  }
  return value;
}

/** Parse the (already redacted) shared YAML once; null if it isn't a mapping. */
export function parseShared(shared: string | undefined): Patch | null {
  if (!shared) return null;
  try {
    const doc = parseDocument(shared);
    if (doc.errors.length > 0) return null;
    const root = doc.toJS() as unknown;
    return isPlainObject(root) ? root : null;
  } catch {
    return null;
  }
}

/** What the device config would look like with `patch` (Tailscale injection excluded). */
export function draftDeviceYaml(sharedRoot: Patch, patch: Patch): string {
  return stringify(redactSensitive(applyMergePatch(sharedRoot, patch)));
}

export function samePatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}
