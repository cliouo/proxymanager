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
