/**
 * One-time migration (Phase 2): move the GLOBAL base / rules / proxy-groups /
 * taxonomy into the `default` profile's per-profile scope.
 *
 * Before: a single shared instance under `base:content`, `base:meta`, `rules`,
 *         `proxy-groups`, `taxonomy:groups`.
 * After:  each owned per profile id — `base:content:{id}`, `base:meta:{id}`,
 *         `rules:{id}`, `proxy-groups:{id}`, `taxonomy:groups:{id}` — with the
 *         existing data landing under the `default` profile.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-config-per-profile.ts
 *   Apply:              tsx --env-file=.env.local scripts/migrate-config-per-profile.ts --apply
 *
 * Apply is one atomic transaction:
 *   - backup every legacy value → per-profile-migration:backup:<ts>
 *   - write each legacy value under the default profile's scoped key
 *   - delete the legacy global keys
 *   - bump config:version (invalidate render caches)
 *
 * Idempotent: if the default profile's scoped base already exists, the
 * migration is assumed done and nothing is moved. Requires the `default`
 * profile to exist — run `pnpm init:default-profile` first if it doesn't.
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { DEFAULT_PROFILE_NAME } from '@/schemas';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply') || process.argv.includes('--commit');
  console.log(`\n=== migrate-config-per-profile (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const redis = getRedis();

  const profile = await getProfileByName(DEFAULT_PROFILE_NAME);
  if (!profile) {
    throw new Error(
      `未找到 "${DEFAULT_PROFILE_NAME}" 配置文件;请先运行 \`pnpm init:default-profile\`。`,
    );
  }
  const id = profile.id;
  console.log(`default profile id : ${id}\n`);

  // Already migrated? The scoped base existing means a prior run completed.
  const existingScopedBase = await redis.get<string>(REDIS_KEYS.base.content(id));
  if (existingScopedBase !== null) {
    console.log('default 已有按配置文件存储的 base —— 视为已迁移,退出(幂等)。\n');
    return;
  }

  // Read every legacy global value.
  const [baseContent, baseMeta, rules, proxyGroups, taxonomy] = await Promise.all([
    redis.get<string>(REDIS_KEYS.legacy.baseContent),
    redis.get<unknown>(REDIS_KEYS.legacy.baseMeta),
    redis.hgetall<Record<string, unknown>>(REDIS_KEYS.legacy.rules),
    redis.hgetall<Record<string, unknown>>(REDIS_KEYS.legacy.proxyGroups),
    redis.hgetall<Record<string, unknown>>(REDIS_KEYS.legacy.taxonomyGroups),
  ]);

  const ruleCount = rules ? Object.keys(rules).length : 0;
  const groupCount = proxyGroups ? Object.keys(proxyGroups).length : 0;
  const taxCount = taxonomy ? Object.keys(taxonomy).length : 0;

  console.log('待迁移(全局 → default 作用域):');
  console.log(`  base.content : ${baseContent !== null ? `${baseContent.length} 字节` : '(无)'}`);
  console.log(`  base.meta    : ${baseMeta !== null ? '有' : '(无)'}`);
  console.log(`  rules        : ${ruleCount} 条`);
  console.log(`  proxy-groups : ${groupCount} 个`);
  console.log(`  taxonomy     : ${taxCount} 条`);

  if (baseContent === null && ruleCount === 0 && groupCount === 0 && taxCount === 0) {
    console.log('\n无任何全局数据可迁移(可能是全新部署),退出。\n');
    return;
  }

  if (!apply) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --apply 执行。\n');
    return;
  }

  const ts = Date.now();
  const backupKey = `per-profile-migration:backup:${ts}`;
  const backup = JSON.stringify({ baseContent, baseMeta, rules, proxyGroups, taxonomy });

  const tx = redis.multi();
  tx.set(backupKey, backup);
  // Write scoped copies.
  if (baseContent !== null) tx.set(REDIS_KEYS.base.content(id), baseContent);
  if (baseMeta !== null) tx.set(REDIS_KEYS.base.meta(id), baseMeta);
  if (ruleCount > 0) tx.hset(REDIS_KEYS.rules(id), rules!);
  if (groupCount > 0) tx.hset(REDIS_KEYS.proxyGroups(id), proxyGroups!);
  if (taxCount > 0) tx.hset(REDIS_KEYS.taxonomy.groups(id), taxonomy!);
  // Remove the legacy globals.
  tx.del(REDIS_KEYS.legacy.baseContent);
  tx.del(REDIS_KEYS.legacy.baseMeta);
  tx.del(REDIS_KEYS.legacy.rules);
  tx.del(REDIS_KEYS.legacy.proxyGroups);
  tx.del(REDIS_KEYS.legacy.taxonomyGroups);
  // Invalidate render caches.
  tx.incr(REDIS_KEYS.configVersion);
  await tx.exec();

  console.log('\n✓ APPLY 完成:');
  console.log(`  备份键 : ${backupKey}`);
  console.log('\n撤销: 从备份键还原全局键(再删 default 作用域键):');
  console.log(`  GET ${backupKey} → 逐项还原 base:content / base:meta / rules / proxy-groups / taxonomy:groups\n`);
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
