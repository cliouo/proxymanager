/**
 * One-time migration for the slug + node_prefix model change:
 *
 *   1. Collections: backfill the now-required `slug` (used in the public link
 *      path /api/sub/{token}/collection/{slug}) on every collection that lacks
 *      a non-empty one. Derived from `name`: lowercased, every run of non
 *      [a-z0-9] chars → '-', leading/trailing '-' trimmed. If that yields an
 *      empty string (e.g. a pure-CJK name) or collides with an already-used
 *      slug, fall back to `col-<first 8 chars of the collection id>`.
 *      Uniqueness is enforced across the whole batch (existing slugs + the ones
 *      this run mints). Collections that already have a slug are left untouched.
 *
 *   2. Subscriptions: strip the dead `node_prefix` key (removed from the model;
 *      ignored on read, but this cleans the stored data).
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-collection-slug.ts
 *   Apply:              tsx --env-file=.env.local scripts/migrate-collection-slug.ts --apply
 *
 * Apply is one atomic transaction:
 *   - backup the prior collections + subscriptions hashes (JSON) →
 *     backup:migrate-collection-slug:<ts>
 *   - HSET the rewritten collection records (slug backfilled)
 *   - HSET the rewritten subscription records (node_prefix stripped)
 *   - INCR config:version (render cache invalidation)
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

interface RawCollection {
  id: string;
  name?: string;
  slug?: unknown;
  [k: string]: unknown;
}

interface RawSubscription {
  id?: string;
  name?: string;
  node_prefix?: unknown;
  [k: string]: unknown;
}

/**
 * name → kebab slug, or '' when nothing usable survives. A "usable" slug needs
 * at least 2 chars and at least one letter — a name like "聚合订阅1" kebabs down
 * to the bare digit "1", which is a poor public-link segment, so we treat such
 * degenerate results as empty and let the caller fall back to `col-<id>`.
 */
function slugifyName(name: string): string {
  const kebab = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (kebab.length < 2 || !/[a-z]/.test(kebab)) return '';
  return kebab;
}

function fallbackSlug(id: string): string {
  return `col-${id.slice(0, 8)}`;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`\n=== migrate-collection-slug (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const redis = getRedis();
  const collections =
    (await redis.hgetall<Record<string, RawCollection>>(REDIS_KEYS.collections)) ?? {};
  const subscriptions =
    (await redis.hgetall<Record<string, RawSubscription>>(REDIS_KEYS.subscriptions)) ?? {};

  const colEntries = Object.entries(collections);
  const subEntries = Object.entries(subscriptions);
  console.log(`collections 总数   : ${colEntries.length}`);
  console.log(`subscriptions 总数 : ${subEntries.length}\n`);

  // --- Collections: backfill slug -----------------------------------------
  // Seed the used-slug set with every slug already present so newly minted
  // slugs never collide with an existing one.
  const usedSlugs = new Set<string>();
  for (const [, raw] of colEntries) {
    if (typeof raw.slug === 'string' && raw.slug.trim() !== '') usedSlugs.add(raw.slug);
  }

  const collectionWrites: Record<string, RawCollection> = {};
  for (const [id, raw] of colEntries) {
    if (typeof raw.slug === 'string' && raw.slug.trim() !== '') {
      console.log(`· col ${(raw.name ?? '?').padEnd(16)} slug=${raw.slug}  (已有, 跳过)`);
      continue;
    }
    const derived = slugifyName(raw.name ?? '');
    let slug = derived;
    let usedFallback = false;
    if (slug === '' || usedSlugs.has(slug)) {
      slug = fallbackSlug(id);
      usedFallback = true;
      // In the (astronomically unlikely) event the fallback also collides,
      // suffix until unique.
      let n = 1;
      while (usedSlugs.has(slug)) slug = `${fallbackSlug(id)}-${n++}`;
    }
    usedSlugs.add(slug);
    collectionWrites[id] = { ...raw, slug };
    const reason = usedFallback
      ? derived === ''
        ? '(name 无可用字符 → fallback)'
        : `(派生 "${derived}" 冲突 → fallback)`
      : '';
    console.log(`· col ${(raw.name ?? '?').padEnd(16)} (空) → slug=${slug}  ${reason}`);
  }

  // --- Subscriptions: strip node_prefix -----------------------------------
  const subscriptionWrites: Record<string, RawSubscription> = {};
  for (const [id, raw] of subEntries) {
    if (!('node_prefix' in raw)) continue;
    const next: RawSubscription = { ...raw };
    delete next.node_prefix;
    subscriptionWrites[id] = next;
    console.log(
      `· sub ${(raw.name ?? '?').padEnd(16)} 删除 node_prefix=${JSON.stringify(raw.node_prefix)}`,
    );
  }

  console.log(
    `\n— 待写入 — collections: ${Object.keys(collectionWrites).length} / ${colEntries.length}` +
      `, subscriptions(去 node_prefix): ${Object.keys(subscriptionWrites).length} / ${subEntries.length}`,
  );

  if (!apply) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --apply 执行。\n');
    return;
  }
  if (Object.keys(collectionWrites).length === 0 && Object.keys(subscriptionWrites).length === 0) {
    console.log('\n无可改项,退出。\n');
    return;
  }

  const ts = Date.now();
  const backupKey = `backup:migrate-collection-slug:${ts}`;
  const tx = redis.multi();
  tx.set(backupKey, JSON.stringify({ collections, subscriptions }));
  if (Object.keys(collectionWrites).length > 0) {
    tx.hset(REDIS_KEYS.collections, collectionWrites);
  }
  if (Object.keys(subscriptionWrites).length > 0) {
    tx.hset(REDIS_KEYS.subscriptions, subscriptionWrites);
  }
  tx.incr(REDIS_KEYS.configVersion);
  await tx.exec();

  console.log('\n✓ APPLY 完成:');
  console.log(`  回填 slug 的 collections : ${Object.keys(collectionWrites).length}`);
  console.log(`  去 node_prefix 的 subs   : ${Object.keys(subscriptionWrites).length}`);
  console.log(`  备份键                   : ${backupKey}`);
  console.log('\n撤销: 从备份键还原两个 hash:');
  console.log(
    `  GET ${backupKey} → {collections, subscriptions} → 逐条 hset 各 hash <id> <json>\n`,
  );
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
