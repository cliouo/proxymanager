/**
 * One-time migration: re-categorise every proxy-group under the new
 * 5-form-shape taxonomy + auto-fill `section` from a rule reverse-lookup.
 *
 *   `kind` (5 values) encodes **form** — how members are sourced.
 *   `section` (free text) encodes **用途** — who the group serves.
 *
 * The two axes used to be conflated in an 8-way kind enum; the schema now
 * preprocesses legacy values into the new 5, but the source-of-truth in
 * Redis is still on old values until this script rewrites it.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/recategorize-proxy-groups.ts
 *   Commit:             tsx --env-file=.env.local scripts/recategorize-proxy-groups.ts --commit
 *
 * Commit is one atomic Redis transaction:
 *   - backup current proxy-groups hash → proxy-groups:recat:backup:<ts>
 *   - hset the updated groups (kind/section/updated_at touched)
 *   - invalidate resolved snapshot
 *
 * `kind` rules (priority top-to-bottom):
 *   bound_subscription_id          → 'single-sub'
 *   include-all-* with filter      → 'filter'
 *   include-all-* without filter   → 'all'
 *   proxies non-empty              → 'manual'
 *   else                           → 'raw'
 *
 * `section` rules (priority):
 *   kind=single-sub                                 → '订阅'
 *   name in SYSTEM_NAMES                            → '系统'
 *   targeted by RULE-SET rule policy                → '规则集'
 *   targeted by MATCH rule policy                   → '系统'
 *   kind=filter + filter regex looks regional       → '地区'
 *   kind=all                                        → '入口'
 *   else                                            → '' (leave blank; user fills)
 */

import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import type { ProxyGroup } from '@/schemas';

const SYSTEM_NAMES = new Set([
  '默认', 'dns', 'DNS', 'DNS出口', '国内', '全球直连', '直连',
  '兜底', '其它', '其他', '漏网之鱼',
  'fallback', 'FALLBACK', 'final', 'FINAL',
]);

const REGION_FILTER_HINT =
  /\b(HK|JP|TW|US|SG|DE|UK|KR|FR|CA|AU)\b|港|日|台|美|新|德|英|韩|法|加拿大|澳/i;

type NewKind = 'raw' | 'manual' | 'filter' | 'all' | 'single-sub';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function computeKind(g: ProxyGroup): NewKind {
  if (g.bound_subscription_id) return 'single-sub';
  const includeAll = !!(g['include-all-proxies'] || g['include-all'] || g['include-all-providers']);
  const hasFilter = typeof g.filter === 'string' && g.filter.trim() !== '';
  if (includeAll && hasFilter) return 'filter';
  if (includeAll) return 'all';
  if (Array.isArray(g.proxies) && g.proxies.length > 0) return 'manual';
  return 'raw';
}

function computeSection(
  g: ProxyGroup,
  newKind: NewKind,
  ruleSetTargets: Set<string>,
  matchTargets: Set<string>,
): string {
  if (newKind === 'single-sub') return '订阅';
  if (SYSTEM_NAMES.has(g.name)) return '系统';
  if (ruleSetTargets.has(g.name)) return '规则集';
  if (matchTargets.has(g.name)) return '系统';
  if (newKind === 'filter' && typeof g.filter === 'string' && REGION_FILTER_HINT.test(g.filter)) {
    return '地区';
  }
  if (newKind === 'all') return '入口';
  return g.section?.trim() ?? '';
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== recategorize-proxy-groups (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const [groups, rules] = await Promise.all([listProxyGroups(), listRules()]);
  console.log(`策略组总数 : ${groups.length}`);
  console.log(`规则总数   : ${rules.length}`);

  const ruleSetTargets = new Set(
    rules.filter((r) => r.type === 'RULE-SET').map((r) => r.policy),
  );
  const matchTargets = new Set(
    rules.filter((r) => r.type === 'MATCH').map((r) => r.policy),
  );
  console.log(`被 RULE-SET 指向 : ${ruleSetTargets.size} 个组名`);
  console.log(`被 MATCH 指向    : ${matchTargets.size} 个组名`);

  interface Plan {
    g: ProxyGroup;
    newKind: NewKind;
    newSection: string;
    kindChanged: boolean;
    sectionChanged: boolean;
  }
  const plan: Plan[] = groups.map((g) => {
    const newKind = computeKind(g);
    const newSection = computeSection(g, newKind, ruleSetTargets, matchTargets);
    return {
      g,
      newKind,
      newSection,
      kindChanged: g.kind !== newKind,
      sectionChanged: (g.section?.trim() ?? '') !== newSection,
    };
  });

  const toWrite = plan.filter((p) => p.kindChanged || p.sectionChanged);
  console.log(`\n— 改动 (${toWrite.length} / ${groups.length}) —`);
  console.log(
    `${'name'.padEnd(14)} ${'kind 旧→新'.padEnd(28)} ${'section 旧→新'}`,
  );
  for (const p of plan) {
    const kCol = p.kindChanged ? `${p.g.kind.padEnd(12)} → ${p.newKind}` : `${p.newKind} (unchanged)`;
    const sOld = p.g.section?.trim() ?? '';
    const sCol = p.sectionChanged ? `"${sOld}" → "${p.newSection}"` : `"${p.newSection}" (unchanged)`;
    const mark = p.kindChanged || p.sectionChanged ? '·' : ' ';
    console.log(`${mark} ${p.g.name.padEnd(14)} ${kCol.padEnd(28)} ${sCol}`);
  }

  // Section distribution preview
  const sectionCounts = new Map<string, number>();
  for (const p of plan) {
    const key = p.newSection || '(空)';
    sectionCounts.set(key, (sectionCounts.get(key) ?? 0) + 1);
  }
  const kindCounts = new Map<NewKind, number>();
  for (const p of plan) kindCounts.set(p.newKind, (kindCounts.get(p.newKind) ?? 0) + 1);
  console.log('\n— 重映射后分布 —');
  console.log('  by kind   :');
  for (const [k, n] of kindCounts) console.log(`    ${k.padEnd(12)} ${n}`);
  console.log('  by section:');
  for (const [s, n] of sectionCounts) console.log(`    ${s.padEnd(8)} ${n}`);

  if (!commit) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --commit 执行。\n');
    return;
  }

  if (toWrite.length === 0) {
    console.log('\n无可改项,退出。\n');
    return;
  }

  const redis = getRedis();
  const ts = Date.now();

  // Read the raw hash to back up everything (atomic snapshot for rollback).
  const rawAll = await redis.hgetall<Record<string, unknown>>(REDIS_KEYS.proxyGroups);

  // Build the writes (only touched groups; preserve other fields).
  const writes: Record<string, ProxyGroup> = {};
  const now = nowSeconds();
  for (const p of toWrite) {
    writes[p.g.id] = {
      ...p.g,
      kind: p.newKind,
      section: p.newSection || undefined,
      updated_at: now,
    };
  }

  const tx = redis.multi();
  tx.set(`proxy-groups:recat:backup:${ts}`, JSON.stringify(rawAll ?? {}));
  tx.hset(REDIS_KEYS.proxyGroups, writes);
  await tx.exec();
  await invalidateResolvedSnapshot().catch(() => undefined);

  console.log('\n✓ COMMIT 完成:');
  console.log(`  改组数         : ${toWrite.length}`);
  console.log(`  备份键         : proxy-groups:recat:backup:${ts}`);
  console.log(
    '\n撤销:从备份键还原整个 proxy-groups hash:',
  );
  console.log(
    `  redis-cli GET proxy-groups:recat:backup:${ts} | tee /tmp/restore.json && cat /tmp/restore.json | jq -r 'to_entries[] | "\\"\\(.key)\\" \\(.value)"' | xargs -L1 hset proxy-groups`,
  );
  console.log('  (或自行回写 hset proxy-groups <id> <json>)\n');
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
