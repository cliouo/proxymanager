import { createHash, timingSafeEqual } from 'node:crypto';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import {
  MAX_SUBSCRIPTION_CONTENT,
  SubscriptionManualSnapshotMetaSchema,
  type Subscription,
  type SubscriptionManualSnapshotMeta,
} from '@/schemas';

export type ManualSnapshotIntegrityCode =
  | 'metadata-missing'
  | 'snapshot-missing'
  | 'snapshot-not-string'
  | 'snapshot-too-large'
  | 'checksum-mismatch';
const VERBATIM_PREFIX = 'proxymanager-manual-snapshot-v1:';
const READ_VERBATIM_LUA = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
return ARGV[1] .. value
`;

/** Internal typed failure; the raw value, key and checksum never enter its message. */
export class ManualSnapshotIntegrityError extends Error {
  constructor(public readonly code: ManualSnapshotIntegrityCode) {
    super('Manual subscription snapshot is unavailable.');
    this.name = 'ManualSnapshotIntegrityError';
  }
}

export function parseSubscriptionManualSnapshotMeta(
  subscription: Pick<Subscription, 'manual_snapshot_meta'>,
): SubscriptionManualSnapshotMeta | null {
  const parsed = SubscriptionManualSnapshotMetaSchema.safeParse(subscription.manual_snapshot_meta);
  return parsed.success ? parsed.data : null;
}

/**
 * Read and checksum the separate raw snapshot. This repository deliberately
 * owns no write API: definition metadata and raw bytes can change only in the
 * subscription Lua CAS.
 */
export async function readVerifiedSubscriptionManualSnapshot(
  subscription: Pick<Subscription, 'id' | 'manual_snapshot_meta'>,
): Promise<string> {
  const meta = parseSubscriptionManualSnapshotMeta(subscription);
  if (!meta) throw new ManualSnapshotIntegrityError('metadata-missing');

  const encoded = (await getRedis().eval(
    READ_VERBATIM_LUA,
    [REDIS_KEYS.subscriptionManualSnapshot(subscription.id)],
    [VERBATIM_PREFIX],
  )) as unknown;
  if (encoded === null) throw new ManualSnapshotIntegrityError('snapshot-missing');
  if (typeof encoded !== 'string' || !encoded.startsWith(VERBATIM_PREFIX)) {
    throw new ManualSnapshotIntegrityError('snapshot-not-string');
  }
  const stored = encoded.slice(VERBATIM_PREFIX.length);
  if (Buffer.byteLength(stored, 'utf8') > MAX_SUBSCRIPTION_CONTENT) {
    throw new ManualSnapshotIntegrityError('snapshot-too-large');
  }

  const observed = createHash('sha256').update(stored, 'utf8').digest();
  const expected = Buffer.from(meta.content_sha256, 'hex');
  if (expected.byteLength !== observed.byteLength || !timingSafeEqual(expected, observed)) {
    throw new ManualSnapshotIntegrityError('checksum-mismatch');
  }
  return stored;
}
