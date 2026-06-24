/**
 * One-time migration: move every literal rule out of base.yaml's `rules:` block
 * and into the `rules` hash, leaving the block with nothing but anchor markers.
 *
 * After this, the project manages ALL rules (static hand-written ones too), and
 * the skeleton editor's `rules:` block is purely structural — see
 * CONFIG-MODEL-REFACTOR.md.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-rules-into-hash.ts
 *   Commit:             tsx --env-file=.env.local scripts/migrate-rules-into-hash.ts --commit
 *
 * Dry-run reads Redis, computes the full plan, runs the render-equivalence
 * check, and prints everything. It writes NOTHING. Commit additionally:
 *   1. backs up base:content / base:meta to timestamped keys,
 *   2. records the migrated rule ids (for scripted undo),
 *   3. upserts the new rules + rewrites base:content,
 * all in a single atomic Redis transaction — and only if the equivalence
 * check passes.
 *
 * Anchor assignment (preserves rendered rule order exactly):
 *   - every literal rule BEFORE the pivot marker (`manual`) → `prelude`
 *   - every literal rule AT/AFTER the pivot marker          → `late`
 *   - MATCH always gets the maximum rank in its anchor (renders last)
 * The 62 existing hash rules at `manual` are never touched.
 */

import { parseBase } from '@/lib/engine/parser';
import { renderBase } from '@/lib/engine/renderer';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase, type BaseMeta } from '@/lib/repos/baseRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { computeEtag } from '@/lib/services/baseService';
import { ensureValidAnchorAndPolicy, generateRuleId, nowSeconds } from '@/lib/services/rulesService';
import { RuleTypeSchema, type Rule } from '@/schemas';

const PIVOT_ANCHOR = 'manual'; // anchor already populated in the hash
const MATCH_RANK = 1_000_000; // forces MATCH to render last within its anchor
const RANK_STEP = 10;

const ANCHOR_MARKER = /^#\s*===\s*ANCHOR:\s*([\w-]+)\s*===\s*$/;
const PARKED_RULE = /^#\s*-\s+(.+)$/; // commented-out list item: `# - DOMAIN,...`
const ACTIVE_RULE = /^-\s+(.+)$/; // active list item: `- DOMAIN,...`

interface ParsedExpr {
  type: Rule['type'];
  value: string;
  policy: string;
  options: string[];
}

type LineKind = 'anchor-marker' | 'active-rule' | 'parked-rule' | 'dropped-comment' | 'blank';

interface Classified {
  raw: string;
  kind: LineKind;
  marker?: string;
  expr?: string;
  parsed?: ParsedExpr;
  anchor?: string;
  parseError?: string;
  /** Nearest preceding section-header comment, captured into the rule's note. */
  section?: string;
}

/* ─── rule expression parsing ───────────────────────────────────────── */

function parseExpr(expr: string): { ok: true; value: ParsedExpr } | { ok: false; error: string } {
  const parts = expr.split(',').map((s) => s.trim());
  if (parts[0] === 'MATCH') {
    if (parts.length < 2 || !parts[1]) return { ok: false, error: 'MATCH 缺少策略' };
    return { ok: true, value: { type: 'MATCH', value: '', policy: parts[1], options: [] } };
  }
  if (parts.length < 3) return { ok: false, error: `规则段数不足（${expr}）` };
  const [type, value, policy, ...options] = parts;
  if (!RuleTypeSchema.safeParse(type).success) return { ok: false, error: `未知规则类型 "${type}"` };
  if (!value) return { ok: false, error: `规则缺少 value（${expr}）` };
  if (!policy) return { ok: false, error: `规则缺少 policy（${expr}）` };
  return { ok: true, value: { type: type as Rule['type'], value, policy, options } };
}

/* ─── locate the top-level `rules:` block (line-based) ──────────────── */

function locateRulesBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    const blank = line.trim() === '';
    const indented = /^\s/.test(line);
    if (blank || indented) {
      end += 1;
      continue;
    }
    break; // first col-0 non-blank line ends the block
  }
  return { start, end };
}

/** Indentation to use for the rewritten anchor markers (match existing ones). */
function detectMarkerIndent(blockLines: string[]): string {
  for (const line of blockLines) {
    if (ANCHOR_MARKER.test(line.trim())) {
      const m = line.match(/^(\s*)/);
      return m ? m[1] : '  ';
    }
  }
  return '  ';
}

/* ─── extract the ordered rule expressions from a rendered config ───── */

function renderedRuleExprs(content: string, rules: Rule[]): string[] {
  const rendered = renderBase(content, rules).content;
  const lines = rendered.split('\n');
  const block = locateRulesBlock(lines);
  if (!block) return [];
  const out: string[] = [];
  for (let i = block.start + 1; i < block.end; i++) {
    const trimmed = lines[i].trim();
    const m = trimmed.match(ACTIVE_RULE);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/* ─── main ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== migrate-rules-into-hash (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const defaultProfile = await getProfileByName('default');
  if (!defaultProfile) throw new Error('default profile missing — run `pnpm init:default-profile` first');
  const profileId = defaultProfile.id;

  const base = await getBase(profileId);
  if (!base) throw new Error('base:content 不存在，无法迁移。');
  const oldContent = base.content;
  const oldMeta: BaseMeta = {
    etag: base.etag,
    anchors: base.anchors,
    policies: base.policies,
    updated_at: base.updated_at,
  };
  const existingRules = await listRules(profileId);
  console.log(`base.etag        : ${oldMeta.etag}`);
  console.log(`hash 现有规则    : ${existingRules.length} 条`);

  const lines = oldContent.split('\n');
  const block = locateRulesBlock(lines);
  if (!block) throw new Error('未找到顶层 `rules:` 块。');
  const blockLines = lines.slice(block.start + 1, block.end);

  const parsed = parseBase(oldContent);
  const markers = blockLines
    .map((l) => l.trim().match(ANCHOR_MARKER)?.[1])
    .filter((m): m is string => !!m);
  if (!markers.includes(PIVOT_ANCHOR)) {
    throw new Error(`rules: 块缺少枢轴锚点标记 "${PIVOT_ANCHOR}"，结构与预期不符，已中止。`);
  }
  const firstAnchor = markers[0];
  const lastAnchor = markers[markers.length - 1];
  console.log(`锚点标记         : ${markers.join(' → ')}`);
  console.log(`枢轴             : ${PIVOT_ANCHOR}（其前→${firstAnchor}，其后→${lastAnchor}）\n`);

  /* classify every block line, assigning anchors via the pivot flip */
  const classified: Classified[] = [];
  let passedPivot = false;
  let section: string | null = null; // nearest preceding section-header comment
  for (const raw of blockLines) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      classified.push({ raw, kind: 'blank' });
      continue;
    }
    const markerMatch = trimmed.match(ANCHOR_MARKER);
    if (markerMatch) {
      classified.push({ raw, kind: 'anchor-marker', marker: markerMatch[1] });
      if (markerMatch[1] === PIVOT_ANCHOR) passedPivot = true;
      section = null; // sections don't cross anchor boundaries
      continue;
    }
    const anchor = passedPivot ? lastAnchor : firstAnchor;
    const parkedMatch = trimmed.match(PARKED_RULE);
    if (parkedMatch) {
      const pe = parseExpr(parkedMatch[1].trim());
      if (pe.ok) {
        classified.push({
          raw,
          kind: 'parked-rule',
          expr: parkedMatch[1].trim(),
          parsed: pe.value,
          anchor,
          ...(section ? { section } : {}),
        });
      } else {
        section = parkedMatch[1].trim(); // not a rule → treat as a header
        classified.push({ raw, kind: 'dropped-comment' });
      }
      continue;
    }
    if (trimmed.startsWith('#')) {
      section = trimmed.replace(/^#\s*/, '').trim();
      classified.push({ raw, kind: 'dropped-comment' });
      continue;
    }
    const activeMatch = trimmed.match(ACTIVE_RULE);
    if (activeMatch) {
      const pe = parseExpr(activeMatch[1].trim());
      classified.push(
        pe.ok
          ? {
              raw,
              kind: 'active-rule',
              expr: activeMatch[1].trim(),
              parsed: pe.value,
              anchor,
              ...(section ? { section } : {}),
            }
          : { raw, kind: 'active-rule', expr: activeMatch[1].trim(), anchor, parseError: pe.error },
      );
      continue;
    }
    classified.push({ raw, kind: 'dropped-comment' }); // unrecognised line, surfaced loudly
  }

  /* build the new rules, ranks per anchor in encounter order */
  const rankByAnchor = new Map<string, number>();
  const nextRank = (anchor: string): number => {
    const r = (rankByAnchor.get(anchor) ?? 0) + RANK_STEP;
    rankByAnchor.set(anchor, r);
    return r;
  };
  const now = nowSeconds();
  const newRules: Rule[] = [];
  const parseErrors: string[] = [];
  const validationErrors: string[] = [];

  for (const c of classified) {
    if (c.parseError) {
      parseErrors.push(`无法解析：${c.raw.trim()} — ${c.parseError}`);
      continue;
    }
    if ((c.kind !== 'active-rule' && c.kind !== 'parked-rule') || !c.parsed || !c.anchor) continue;
    const p = c.parsed;
    const rank = p.type === 'MATCH' ? MATCH_RANK : nextRank(c.anchor);
    const origin = c.kind === 'parked-rule' ? '迁移自 base.yaml（原注释，已停用）' : '迁移自 base.yaml 静态规则';
    const note = c.section ? `${origin} · ${c.section}` : origin;
    const rule: Rule = {
      id: generateRuleId(),
      anchor: c.anchor,
      type: p.type,
      value: p.value,
      policy: p.policy,
      rank,
      source: 'import',
      added_at: now,
      updated_at: now,
      note,
      ...(p.options.length ? { options: p.options } : {}),
      ...(c.kind === 'parked-rule' ? { enabled: false as const } : {}),
    };
    try {
      ensureValidAnchorAndPolicy(rule, parsed);
    } catch (err) {
      validationErrors.push(`${c.expr} → ${err instanceof Error ? err.message : String(err)}`);
    }
    newRules.push(rule);
  }

  /* report classification */
  console.log('— 逐行归类 —');
  for (const c of classified) {
    if (c.kind === 'blank') continue;
    if (c.kind === 'anchor-marker') {
      console.log(`  [marker]  ${c.marker}`);
    } else if (c.kind === 'dropped-comment') {
      console.log(`  [DROP!]   ${c.raw.trim()}`);
    } else if (c.kind === 'parked-rule') {
      console.log(`  [parked]  ${c.anchor} ← ${c.expr}${c.section ? `  〔${c.section}〕` : ''}  (enabled:false)`);
    } else if (c.parseError) {
      console.log(`  [ERR]     ${c.expr}  — ${c.parseError}`);
    } else {
      console.log(`  [rule]    ${c.anchor} ← ${c.expr}${c.section ? `  〔${c.section}〕` : ''}`);
    }
  }

  const dropped = classified.filter((c) => c.kind === 'dropped-comment');
  const active = newRules.filter((r) => r.enabled !== false);
  const parked = newRules.filter((r) => r.enabled === false);
  console.log('\n— 汇总 —');
  console.log(`迁移规则总数     : ${newRules.length}（生效 ${active.length} / 停用 ${parked.length}）`);
  for (const a of markers) {
    const n = newRules.filter((r) => r.anchor === a).length;
    if (n) console.log(`  ${a}: ${n} 条`);
  }
  if (dropped.length) {
    console.log(
      `\n⚠ 这些非规则注释行将从 base 的 rules: 块移除（${dropped.length}，新块只保留锚点标记）；` +
        `作为分区标题的，已写入其下规则的备注：`,
    );
    for (const d of dropped) console.log(`    ${d.raw.trim()}`);
  }
  if (parseErrors.length) {
    console.log(`\n✗ 解析失败 ${parseErrors.length} 行：`);
    for (const e of parseErrors) console.log(`    ${e}`);
  }
  if (validationErrors.length) {
    console.log(`\n✗ 锚点/策略校验失败 ${validationErrors.length} 条：`);
    for (const e of validationErrors) console.log(`    ${e}`);
  }

  if (newRules.length === 0) {
    console.log('\n未发现可迁移的规则（可能已迁移）。无操作。\n');
    return;
  }

  /* build the rewritten base: rules: block → markers only */
  const indent = detectMarkerIndent(blockLines);
  const newBlock = markers.map((m) => `${indent}# === ANCHOR: ${m} ===`);
  const newLines = [...lines.slice(0, block.start + 1), ...newBlock, ...lines.slice(block.end)];
  const newContent = newLines.join('\n');

  /* render-equivalence verification — the core safety gate */
  const oldExprs = renderedRuleExprs(oldContent, existingRules);
  const newExprs = renderedRuleExprs(newContent, [...existingRules, ...newRules]);
  let equal = oldExprs.length === newExprs.length;
  let firstDiff = -1;
  for (let i = 0; i < Math.max(oldExprs.length, newExprs.length); i++) {
    if (oldExprs[i] !== newExprs[i]) {
      equal = false;
      firstDiff = i;
      break;
    }
  }

  console.log('\n— 渲染等价验证 —');
  console.log(`迁移前渲染规则行 : ${oldExprs.length}`);
  console.log(`迁移后渲染规则行 : ${newExprs.length}`);
  if (equal) {
    console.log('✓ 通过：迁移前后下发的规则行序列逐行一致。');
  } else {
    console.log(`✗ 不一致（首处差异在第 ${firstDiff + 1} 行）：`);
    const lo = Math.max(0, firstDiff - 2);
    const hi = firstDiff + 3;
    for (let i = lo; i < hi; i++) {
      console.log(`    [${i + 1}] old: ${oldExprs[i] ?? '∅'}`);
      console.log(`        new: ${newExprs[i] ?? '∅'}`);
    }
  }

  const blocked = !equal || parseErrors.length > 0 || validationErrors.length > 0;

  if (!commit) {
    console.log('\n— 新 rules: 块预览 —');
    console.log(newBlock.join('\n'));
    console.log(
      blocked
        ? '\n⚠ 存在阻断问题（等价不通过 / 解析或校验失败）。修复后再 --commit。\n'
        : '\nDRY-RUN 完成，未写入任何数据。确认无误后加 --commit 执行。\n',
    );
    return;
  }

  /* commit path */
  if (blocked) {
    throw new Error('存在阻断问题，拒绝写入。请先在 dry-run 下修复。');
  }

  // Guard against a concurrent edit between read and commit.
  const redis = getRedis();
  const liveContent = await redis.get<string>(REDIS_KEYS.base.content(profileId));
  if (liveContent !== oldContent) {
    throw new Error('base:content 在本次运行期间被其他写入修改，已中止。请重新 dry-run。');
  }

  const ts = Date.now();
  const newMeta: BaseMeta = {
    etag: computeEtag(newContent),
    anchors: parsed.anchors,
    policies: parsed.policies,
    updated_at: nowSeconds(),
  };
  const payload: Record<string, Rule> = {};
  for (const r of newRules) payload[r.id] = r;

  const tx = redis.multi();
  tx.set(`base:content:backup:${ts}`, oldContent);
  tx.set(`base:meta:backup:${ts}`, oldMeta);
  tx.set(
    `rules:migrated:${ts}`,
    JSON.stringify(newRules.map((r) => r.id)),
  );
  tx.hset(REDIS_KEYS.rules(profileId), payload);
  tx.set(REDIS_KEYS.base.content(profileId), newContent);
  tx.set(REDIS_KEYS.base.meta(profileId), newMeta);
  await tx.exec();

  console.log('\n✓ COMMIT 完成（原子事务）：');
  console.log(`  base.content     : ${oldContent.length} → ${newContent.length} 字节`);
  console.log(`  base.etag        : ${oldMeta.etag} → ${newMeta.etag}`);
  console.log(`  新增 hash 规则   : ${newRules.length} 条（hash 共 ${existingRules.length + newRules.length}）`);
  console.log('  备份键：');
  console.log(`    base:content:backup:${ts}`);
  console.log(`    base:meta:backup:${ts}`);
  console.log(`    rules:migrated:${ts}  (新增规则 id 列表，便于撤销)`);
  console.log('\n撤销方式：用 base:content:backup 还原 base，并 hdel rules:migrated 列出的 id。\n');
}

main().catch((err) => {
  console.error('\n[migrate] 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
