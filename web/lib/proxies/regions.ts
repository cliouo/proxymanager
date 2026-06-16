/**
 * Region detection from a proxy node's display name.
 *
 * Airport node names encode their region in wildly inconsistent ways —
 * Chinese (`香港`), English (`Hong Kong`), ISO-ish codes (`HK` / `HKG`), city
 * names (`东京`), or a flag emoji. We map all of those to a stable region `code`
 * so the flag-emoji (#4) and region-filter (#9) operators, plus sort-by-region
 * (#6), can share one source of truth.
 *
 * Two hard rules to avoid false positives:
 *   - 2- and 3-letter codes match only on Latin word boundaries (so `US` never
 *     fires inside `Russia`, and `HK` never fires inside `HKG`).
 *   - More specific entries are tested first (order matters in REGIONS).
 *
 * Both the alpha-2 (`HK`) and alpha-3 (`HKG`) codes are recognized: alpha-3 is
 * appended as a bounded pattern for every region (see the loop below REGIONS).
 * This lets node names be normalized to uniform 3-letter codes and still get a
 * correct flag — `HKG`, `SGP`, `JPN`… all resolve, not just the alpha-2 forms.
 */

export interface Region {
  /** Stable code (ISO-3166 alpha-2 where sensible). */
  code: string;
  /** ISO-3166 alpha-3 code (e.g. HKG). Also accepted in node names. */
  alpha3: string;
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

/** A bounded Latin code (2 or 3 letters) that won't match inside a longer word. */
function code2(cc: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${cc}(?![A-Za-z])`);
}

/**
 * Ordered region table. Keep specific/long tokens early. Chinese + full
 * English names are case-insensitive; bare alpha-2/alpha-3 codes use code2().
 */
export const REGIONS: Region[] = [
  {
    code: 'HK',
    alpha3: 'HKG',
    emoji: '🇭🇰',
    zh: '香港',
    patterns: [/香港|港岛|深港|沪港|HKT|HKBN/i, /Hong\s?Kong/i, code2('HK')],
  },
  {
    code: 'TW',
    alpha3: 'TWN',
    emoji: '🇹🇼',
    zh: '台湾',
    patterns: [/台湾|台灣|臺灣|台北|新北|彰化/i, /Taiwan/i, code2('TW')],
  },
  {
    code: 'JP',
    alpha3: 'JPN',
    emoji: '🇯🇵',
    zh: '日本',
    patterns: [/日本|东京|東京|大阪|名古屋|埼玉|沪日/i, /Japan|Tokyo|Osaka/i, code2('JP')],
  },
  {
    code: 'KR',
    alpha3: 'KOR',
    emoji: '🇰🇷',
    zh: '韩国',
    patterns: [/韩国|韓國|首尔|首爾|韩/i, /Korea|Seoul/i, code2('KR')],
  },
  {
    code: 'SG',
    alpha3: 'SGP',
    emoji: '🇸🇬',
    zh: '新加坡',
    patterns: [/新加坡|狮城|獅城|沪新/i, /Singapore/i, code2('SG')],
  },
  {
    code: 'US',
    alpha3: 'USA',
    emoji: '🇺🇸',
    zh: '美国',
    patterns: [
      /美国|美國|洛杉矶|硅谷|圣何塞|圣荷西|西雅图|纽约|芝加哥|达拉斯/i,
      /United\s?States|Silicon\s?Valley|Los\s?Angeles|San\s?Jose|Seattle/i,
      code2('US'),
    ],
  },
  {
    code: 'GB',
    alpha3: 'GBR',
    emoji: '🇬🇧',
    zh: '英国',
    patterns: [/英国|英國|伦敦|倫敦/i, /United\s?Kingdom|Britain|London/i, code2('UK'), code2('GB')],
  },
  {
    code: 'DE',
    alpha3: 'DEU',
    emoji: '🇩🇪',
    zh: '德国',
    patterns: [/德国|德國|法兰克福/i, /Germany|Frankfurt/i, code2('DE')],
  },
  {
    code: 'FR',
    alpha3: 'FRA',
    emoji: '🇫🇷',
    zh: '法国',
    patterns: [/法国|法國|巴黎/i, /France|Paris/i, code2('FR')],
  },
  {
    code: 'NL',
    alpha3: 'NLD',
    emoji: '🇳🇱',
    zh: '荷兰',
    patterns: [/荷兰|荷蘭|阿姆斯特丹/i, /Netherlands|Holland|Amsterdam/i, code2('NL')],
  },
  {
    code: 'CA',
    alpha3: 'CAN',
    emoji: '🇨🇦',
    zh: '加拿大',
    patterns: [/加拿大|多伦多|温哥华/i, /Canada|Toronto|Vancouver/i, code2('CA')],
  },
  {
    code: 'AU',
    alpha3: 'AUS',
    emoji: '🇦🇺',
    zh: '澳大利亚',
    patterns: [/澳大利亚|澳洲|悉尼|墨尔本/i, /Australia|Sydney|Melbourne/i, code2('AU')],
  },
  {
    code: 'RU',
    alpha3: 'RUS',
    emoji: '🇷🇺',
    zh: '俄罗斯',
    patterns: [/俄罗斯|俄羅斯|莫斯科/i, /Russia|Moscow/i, code2('RU')],
  },
  {
    code: 'IN',
    alpha3: 'IND',
    emoji: '🇮🇳',
    zh: '印度',
    patterns: [/印度|孟买|孟買/i, /India|Mumbai/i, code2('IN')],
  },
  {
    code: 'TR',
    alpha3: 'TUR',
    emoji: '🇹🇷',
    zh: '土耳其',
    patterns: [/土耳其/i, /Turkey/i, code2('TR')],
  },
  {
    code: 'MY',
    alpha3: 'MYS',
    emoji: '🇲🇾',
    zh: '马来西亚',
    patterns: [/马来|馬來|吉隆坡/i, /Malaysia/i, code2('MY')],
  },
  {
    code: 'TH',
    alpha3: 'THA',
    emoji: '🇹🇭',
    zh: '泰国',
    patterns: [/泰国|泰國|曼谷/i, /Thailand|Bangkok/i, code2('TH')],
  },
  {
    code: 'VN',
    alpha3: 'VNM',
    emoji: '🇻🇳',
    zh: '越南',
    patterns: [/越南/i, /Vietnam/i, code2('VN')],
  },
  {
    code: 'PH',
    alpha3: 'PHL',
    emoji: '🇵🇭',
    zh: '菲律宾',
    patterns: [/菲律宾|菲律賓/i, /Philippines/i, code2('PH')],
  },
  {
    code: 'ID',
    alpha3: 'IDN',
    emoji: '🇮🇩',
    zh: '印尼',
    patterns: [/印尼|印度尼西亚|雅加达/i, /Indonesia|Jakarta/i, code2('ID')],
  },
  {
    code: 'IT',
    alpha3: 'ITA',
    emoji: '🇮🇹',
    zh: '意大利',
    patterns: [/意大利|米兰|罗马/i, /Italy|Milan|Rome/i, code2('IT')],
  },
  {
    code: 'ES',
    alpha3: 'ESP',
    emoji: '🇪🇸',
    zh: '西班牙',
    patterns: [/西班牙|马德里/i, /Spain|Madrid/i, code2('ES')],
  },
  {
    code: 'BR',
    alpha3: 'BRA',
    emoji: '🇧🇷',
    zh: '巴西',
    patterns: [/巴西|圣保罗/i, /Brazil/i, code2('BR')],
  },
  {
    code: 'AR',
    alpha3: 'ARG',
    emoji: '🇦🇷',
    zh: '阿根廷',
    patterns: [/阿根廷/i, /Argentina/i, code2('AR')],
  },
  {
    code: 'CN',
    alpha3: 'CHN',
    emoji: '🇨🇳',
    zh: '中国',
    patterns: [/中国|中國|回国|回國|北京|上海|广州|深圳/i, /China|Beijing|Shanghai/i, code2('CN')],
  },
];

// Append a bounded alpha-3 matcher to every region. Done as a post-step (rather
// than inline) so the alpha-3 codes stay derived from the single `alpha3` field
// and can't drift out of sync with the patterns. Placed LAST in each region's
// list so the more specific Chinese/English/city patterns still win first.
for (const region of REGIONS) {
  region.patterns.push(code2(region.alpha3));
}

const REGION_BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));
const REGION_BY_ALPHA3 = new Map(REGIONS.map((r) => [r.alpha3, r]));

/** Look up a region's metadata by its alpha-2 `code` or alpha-3 code. */
export function regionByCode(code: string): Region | undefined {
  const cc = code.trim().toUpperCase();
  return REGION_BY_CODE.get(cc) ?? REGION_BY_ALPHA3.get(cc);
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
