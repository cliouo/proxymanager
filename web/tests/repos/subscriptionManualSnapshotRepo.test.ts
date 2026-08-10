import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { Subscription } from '@/schemas';

const VERBATIM_PREFIX = 'proxymanager-manual-snapshot-v1:';
const redis = vi.hoisted(() => ({
  eval: vi.fn(async () => null as unknown),
}));

vi.mock('@/lib/redis/client', () => ({ getRedis: () => redis }));

import {
  ManualSnapshotIntegrityError,
  readVerifiedSubscriptionManualSnapshot,
} from '@/lib/repos/subscriptionManualSnapshotRepo';

const ID = '11111111-1111-4111-8111-111111111111';
const CONTENT =
  'proxies:\n  - { name: HK, type: ss, server: h, port: 1, cipher: aes-128-gcm, password: p }\n';

function checksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function manual(over: Partial<Subscription> = {}): Subscription {
  return {
    id: ID,
    name: 'airport-a',
    enabled: true,
    kind: 'remote',
    url: 'https://upstream.example/sub',
    ttl_ms: 60_000,
    tags: [],
    operators: [],
    refresh_mode: 'manual',
    fetch_identity_revision: 3,
    manual_snapshot_meta: {
      updated_at: 10,
      proxy_count: 1,
      origin: 'web',
      fetch_identity_revision: 3,
      content_sha256: checksum(CONTENT),
    },
    ...over,
  } as Subscription;
}

describe('subscriptionManualSnapshotRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redis.eval.mockResolvedValue(`${VERBATIM_PREFIX}${CONTENT}`);
  });

  it('reads only the dedicated no-TTL snapshot key and verifies the exact bytes', async () => {
    await expect(readVerifiedSubscriptionManualSnapshot(manual())).resolves.toBe(CONTENT);
    expect(redis.eval).toHaveBeenCalledOnce();
    const [script, keys, args] = redis.eval.mock.calls[0] as unknown[];
    expect(keys).toEqual([REDIS_KEYS.subscriptionManualSnapshot(ID)]);
    expect(args).toEqual([VERBATIM_PREFIX]);
    expect(String(script)).not.toContain(CONTENT);
    expect(String(script)).not.toContain('password');
  });

  it.each([
    ['missing metadata', manual({ manual_snapshot_meta: undefined }), null, 'metadata-missing'],
    ['missing value', manual(), null, 'snapshot-missing'],
    ['non-string value', manual(), { proxies: [] }, 'snapshot-not-string'],
    ['checksum mismatch', manual(), `${CONTENT}changed`, 'checksum-mismatch'],
  ])('fails closed for %s without exposing raw bytes', async (_label, sub, stored, code) => {
    redis.eval.mockResolvedValue(
      typeof stored === 'string' ? `${VERBATIM_PREFIX}${stored}` : stored,
    );
    const error = await readVerifiedSubscriptionManualSnapshot(sub).catch((caught) => caught);
    expect(error).toBeInstanceOf(ManualSnapshotIntegrityError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('password');
  });

  it('does not touch Redis when metadata is missing', async () => {
    await expect(
      readVerifiedSubscriptionManualSnapshot(manual({ manual_snapshot_meta: undefined })),
    ).rejects.toMatchObject({ code: 'metadata-missing' });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
