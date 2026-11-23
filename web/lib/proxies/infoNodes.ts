import type { SubscriptionTraffic } from '@/schemas/subscription';
import { MAX_PROXY_NAME_LENGTH } from './mihomoProxyTypes';

/** Built-in junk patterns shared with the 去除无用节点 operator. */
export const USELESS_PATTERNS = [
  '剩余流量',
  '剩余',
  '到期',
  '过期',
  '重置',
  '距离',
  '官网',
  '网址',
  '续费',
  '订阅',
  '邀请',
  '失联',
  '客服',
  '群组',
  '频道',
  '公告',
  '更新于',
  '套餐',
  '维护',
  '购买',
  '充值',
  '此处',
  '请勿',
  '禁止',
  'expire',
  'traffic',
  'reset',
  'remaining',
  't\\.me',
  'telegram',
  'https?://',
];

const INFO_PATTERNS = USELESS_PATTERNS.map((pattern) => new RegExp(pattern, 'i'));

export function isInfoNodeName(name: string): boolean {
  const label = name.replace(/https?:\/\/\S+/gi, '');
  return /^\s*https?:\/\//i.test(name) || INFO_PATTERNS.some((pattern) => pattern.test(label));
}

const USED = /(?:当前流量|已用流量|已使用流量|已使用|流量(?=\s*[:：=])|(?:traffic|data)\s+used|used\s+(?:traffic|data)|(?:traffic|data)\s+usage)/iu;
const REMAINING = /(?:剩余流量|可用流量|流量剩余|(?:remaining|available)\s+(?:traffic|data)|(?:traffic|data)\s+(?:remaining|left))/iu;
const EXPIRY = /(?:到期(?:时间|日期)?|(?:套餐|订阅|有效期)\s*(?:到期|截止)|有效期至|expir(?:es?|y|ation)(?:\s+(?:date|time|on))?|valid\s+until)(?=\s*[:：=]|\s*\d{4}[-/.年]|\s*$)/iu;
const NOTICE = /(?:流量重置|重置(?:时间|日期|流量)?|距离(?:下次)?重置|套餐(?=\s*[:：=])|官网(?:地址)?|官方网站|订阅链接|续费(?:地址|链接)?|客服(?:地址|链接)?|(?:official\s+)?website|(?:traffic|data)\s+reset|reset\s+(?:date|time))(?=\s*[:：=]|\s*https?:\/\/|\s*$)/iu;
const SIZE = String.raw`(\d+(?:\.\d+)?)\s*([KMGTPE](?:i?B)?|B)(?![a-z])`;
const VALUE_SUFFIX = String.raw`(?:[\s\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\p{M}\u200d!?,.;~。…]|\([^()\r\n]*\)|\[[^\[\]\r\n]*\]|【[^【】\r\n]*】)*$`;

function labelPattern(keyword: RegExp, value = ''): RegExp {
  return new RegExp(`^${keyword.source}\\s*(?:[:：=]\\s*)?${value}`, 'iu');
}

const TRAFFIC_VALUE = `${SIZE}(?:\\s*/\\s*${SIZE})?${VALUE_SUFFIX}`;
const USED_LABEL = labelPattern(USED, TRAFFIC_VALUE);
const REMAINING_LABEL = labelPattern(REMAINING, TRAFFIC_VALUE);
const EXPIRY_LABEL = labelPattern(EXPIRY);
const NAMED_OFFSET = String.raw`(?:UTC|GMT)[+-]\d{1,2}(?::\d{2})?`;
const EXPIRY_DATE = labelPattern(EXPIRY, String.raw`(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*(Z|[+-]\d{2}:?\d{2}|${NAMED_OFFSET}|\(${NAMED_OFFSET}\)))?)?${VALUE_SUFFIX}`);
const NOTICE_LABEL = labelPattern(NOTICE);

function subscriptionLabel(name: string): string {
  return name.normalize('NFKC').replace(/^[^\p{L}\p{N}]*(?:[a-z]{1,32}_[^\p{L}\p{N}]*)?/iu, '');
}

export function isSubscriptionInfoNodeName(name: string): boolean {
  if (name.length > MAX_PROXY_NAME_LENGTH) return false;
  const label = subscriptionLabel(name);
  return !!(
    USED_LABEL.test(label) ||
    REMAINING_LABEL.test(label) ||
    EXPIRY_LABEL.test(label) ||
    NOTICE_LABEL.test(label) ||
    /^\s*https?:\/\/\S+\s*$/iu.test(label)
  );
}

function toBytes(number: string, unit: string): number | undefined {
  const bytes = Math.round(Number(number) * 1024 ** ('BKMGTPE'.indexOf(unit[0].toUpperCase())));
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function expirySeconds(date: RegExpMatchArray): number | undefined {
  const [, year, month, day, hours = '0', minutes = '0', seconds = '0', zone] = date;
  const utc = new Date(Date.UTC(+year, +month - 1, +day, +hours, +minutes, +seconds));
  if (
    utc.getUTCFullYear() !== +year || utc.getUTCMonth() !== +month - 1 || utc.getUTCDate() !== +day ||
    +hours > 23 || +minutes > 59 || +seconds > 59
  ) return;
  if (!zone || zone.toUpperCase() === 'Z') return utc.getTime() / 1000;
  const offsetParts = zone.match(/([+-])(\d{1,2})(?::?(\d{2}))?\)?$/u);
  if (!offsetParts) return;
  const [, sign, offsetHours, offsetMinutes = '0'] = offsetParts;
  if (+offsetHours > 23 || +offsetMinutes > 59) return;
  const offset = (+offsetHours * 60 + +offsetMinutes) * (sign === '-' ? -1 : 1);
  return utc.getTime() / 1000 - offset * 60;
}

export function subscriptionTrafficFromNodes(names: readonly string[]): SubscriptionTraffic | undefined {
  let used: number | undefined;
  let total: number | undefined;
  let remaining: number | undefined;
  let expire: number | undefined;
  for (const name of names) {
    if (name.length > MAX_PROXY_NAME_LENGTH) continue;
    const label = subscriptionLabel(name);
    const usage = label.match(USED_LABEL);
    const available = label.match(REMAINING_LABEL);
    const date = label.match(EXPIRY_DATE);
    if (usage) {
      used ??= toBytes(usage[1], usage[2]);
      if (usage[3]) total ??= toBytes(usage[3], usage[4]);
    }
    if (available) {
      remaining ??= toBytes(available[1], available[2]);
      if (available[3]) total ??= toBytes(available[3], available[4]);
    }
    if (date) expire ??= expirySeconds(date);
  }
  if (used === undefined && remaining !== undefined && total !== undefined && remaining <= total) {
    used = total - remaining;
  }
  if (used === undefined && remaining === undefined && expire === undefined) return undefined;
  return {
    upload: 0,
    download: used ?? 0,
    total: total ?? 0,
    expire: expire ?? 0,
    from_node_labels: true,
    ...(used === undefined && remaining !== undefined ? { remaining } : {}),
    ...(used === undefined && remaining === undefined ? { expiry_only: true } : {}),
    ...(used !== undefined && total === undefined ? { total_unknown: true } : {}),
  };
}
