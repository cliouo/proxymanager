import { describe, expect, it } from 'vitest';
import { isSubscriptionInfoNodeName, subscriptionTrafficFromNodes } from '@/lib/proxies/infoNodes';
import { MAX_PROXY_NAME_LENGTH } from '@/lib/proxies/mihomoProxyTypes';

describe('subscription info labels', () => {
  it('does not classify or parse overlong names before proxy validation', () => {
    const name = `到期时间：${' '.repeat(MAX_PROXY_NAME_LENGTH)}2027-06-24`;
    expect(isSubscriptionInfoNodeName(name)).toBe(false);
    expect(subscriptionTrafficFromNodes([name])).toBeUndefined();
  });
});
