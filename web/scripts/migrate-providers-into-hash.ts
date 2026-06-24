/**
 * One-time migration: lift the hand-written `rule-providers:` block out of
 * base.yaml into the platform-managed rule-set library (the `rule-sets` hash),
 * and replace the block with the `# === RULE-PROVIDERS ===` marker. After this
 * the skeleton editor no longer carries provider declarations — the renderer
 * injects a declaration for every library entry an enabled RULE-SET rule
 * references (see lib/engine/renderer.ts).
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-providers-into-hash.ts
 *   Commit:             tsx --env-file=.env.local scripts/migrate-providers-into-hash.ts --commit
 *
 * Dry-run reads Redis, computes the plan, and prints everything; it writes
 * NOTHING. Commit additionally backs up base:content / base:meta, records the
 * imported rule-set ids, upserts the new rule-sets, and rewrites base — all in
 * one atomic Redis transaction.
 *
 * Classification of each base.yaml provider entry:
 *   - url path looks like /api/rule-providers/<token>/<name>  → SELF-HOSTED
 *       · matching library entry exists → already covered (skipped)
 *       · no matching entry             → flagged (declared but no content)
 *   - otherwise (external url)                                 → REMOTE (imported)
 *   - type: inline (has payload)                              → LOCAL (payload→content)
 *   - type: file                                              → flagged (manual)
 */

import { parseDocument } from 'yaml';
import { parseBase } from '@/lib/engine/parser';
import { referencedProviderNames } from '@/lib/engine/renderer';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase, type BaseMeta } from '@/lib/repos/baseRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { computeEtag } from '@/lib/services/baseService';
import { generateRuleSetId, nowSeconds } from '@/lib/services/ruleSetService';
import type { RuleSet } from '@/schemas';

const MARKER = '# === RULE-PROVIDERS ===';
const SELF_HOSTED_URL = /\/api\/rule-providers\/[^/]+\/([^/?#]+)/;

type Behavior = 'classical' | 'domain' | 'ipcidr';
type Format = 'yaml' | 'text' | 'mrs';

interface ProviderDecl {
  type?: string;
  behavior?: string;
  format?: string;
  url?: string;
  path?: string;
  interval?: number;
  proxy?: string;
  payload?: unknown;
}

function asBehavior(v: unknown): Behavior | undefined {
  return v === 'classical' || v === 'domain' || v === 'ipcidr' ? v : undefined;
}
function asFormat(v: unknown, fallback: Format): Format {
  return v === 'yaml' || v === 'text' || v === 'mrs' ? v : fallback;
}

/* ─── locate the top-level `rule-providers:` block (line-based) ─────── */

function locateBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => /^rule-providers:\s*$/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || /^\s/.test(line)) {
      end += 1;
      continue;
    }
    break; // first col-0 non-blank line ends the block
  }
  return { start, end };
}

/* ─── main ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== migrate-providers-into-hash (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

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

  const existing = await listRuleSets();
  const byName = new Map(existing.map((s) => [s.name, s]));
  const rules = await listRules(profileId);
  console.log(`base.etag        : ${oldMeta.etag}`);
  console.log(`库现有规则集     : ${existing.length} 个`);

  // Read the rule-providers map via the YAML Document. merge:true so entries
  // built from a `<<: *anchor` merge key resolve their inherited
  // type/behavior/format/interval before we read them.
  const doc = parseDocument(oldContent, { merge: true });
  if (doc.errors.length > 0) throw new Error(`base.yaml 解析失败：${doc.errors[0].message}`);
  const rpNode = doc.get('rule-providers');
  const rpMap = (rpNode && typeof rpNode === 'object' ? (doc.toJS() as Record<string, unknown>)['rule-providers'] : undefined) as
    | Record<string, ProviderDecl>
    | undefined;

  const now = nowSeconds();
  const imported: RuleSet[] = [];
  const skipped: string[] = [];
  const flagged: string[] = [];

  for (const [name, declRaw] of Object.entries(rpMap ?? {})) {
    const decl = (declRaw ?? {}) as ProviderDecl;
    if (byName.has(name)) {
      skipped.push(`${name}（库中已有同名条目）`);
      continue;
    }
    const selfHosted = decl.url ? SELF_HOSTED_URL.exec(decl.url) : null;
    if (decl.type === 'inline' || decl.payload !== undefined) {
      // inline payload → local content (serialise the payload back to YAML).
      const content = `payload:\n${(Array.isArray(decl.payload) ? decl.payload : []).map((p) => `  - ${p}`).join('\n')}\n`;
      imported.push({
        id: generateRuleSetId(),
        name,
        source: 'local',
        format: asFormat(decl.format, 'yaml'),
        behavior: asBehavior(decl.behavior),
        content,
        ...(decl.interval ? { interval: decl.interval } : {}),
        ...(decl.proxy ? { proxy: decl.proxy } : {}),
        note: '迁移自 base.yaml（inline payload）',
        updated_at: now,
      });
    } else if (decl.type === 'file' || (!decl.url && decl.path)) {
      flagged.push(`${name}（type: file / path 本地文件，需手动处理）`);
    } else if (selfHosted) {
      flagged.push(`${name}（指向自托管 URL 但库中无同名内容，请先在「规则集」页补内容）`);
    } else if (decl.url) {
      imported.push({
        id: generateRuleSetId(),
        name,
        source: 'remote',
        format: asFormat(decl.format, 'yaml'),
        behavior: asBehavior(decl.behavior),
        content: '',
        url: decl.url,
        ...(decl.interval ? { interval: decl.interval } : {}),
        ...(decl.proxy ? { proxy: decl.proxy } : {}),
        note: '迁移自 base.yaml（外部 rule-provider）',
        updated_at: now,
      });
    } else {
      flagged.push(`${name}（无法识别：既无 url 也无 payload/path）`);
    }
  }

  /* report classification */
  console.log('\n— base.yaml rule-providers 归类 —');
  if (!rpMap || Object.keys(rpMap).length === 0) {
    console.log('  （base.yaml 无 rule-providers 块）');
  }
  for (const s of imported) {
    const meta = `format=${s.format} behavior=${s.behavior ?? '-'} interval=${s.interval ?? '-'}`;
    console.log(
      `  [import]  ${s.name}  source=${s.source}  ${meta}  ${s.source === 'remote' ? s.url : '(local payload)'}`,
    );
  }
  for (const s of skipped) console.log(`  [skip]    ${s}`);
  for (const s of flagged) console.log(`  [FLAG]    ${s}`);

  /* referenced-provider coverage check */
  const active = rules.filter((r) => r.enabled !== false);
  const refs = referencedProviderNames(active);
  const libAfter = new Set([...byName.keys(), ...imported.map((s) => s.name)]);
  const missingRefs = [...refs].filter((n) => !libAfter.has(n));
  console.log('\n— RULE-SET 引用覆盖 —');
  console.log(`被启用规则引用的 provider : ${[...refs].join(', ') || '(无)'}`);
  if (missingRefs.length > 0) {
    console.log(`⚠ 这些被规则引用、但迁移后库中仍缺失（渲染会漏掉，mihomo 会报错）：`);
    for (const n of missingRefs) console.log(`    ${n}`);
  } else {
    console.log('✓ 所有被引用的 provider 都在库中。');
  }

  /* build the rewritten base: block → marker (or insert marker before rules:) */
  const lines = oldContent.split('\n');
  const block = locateBlock(lines);
  let newLines: string[];
  if (block) {
    newLines = [...lines.slice(0, block.start), MARKER, ...lines.slice(block.end)];
  } else if (oldContent.includes(MARKER)) {
    console.log('\nbase.yaml 已含 RULE-PROVIDERS 标记、且无可迁移块。');
    newLines = lines;
  } else {
    // No block and no marker: insert the marker right before the top-level rules:
    const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
    if (rulesIdx === -1) {
      newLines = [...lines, '', MARKER];
    } else {
      newLines = [...lines.slice(0, rulesIdx), MARKER, '', ...lines.slice(rulesIdx)];
    }
    console.log(`\nℹ base.yaml 无 rule-providers 块，已在 ${rulesIdx === -1 ? '文件末尾' : 'rules: 之前'}插入标记。`);
  }
  const newContent = newLines.join('\n');

  const blocked = flagged.length > 0;
  if (imported.length === 0 && block === null && oldContent.includes(MARKER)) {
    console.log('\n无可迁移项，且标记已就位。无操作。\n');
    return;
  }

  if (!commit) {
    console.log('\n— 新 base.yaml 片段（标记处）—');
    const idx = newLines.findIndex((l) => l.trim() === MARKER);
    console.log(newLines.slice(Math.max(0, idx - 1), idx + 2).join('\n'));
    console.log(
      blocked
        ? '\n⚠ 有 [FLAG] 项需先处理（dry-run 不写）。修复后再 --commit。\n'
        : '\nDRY-RUN 完成，未写入任何数据。确认无误后加 --commit 执行。\n',
    );
    return;
  }

  /* commit path */
  if (blocked) throw new Error('存在 [FLAG] 项，拒绝写入。请先在 dry-run 下处理。');

  const parsed = parseBase(newContent); // also validates the rewritten YAML
  const redis = getRedis();
  const live = await redis.get<string>(REDIS_KEYS.base.content(profileId));
  if (live !== oldContent) {
    throw new Error('base:content 在本次运行期间被其他写入修改，已中止。请重新 dry-run。');
  }

  const ts = Date.now();
  const newMeta: BaseMeta = {
    etag: computeEtag(newContent),
    anchors: parsed.anchors,
    policies: parsed.policies,
    updated_at: nowSeconds(),
  };

  const tx = redis.multi();
  tx.set(`base:content:backup:${ts}`, oldContent);
  tx.set(`base:meta:backup:${ts}`, oldMeta);
  if (imported.length > 0) {
    tx.set(`rule-sets:migrated:${ts}`, JSON.stringify(imported.map((s) => s.id)));
    const payload: Record<string, RuleSet> = {};
    for (const s of imported) payload[s.id] = s;
    tx.hset(REDIS_KEYS.ruleSets, payload);
  }
  tx.set(REDIS_KEYS.base.content(profileId), newContent);
  tx.set(REDIS_KEYS.base.meta(profileId), newMeta);
  await tx.exec();

  console.log('\n✓ COMMIT 完成（原子事务）：');
  console.log(`  base.content   : ${oldContent.length} → ${newContent.length} 字节`);
  console.log(`  base.etag      : ${oldMeta.etag} → ${newMeta.etag}`);
  console.log(`  导入规则集     : ${imported.length} 个（库共 ${existing.length + imported.length}）`);
  console.log('  备份键：');
  console.log(`    base:content:backup:${ts}`);
  console.log(`    base:meta:backup:${ts}`);
  if (imported.length > 0) console.log(`    rule-sets:migrated:${ts}  (导入的规则集 id 列表)`);
  console.log('\n撤销方式：用 base:content:backup 还原 base，并 hdel rule-sets:migrated 列出的 id。\n');
}

main().catch((err) => {
  console.error('\n[migrate] 失败：', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
