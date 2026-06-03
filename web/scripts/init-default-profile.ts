/**
 * One-time migration: seed the `default` Profile record so per-profile
 * subscription binding starts working.
 *
 *   - Skips when a profile named "default" already exists.
 *   - Seeds the default profile unbound (`source: { type: 'none' }`); the user
 *     picks a single sub or a 聚合订阅 via the UI before anything is injected.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/init-default-profile.ts
 *   Commit:             tsx --env-file=.env.local scripts/init-default-profile.ts --commit
 *
 * Commit writes a single Redis hset + a JSON backup of any pre-existing
 * `profiles` hash (almost always empty, but recorded for symmetry).
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_SOURCE, type Profile } from '@/schemas';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== init-default-profile (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const redis = getRedis();
  const existing = await redis.hgetall<Record<string, unknown>>(REDIS_KEYS.profiles);
  const existingCount = existing ? Object.keys(existing).length : 0;
  console.log(`profiles hash 现有记录    : ${existingCount}`);

  if (existing) {
    for (const raw of Object.values(existing)) {
      const obj = raw as { name?: string };
      if (obj?.name === DEFAULT_PROFILE_NAME) {
        console.log(`\n⚠ 已存在 name="${DEFAULT_PROFILE_NAME}" 的 profile,跳过(无操作)。\n`);
        return;
      }
    }
  }

  const subs = await listSubscriptions();
  const enabledCount = subs.filter((s) => s.enabled).length;
  console.log(`订阅源总数               : ${subs.length}`);
  console.log(`其中 enabled            : ${enabledCount}`);
  console.log(`将绑定 source           : ${JSON.stringify(DEFAULT_PROFILE_SOURCE)} (未绑定)`);

  const now = nowSeconds();
  const profile: Profile = {
    id: crypto.randomUUID(),
    name: DEFAULT_PROFILE_NAME,
    source: DEFAULT_PROFILE_SOURCE,
    created_at: now,
    updated_at: now,
  };
  console.log(`\n— 新建 profile —`);
  console.log(`  id     : ${profile.id}`);
  console.log(`  name   : ${profile.name}`);
  console.log(`  source : ${JSON.stringify(profile.source)}`);

  if (!commit) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --commit 执行。\n');
    return;
  }

  const ts = Date.now();
  const tx = redis.multi();
  if (existing && existingCount > 0) {
    tx.set(`profiles:init:backup:${ts}`, JSON.stringify(existing));
  }
  tx.hset(REDIS_KEYS.profiles, { [profile.id]: profile });
  await tx.exec();
  await invalidateResolvedSnapshot().catch(() => undefined);

  console.log('\n✓ COMMIT 完成:');
  console.log(`  profile id  : ${profile.id}`);
  console.log(`  source      : ${JSON.stringify(profile.source)}`);
  if (existing && existingCount > 0) {
    console.log(`  pre-existing 备份键: profiles:init:backup:${ts}`);
  }
  console.log(`\n撤销:hdel profiles ${profile.id}(或 del profiles 整个 hash 回到 pre-migration)。\n`);
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
