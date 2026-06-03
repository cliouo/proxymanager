/**
 * One-time migration: Profile.subscription_ids (multi-bind) → Profile.source
 * (single-select discriminated union).
 *
 *   subscription_ids = [one]     → source { type: 'subscription', id }
 *   subscription_ids = [] | many → source { type: 'none' }   (unbound — a
 *                                   profile starts bound to nothing; a
 *                                   hand-picked multi set can't be a single
 *                                   source, and the default should be unbound
 *                                   anyway. Logged so a genuine set is visible.)
 *
 * The new ProfileSchema strips the stale `subscription_ids` on read and defaults
 * `source` to `{type:'none'}`. NOTE: this is a behaviour change for a profile
 * that used to inject subs — after this, it injects nothing until you pick a
 * source on /base. That's intended: the default profile is now unbound.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-profile-source.ts
 *   Commit:             tsx --env-file=.env.local scripts/migrate-profile-source.ts --commit
 *
 * Commit is one atomic transaction:
 *   - backup current profiles hash → profiles:source-migration:backup:<ts>
 *   - hset rewritten records
 *   - invalidate resolved snapshot
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import type { ProfileSource } from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface RawProfile {
  id: string;
  name: string;
  subscription_ids?: unknown;
  source?: unknown;
  [k: string]: unknown;
}

function computeSource(ids: string[]): ProfileSource {
  if (ids.length === 1) return { type: 'subscription', id: ids[0] };
  return { type: 'none' };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== migrate-profile-source (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const redis = getRedis();
  const rawAll =
    (await redis.hgetall<Record<string, RawProfile>>(REDIS_KEYS.profiles)) ?? {};
  const entries = Object.entries(rawAll);
  console.log(`profiles 总数 : ${entries.length}`);

  const writes: Record<string, RawProfile> = {};
  for (const [id, raw] of entries) {
    const alreadyMigrated = raw.source !== undefined && raw.subscription_ids === undefined;
    const ids = Array.isArray(raw.subscription_ids)
      ? (raw.subscription_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const source = raw.source && typeof raw.source === 'object'
      ? (raw.source as ProfileSource)
      : computeSource(ids);

    const next: RawProfile = { ...raw, source, updated_at: nowSeconds() };
    delete next.subscription_ids;

    const note =
      ids.length > 1 ? `  (多选 ${ids.length} 条 → none, 默认改为未绑定)` : '';
    console.log(
      `· ${raw.name.padEnd(12)} subscription_ids=[${ids.length}] → source=${JSON.stringify(source)}${alreadyMigrated ? '  (已迁移, 跳过)' : note}`,
    );
    if (!alreadyMigrated) writes[id] = next;
  }

  console.log(`\n— 待写入 (${Object.keys(writes).length} / ${entries.length}) —`);

  if (!commit) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --commit 执行。\n');
    return;
  }
  if (Object.keys(writes).length === 0) {
    console.log('\n无可改项,退出。\n');
    return;
  }

  const ts = Date.now();
  const tx = redis.multi();
  tx.set(`profiles:source-migration:backup:${ts}`, JSON.stringify(rawAll));
  tx.hset(REDIS_KEYS.profiles, writes);
  await tx.exec();
  await invalidateResolvedSnapshot().catch(() => undefined);

  console.log('\n✓ COMMIT 完成:');
  console.log(`  改记录数 : ${Object.keys(writes).length}`);
  console.log(`  备份键   : profiles:source-migration:backup:${ts}`);
  console.log('\n撤销: 从备份键还原 profiles hash:');
  console.log(`  GET profiles:source-migration:backup:${ts} → 逐条 hset profiles <id> <json>\n`);
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
