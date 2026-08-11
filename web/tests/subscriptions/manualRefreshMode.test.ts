import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveSubscriptionContent,
  resolveSubscriptionProxiesRaw,
} from '@/lib/services/subscriptionFetcher';
import type { Subscription } from '@/schemas';
const SUB_ID = '11111111-1111-4111-8111-111111111111';
const CLASH_CONTENT = [
  'mixed-port: 7890',
  'mode: rule',
  'proxies:',
  '  - name: HK-1',
  '    type: ss',
  '    server: hk.example',
  '    port: 443',
  '    cipher: aes-128-gcm',
  '    password: test-password',
].join('\n');

function manualSub(over: Partial<Subscription> = {}): Subscription {
  return {
    id: SUB_ID,
    name: 'cn-only',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    refresh_mode: 'manual',
    fetch_identity_revision: 2,
    manual_snapshot_meta: {
      updated_at: 7,
      proxy_count: 1,
      origin: 'web',
      fetch_identity_revision: 2,
      content_sha256: 'a'.repeat(64),
    },
    ...over,
  } as Subscription;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('manual remote subscription resolution', () => {
  it('extracts proxies from a full Clash config without contacting the upstream', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await resolveSubscriptionContent(manualSub(), {
      noCache: true,
      writeCache: false,
      recordHealth: false,
      contentOverrides: new Map([[SUB_ID, CLASH_CONTENT]]),
    });

    expect(result.proxyCount).toBe(1);
    expect(result.yaml).toContain('HK-1');
    expect(result.yaml).not.toContain('mixed-port');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts URI-list content and exposes the raw validated node list', async () => {
    const result = await resolveSubscriptionProxiesRaw(manualSub(), {
      writeCache: false,
      recordHealth: false,
      contentOverrides: new Map([[SUB_ID, 'ss://YWVzLTEyOC1nY206cGFzc0BleGFtcGxlLmNvbTo0NDM=#HK']]),
    });
    expect(result.proxyCount).toBe(1);
    expect(result.proxies[0]?.name).toBe('HK');
  });

  it('fails closed when manual mode has no imported bytes', async () => {
    await expect(
      resolveSubscriptionContent(manualSub({ manual_snapshot_meta: undefined }), {
        writeCache: false,
        recordHealth: false,
      }),
    ).rejects.toMatchObject({
      code: 'subscription_manual_snapshot_invalid',
      stage: 'definition',
    });
  });
});
