/**
 * Find and remove redundant duplicate rules.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/dedupe-rules.ts
 *   Commit:             tsx --env-file=.env.local scripts/dedupe-rules.ts --commit
 *
 * "Duplicate" = two or more ENABLED rules that render to the exact same line
 * (`renderRule` output: same type+value+policy+options, or same MATCH+policy).
 * Such a line is decided entirely by its first occurrence, so removing the
 * extras is behaviour-preserving. We keep the earliest-rendered one (by anchor
 * order then rank) and drop the rest.
 *
 * Deliberately NOT touched:
 *   - Disabled/parked rules (enabled===false) — intentionally kept, don't render.
 *   - Conflicts: same type+value but DIFFERENT policy. Clash uses the first
 *     match, so the later ones are dead, but removing one changes intent —
 *     these are reported for you to resolve by hand, never auto-removed.
 *
 * Safety gate: the set of distinct rendered rule lines must be identical before
 * and after. If it isn't, nothing is written.
 */

import { parseBase } from '@/lib/engine/parser';
import { renderRule } from '@/lib/engine/renderer';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase } from '@/lib/repos/baseRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import type { Rule } from '@/schemas';

const isActive = (r: Rule) => r.enabled !== false;

function describe(r: Rule): string {
  return `${renderRule(r)}  [${r.anchor}#${r.rank}${r.note ? ` · ${r.note}` : ''}]`;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== dedupe-rules (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const base = await getBase();
  const anchorOrder = base ? parseBase(base.content).anchors : [];
  const anchorRank = (a: string) => {
    const i = anchorOrder.indexOf(a);
    return i === -1 ? 999 : i;
  };

  const all = await listRules();
  const active = all.filter(isActive);
  console.log(`规则总数 : ${all.length}（生效 ${active.length} / 停用 ${all.length - active.length}）`);

  /* group enabled rules by their rendered line */
  const byLine = new Map<string, Rule[]>();
  for (const r of active) {
    const key = renderRule(r);
    const list = byLine.get(key) ?? [];
    list.push(r);
    byLine.set(key, list);
  }

  /* exact-duplicate groups: keep earliest-rendered, drop the rest */
  const removals: Rule[] = [];
  const dupGroups: { line: string; keep: Rule; drop: Rule[] }[] = [];
  for (const [line, list] of byLine) {
    if (list.length < 2) continue;
    const ordered = [...list].sort(
      (a, b) => anchorRank(a.anchor) - anchorRank(b.anchor) || a.rank - b.rank,
    );
    const [keep, ...drop] = ordered;
    dupGroups.push({ line, keep, drop });
    removals.push(...drop);
  }

  /* conflicts: same type+value among enabled, but >1 distinct policy */
  const byTarget = new Map<string, Map<string, Rule[]>>();
  for (const r of active) {
    if (r.type === 'MATCH') continue;
    const t = `${r.type},${r.value}`;
    const inner = byTarget.get(t) ?? new Map<string, Rule[]>();
    const arr = inner.get(r.policy) ?? [];
    arr.push(r);
    inner.set(r.policy, arr);
    byTarget.set(t, inner);
  }
  const conflicts = [...byTarget.entries()].filter(([, policies]) => policies.size > 1);
  // MATCH conflict (more than one distinct MATCH policy)
  const matchPolicies = new Set(active.filter((r) => r.type === 'MATCH').map((r) => r.policy));

  /* report */
  if (dupGroups.length === 0) {
    console.log('\n✓ 没有发现重复（render-identical 的生效规则）。');
  } else {
    console.log(`\n— 重复组 ${dupGroups.length} 个，将删除 ${removals.length} 条冗余规则 —`);
    for (const g of dupGroups) {
      console.log(`\n  「${g.line}」×${g.drop.length + 1}`);
      console.log(`    保留: ${describe(g.keep)}`);
      for (const d of g.drop) console.log(`    删除: ${describe(d)}`);
    }
  }

  if (conflicts.length || matchPolicies.size > 1) {
    console.log(`\n⚠ 冲突（同 type,value 指向不同策略，clash 只认第一条；不自动改，请手动核对）：`);
    for (const [target, policies] of conflicts) {
      console.log(`    ${target} → ${[...policies.keys()].join(' / ')}`);
    }
    if (matchPolicies.size > 1) {
      console.log(`    MATCH → ${[...matchPolicies].join(' / ')}（应只保留一条 MATCH）`);
    }
  }

  if (removals.length === 0) {
    console.log('\n无需删除。\n');
    return;
  }

  /* safety gate: distinct rendered line set must be unchanged */
  const removeIds = new Set(removals.map((r) => r.id));
  const linesBefore = new Set(active.map(renderRule));
  const linesAfter = new Set(active.filter((r) => !removeIds.has(r.id)).map(renderRule));
  const same =
    linesBefore.size === linesAfter.size && [...linesBefore].every((l) => linesAfter.has(l));
  console.log('\n— 安全校验 —');
  console.log(`去重前不同规则行 : ${linesBefore.size}`);
  console.log(`去重后不同规则行 : ${linesAfter.size}`);
  if (same) {
    console.log('✓ 通过：删除的都是与保留行完全相同的冗余行，下发行为不变。');
  } else {
    console.log('✗ 不一致：会改变下发结果，拒绝删除。');
  }

  if (!commit) {
    console.log(
      same
        ? '\nDRY-RUN 完成，未删除任何数据。确认后加 --commit 执行。\n'
        : '\n⚠ 安全校验未通过，--commit 也会被拒绝。\n',
    );
    return;
  }

  if (!same) throw new Error('安全校验未通过，拒绝写入。');

  const ts = Date.now();
  const redis = getRedis();
  await redis
    .multi()
    .set(`rules:deduped:${ts}`, JSON.stringify(removals))
    .hdel(REDIS_KEYS.rules, ...removeIds)
    .exec();

  console.log('\n✓ COMMIT 完成（原子事务）：');
  console.log(`  删除冗余规则 : ${removals.length} 条（剩余 ${all.length - removals.length}）`);
  console.log(`  备份键       : rules:deduped:${ts}（含被删规则全文，可还原）`);
  console.log('\n撤销方式：从 rules:deduped 读出 JSON，hset 回 rules。\n');
}

main().catch((err) => {
  console.error('\n[dedupe] 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
