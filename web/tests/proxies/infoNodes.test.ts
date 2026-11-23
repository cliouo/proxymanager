import { describe, expect, it } from 'vitest';
import { isSubscriptionInfoNodeName, subscriptionTrafficFromNodes } from '@/lib/proxies/infoNodes';
import { MAX_PROXY_NAME_LENGTH } from '@/lib/proxies/mihomoProxyTypes';

describe('subscription info labels', () => {
  it('does not classify or parse overlong names before proxy validation', () => {
    const name = `到期时间：${' '.repeat(MAX_PROXY_NAME_LENGTH)}2027-06-24`;
    expect(isSubscriptionInfoNodeName(name)).toBe(false);
    expect(subscriptionTrafficFromNodes([name])).toBeUndefined();
  });

  it.each([
    'HK-01 | 官网: https://example.com',
    'imm_HKG 01 | 当前流量: 1 GB',
    'JP 03 | 到期时间: 2027-06-24',
  ])('preserves a real node with a notice suffix: %s', (name) => {
    expect(isSubscriptionInfoNodeName(name)).toBe(false);
    expect(subscriptionTrafficFromNodes([name])).toBeUndefined();
  });

  it.each([
    '🏠 官网: https://example.com',
    'imm_📊 当前流量: 1 GB / 5 GB',
    'imm_到期时间: 2027-06-24',
    '📢 https://example.com',
  ])('recognizes a notice on its own with decoration: %s', (name) => {
    expect(isSubscriptionInfoNodeName(name)).toBe(true);
  });

  it.each([
    ['剩余流量：1.91G 🚀', { remaining: Math.round(1.91 * 1024 ** 3) }],
    ['当前流量：1 GB / 5 GB (renews monthly) ✅', { download: 1024 ** 3, total: 5 * 1024 ** 3 }],
    ['到期时间：2027-06-24（请及时续费）', { expire: Date.UTC(2027, 5, 24) / 1000 }],
    ['到期时间：2027-06-24T18:23:35+08:00【请及时续费】', { expire: Date.UTC(2027, 5, 24, 10, 23, 35) / 1000 }],
  ])('detects and parses a notice followed by decoration: %s', (name, traffic) => {
    expect({
      detected: isSubscriptionInfoNodeName(name),
      traffic: subscriptionTrafficFromNodes([name]),
    }).toMatchObject({ detected: true, traffic });
  });

  it.each([
    ['2027-06-24', '2027-06-24T00:00:00Z'],
    ['2027-06-24 18:23:35+08:00', '2027-06-24T10:23:35Z'],
    ['2027-06-24T18:23:35.123Z', '2027-06-24T18:23:35Z'],
    ['2027/06/24 21:15-0400', '2027-06-25T01:15:00Z'],
    ['2027年6月24日 18:23', '2027-06-24T18:23:00Z'],
    ['2027-06-24 18:00 (UTC+8)', '2027-06-24T10:00:00Z'],
    ['2027-06-24 18:00（GMT+8）', '2027-06-24T10:00:00Z'],
    ['2027-06-24 18:00 UTC+8', '2027-06-24T10:00:00Z'],
    ['2027-06-24 18:00 GMT-3:30 (renews monthly)', '2027-06-24T21:30:00Z'],
  ])('preserves the time and zone on the expiry label %s', (labelDate, expected) => {
    expect(subscriptionTrafficFromNodes([`有效期至：${labelDate}`])?.expire).toBe(Date.parse(expected) / 1000);
  });

  it.each(['2027-02-30 12:00', '2027-06-24 24:00', '2027-06-24 18:23+08:90', '2027-06-24 18:23 (UTC+25)'])(
    'does not fall back to midnight for invalid expiry %s',
    (labelDate) => {
      expect(subscriptionTrafficFromNodes([`到期时间：${labelDate}`])).toBeUndefined();
    },
  );
});
