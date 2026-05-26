/**
 * Region detection from a proxy node's display name.
 *
 * Airport node names encode their region in wildly inconsistent ways —
 * Chinese (`香港`), English (`Hong Kong`), ISO-ish codes (`HK`), city names
 * (`东京`), or a flag emoji. We map all of those to a stable region `code`
 * so the flag-emoji (#4) and region-filter (#9) operators, plus sort-by-region
 * (#6), can share one source of truth.
 *
 * Two hard rules to avoid false positives:
 *   - 2-letter codes match only on Latin word boundaries (so `US` never fires
 *     inside `Russia`, `HK` never inside `…HKG-backup`… actually that's fine).
 *   - More specific entries are tested first (order matters in REGIONS).
 */

export interface Region {
  /** Stable code (ISO-3166 alpha-2 where sensible). */
  code: string;
  /** Flag emoji (regional-indicator pair). */
  emoji: string;
  /** Chinese label for UI. */
  zh: string;
  /** Match patterns; first hit wins. */
  patterns: RegExp[];
}

/** Build a regional-indicator flag emoji from a 2-letter code, e.g. HK → 🇭🇰. */
export function flagFromCode(code: string): string {
  const cc = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + (cc.charCodeAt(0) - 65),
    base + (cc.charCodeAt(1) - 65),
  );
}

/** Matches one flag emoji (two consecutive regional-indicator symbols). */
const FLAG_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

/** Extract the region code from a leading/embedded flag emoji, or null. */
export function codeFromFlag(name: string): string | null {
  const m = name.match(FLAG_RE);
  if (!m || m.length === 0) return null;
  const flag = [...m[0]];
  const a = flag[0].codePointAt(0)! - 0x1f1e6 + 65;
  const b = flag[1].codePointAt(0)! - 0x1f1e6 + 65;
  return String.fromCharCode(a) + String.fromCharCode(b);
}

/** Remove every flag emoji from a name and tidy the resulting separators. */
export function stripFlags(name: string): string {
  return name
    .replace(FLAG_RE, '')
    .replace(/^[\s\-_·|]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** A Latin 2-letter code bounded so it won't match inside a longer word. */
function code2(cc: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${cc}(?![A-Za-z])`);
}

/**
 * Ordered region table. Keep specific/long tokens early. Chinese + full
 * English names are case-insensitive; bare 2-letter codes use code2().
 */
export const REGIONS: Region[] = [
  {
    code: 'HK',
    emoji: '🇭🇰',
    zh: '香港',
    patterns: [/香港|港岛|深港|沪港|HKT|HKBN/i, /Hong\s?Kong/i, code2('HK')],
  },
  {
    code: 'TW',
    emoji: '🇹🇼',
    zh: '台湾',
    patterns: [/台湾|台灣|臺灣|台北|新北|彰化/i, /Taiwan/i, code2('TW')],
  },
  {
    code: 'JP',
    emoji: '🇯🇵',
    zh: '日本',
    patterns: [/日本|东京|東京|大阪|名古屋|埼玉|沪日/i, /Japan|Tokyo|Osaka/i, code2('JP')],
  },
  {
    code: 'KR',
    emoji: '🇰🇷',
    zh: '韩国',
    patterns: [/韩国|韓國|首尔|首爾|韩/i, /Korea|Seoul/i, code2('KR')],
  },
  {
    code: 'SG',
    emoji: '🇸🇬',
    zh: '新加坡',
    patterns: [/新加坡|狮城|獅城|沪新/i, /Singapore/i, code2('SG')],
  },
  {
    code: 'US',
    emoji: '🇺🇸',
    zh: '美国',
    patterns: [
      /美国|美國|洛杉矶|硅谷|圣何塞|圣荷西|西雅图|纽约|芝加哥|达拉斯/i,
      /United\s?States|Silicon\s?Valley|Los\s?Angeles|San\s?Jose|Seattle/i,
      code2('US'),
      code2('USA'),
    ],
  },
  {
    code: 'GB',
    emoji: '🇬🇧',
    zh: '英国',
    patterns: [/英国|英國|伦敦|倫敦/i, /United\s?Kingdom|Britain|London/i, code2('UK'), code2('GB')],
  },
  {
    code: 'DE',
    emoji: '🇩🇪',
    zh: '德国',
    patterns: [/德国|德國|法兰克福/i, /Germany|Frankfurt/i, code2('DE')],
  },
  {
    code: 'FR',
    emoji: '🇫🇷',
    zh: '法国',
    patterns: [/法国|法國|巴黎/i, /France|Paris/i, code2('FR')],
  },
  {
    code: 'NL',
    emoji: '🇳🇱',
    zh: '荷兰',
    patterns: [/荷兰|荷蘭|阿姆斯特丹/i, /Netherlands|Holland|Amsterdam/i, code2('NL')],
  },
  {
    code: 'CA',
    emoji: '🇨🇦',
    zh: '加拿大',
    patterns: [/加拿大|多伦多|温哥华/i, /Canada|Toronto|Vancouver/i, code2('CA')],
  },
  {
    code: 'AU',
    emoji: '🇦🇺',
    zh: '澳大利亚',
    patterns: [/澳大利亚|澳洲|悉尼|墨尔本/i, /Australia|Sydney|Melbourne/i, code2('AU')],
  },
  {
    code: 'RU',
    emoji: '🇷🇺',
    zh: '俄罗斯',
    patterns: [/俄罗斯|俄羅斯|莫斯科/i, /Russia|Moscow/i, code2('RU')],
  },
  {
    code: 'IN',
    emoji: '🇮🇳',
    zh: '印度',
    patterns: [/印度|孟买|孟買/i, /India|Mumbai/i, code2('IN')],
  },
  {
    code: 'TR',
    emoji: '🇹🇷',
    zh: '土耳其',
    patterns: [/土耳其/i, /Turkey/i, code2('TR')],
  },
  {
    code: 'MY',
    emoji: '🇲🇾',
    zh: '马来西亚',
    patterns: [/马来|馬來|吉隆坡/i, /Malaysia/i, code2('MY')],
  },
  {
    code: 'TH',
    emoji: '🇹🇭',
    zh: '泰国',
    patterns: [/泰国|泰國|曼谷/i, /Thailand|Bangkok/i, code2('TH')],
  },
  {
    code: 'VN',
    emoji: '🇻🇳',
    zh: '越南',
    patterns: [/越南/i, /Vietnam/i, code2('VN')],
  },
  {
    code: 'PH',
    emoji: '🇵🇭',
    zh: '菲律宾',
    patterns: [/菲律宾|菲律賓/i, /Philippines/i, code2('PH')],
  },
  {
    code: 'ID',
    emoji: '🇮🇩',
    zh: '印尼',
    patterns: [/印尼|印度尼西亚|雅加达/i, /Indonesia|Jakarta/i, code2('ID')],
  },
  {
    code: 'IT',
    emoji: '🇮🇹',
    zh: '意大利',
    patterns: [/意大利|米兰|罗马/i, /Italy|Milan|Rome/i, code2('IT')],
  },
  {
    code: 'ES',
    emoji: '🇪🇸',
    zh: '西班牙',
    patterns: [/西班牙|马德里/i, /Spain|Madrid/i, code2('ES')],
  },
  {
    code: 'BR',
    emoji: '🇧🇷',
    zh: '巴西',
    patterns: [/巴西|圣保罗/i, /Brazil/i, code2('BR')],
  },
  {
    code: 'AR',
    emoji: '🇦🇷',
    zh: '阿根廷',
    patterns: [/阿根廷/i, /Argentina/i, code2('AR')],
  },
  {
    code: 'CN',
    emoji: '🇨🇳',
    zh: '中国',
    patterns: [/中国|中國|回国|回國|北京|上海|广州|深圳/i, /China|Beijing|Shanghai/i, code2('CN')],
  },
];

const REGION_BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));

/** Look up a region's metadata by code. */
export function regionByCode(code: string): Region | undefined {
  return REGION_BY_CODE.get(code.toUpperCase());
}

/**
 * Detect the region of a node name. Prefers an explicit flag emoji, then
 * keyword/code patterns. Returns the region code (e.g. `HK`) or null.
 */
export function detectRegion(name: string): string | null {
  if (!name) return null;
  const fromFlag = codeFromFlag(name);
  if (fromFlag && REGION_BY_CODE.has(fromFlag)) return fromFlag;
  for (const region of REGIONS) {
    if (region.patterns.some((re) => re.test(name))) return region.code;
  }
  return null;
}
