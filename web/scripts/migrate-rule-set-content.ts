/**
 * One-time migration: split rule-set `content` out of the `rule-sets` hash
 * into standalone `rule-set-content:{id}` keys.
 *
 * Why: listRuleSets() HGETALLs the hash on every render, but rendering only
 * needs the meta fields (name/behavior/format/url/interval/proxy/source) to
 * emit `rule-providers:` declarations — the embedded bodies (potentially
 * thousands of lines each for local rule-sets) were pure wasted transfer.
 *
 * After the split:
 *   - hash field             → meta record with content stored as ''
 *   - rule-set-content:{id}  → the full body
 *
 * The read path falls back to the legacy embedded content for unmigrated
 * fields, so running this is an optimisation, not a correctness requirement.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-rule-set-content.ts
 *   Apply:              tsx --env-file=.env.local scripts/migrate-rule-set-content.ts --apply
 *
 * Apply is one atomic transaction:
 *   - backup the original hash values being rewritten → rule-sets:content-migration:backup:<ts>
 *   - SET rule-set-content:{id} for fields whose content key is still missing
 *     (an existing content key is authoritative and is never overwritten)
 *   - HSET the slimmed meta records (content '')
 *   - INCR config:version (render cache invalidation)
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import type { RuleSet } from '@/schemas';

interface PlanItem {
  set: RuleSet;
  /** Bytes of the embedded legacy content about to be moved/stripped. */
  bytes: number;
  /** A standalone content key already exists (then it's authoritative). */
  hasContentKey: boolean;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`\n=== migrate-rule-set-content (${apply ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  const redis = getRedis();
  const all = (await redis.hgetall<Record<string, RuleSet>>(REDIS_KEYS.ruleSets)) ?? {};
  const entries = Object.values(all);
  console.log(`rule-sets 总数 : ${entries.length}`);

  const plan: PlanItem[] = [];
  for (const set of entries) {
    const stored = await redis.get<string>(REDIS_KEYS.ruleSetContent(set.id));
    const embedded = set.content ?? '';
    const hasContentKey = stored !== null;
    // Already in the new shape: content key present AND hash value slim.
    if (hasContentKey && embedded === '') continue;
    plan.push({ set, bytes: Buffer.byteLength(embedded, 'utf8'), hasContentKey });
  }

  console.log(`待迁移        : ${plan.length}\n`);
  for (const p of plan) {
    const lines = (p.set.content ?? '') === '' ? 0 : (p.set.content as string).split('\n').length;
    console.log(
      `· ${p.set.id}  ${(p.set.name ?? '?').padEnd(24)} source=${(p.set.source ?? 'local').padEnd(6)} ` +
        `embedded=${String(p.bytes).padStart(8)} B (${lines} 行)` +
        (p.hasContentKey ? '  [content key 已存在,仅瘦身 hash]' : ''),
    );
  }
  const totalBytes = plan.reduce((sum, p) => sum + p.bytes, 0);
  console.log(`\n内嵌 content 合计 : ${totalBytes} B`);

  if (!apply) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --apply 执行。\n');
    return;
  }
  if (plan.length === 0) {
    console.log('\n无可迁移项,退出。\n');
    return;
  }

  const ts = Date.now();
  const backupKey = `${REDIS_KEYS.ruleSets}:content-migration:backup:${ts}`;
  const tx = redis.multi();
  // Backup the exact hash values we're about to rewrite (full legacy records).
  tx.hset(backupKey, Object.fromEntries(plan.map((p) => [p.set.id, p.set])));
  for (const p of plan) {
    if (!p.hasContentKey) {
      tx.set(REDIS_KEYS.ruleSetContent(p.set.id), p.set.content ?? '');
    }
    tx.hset(REDIS_KEYS.ruleSets, { [p.set.id]: { ...p.set, content: '' } });
  }
  tx.incr(REDIS_KEYS.configVersion);
  await tx.exec();

  console.log('\n✓ APPLY 完成:');
  console.log(`  迁移记录数 : ${plan.length}`);
  console.log(`  备份键     : ${backupKey}`);
  console.log('\n撤销: 从备份键还原 rule-sets hash(并删除对应 rule-set-content:{id}):');
  console.log(`  HGETALL ${backupKey} → 逐条 hset rule-sets <id> <json>\n`);
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
