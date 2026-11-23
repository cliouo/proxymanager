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
});
