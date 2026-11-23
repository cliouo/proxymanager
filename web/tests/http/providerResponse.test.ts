import { describe, expect, it } from 'vitest';
import { nodeExportResponse } from '@/lib/http/providerResponse';
import { subscriptionTrafficFromNodes } from '@/lib/proxies/infoNodes';
import { parseTrafficHeader } from '@/lib/services/subscriptionFetcher';
import type { SubscriptionTraffic } from '@/schemas';

function userinfo(traffic: SubscriptionTraffic | undefined): string | null {
  return nodeExportResponse(new Request('https://pm.test/provider'), {
    yaml: 'proxies: []', proxies: [], proxyCount: 0, stale: false, memberErrors: [], traffic,
  }, 'provider').headers.get('Subscription-Userinfo');
}

describe('Subscription-Userinfo export', () => {
  it.each([
    ['剩余流量: 10 GB', null],
    ['到期时间: 2027-06-24', 'expire=1813795200'],
    ['当前流量: 1 GB', 'download=1073741824'],
    ['当前流量: 0 GB / 5 GB', 'download=0; total=5368709120'],
  ])('omits unavailable metrics inferred from %s', (label, expected) => {
    expect(userinfo(subscriptionTrafficFromNodes([label]))).toBe(expected);
  });

  it('still forwards upstream counters that are explicitly zero', () => {
    expect(userinfo(parseTrafficHeader('upload=0; download=1; total=0; expire=0')))
      .toBe('upload=0; download=1; total=0; expire=0');
  });
});
