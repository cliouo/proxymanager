const RESERVED = /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:\d[\d_]*)?\.?\d+(?:e[-+]?\d+)?)$/i;

function inline(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[]';
  if (typeof value === 'object') return '{}';
  if (typeof value !== 'string') return String(value);
  if (value === '') return "''";
  const plain =
    !RESERVED.test(value) &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !/\s$/.test(value) &&
    !/:\s|\s#/.test(value);
  return plain ? value : JSON.stringify(value);
}

function keyText(key: string): string {
  return /^[\p{L}\p{N}_.\-/]+$/u.test(key) ? key : JSON.stringify(key);
}

const isEmptyContainer = (value: object) =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;

function block(text: string, pad: string): string[] {
  return text.replace(/\n$/, '').split('\n').map((line) => `${pad}${line}`);
}

function lines(value: unknown, pad: string): string[] {
  if (typeof value === 'string' && value.includes('\n')) return block(value, pad);
  if (value === null || typeof value !== 'object' || isEmptyContainer(value)) return [`${pad}${inline(value)}`];
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.includes('\n')) {
        out.push(`${pad}- |`, ...block(item, `${pad}    `));
      } else if (item === null || typeof item !== 'object' || isEmptyContainer(item)) {
        out.push(`${pad}- ${inline(item)}`);
      } else {
        const nested = lines(item, `${pad}  `);
        out.push(`${pad}- ${nested[0].slice(pad.length + 2)}`, ...nested.slice(1));
      }
    }
    return out;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const k = keyText(key);
    if (typeof item === 'string' && item.includes('\n')) {
      out.push(`${pad}${k}: |`, ...block(item, `${pad}  `));
    } else if (item === null || typeof item !== 'object' || isEmptyContainer(item)) {
      out.push(`${pad}${k}: ${inline(item)}`);
    } else {
      out.push(`${pad}${k}:`, ...lines(item, `${pad}  `));
    }
  }
  return out;
}

export function toYamlish(value: unknown): string {
  if (typeof value === 'string') return value;
  return lines(value, '').join('\n');
}

export function previewText(data: unknown, max = 6000): string {
  const text = toYamlish(data);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（内容较长，已截断，共 ${text.length.toLocaleString('zh-CN')} 字符）`;
}

export function formatSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}
