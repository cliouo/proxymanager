/** Formatting helpers tuned for a Chinese UI with Latin numerals. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const fixed = value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(digits);
  return `${fixed.replace(/\.0+$/, '')} ${UNITS[exponent]}`;
}

/** Accepts seconds or milliseconds epoch. */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

const rtf = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }) : null;

export function relativeTime(ts: number | undefined | null, now = Date.now()): string {
  if (!ts) return '—';
  const diff = toMs(ts) - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (abs < 45_000) return diff < 0 ? '刚刚' : '马上';
  if (!rtf) return new Date(toMs(ts)).toLocaleString('zh-CN');
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
  if (abs < 30 * day) return rtf.format(Math.round(diff / day), 'day');
  if (abs < 365 * day) return rtf.format(Math.round(diff / (30 * day)), 'month');
  return rtf.format(Math.round(diff / (365 * day)), 'year');
}

export function formatDate(ts: number | undefined | null, withTime = false): string {
  if (!ts) return '—';
  const date = new Date(toMs(ts));
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}

export function formatTime(ts: number): string {
  return new Date(toMs(ts)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** Days until an epoch (negative when past). */
export function daysUntil(ts: number, now = Date.now()): number {
  return Math.ceil((toMs(ts) - now) / 86_400_000);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function plural(count: number, unit: string): string {
  return `${formatCount(count)} ${unit}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} 秒`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} 分钟`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)} 小时`;
  return `${Math.round(h / 24)} 天`;
}

export function truncateMiddle(value: string, max = 48): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}
