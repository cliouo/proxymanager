/**
 * One-time migration: lift the literal `proxy-groups:` block out of base.yaml
 * into the `proxy-groups` Redis hash (managed ProxyGroup records) + optionally
 * the `proxy-group-templates` hash (extracted from `<<: *anchor` merge keys),
 * and replace the block with the `# === PROXY-GROUPS ===` marker. After this
 * the renderer composes proxy-groups from the hash; the skeleton no longer
 * carries any group bodies.
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/migrate-proxy-groups-into-hash.ts
 *   Commit:             tsx --env-file=.env.local scripts/migrate-proxy-groups-into-hash.ts --commit
 *
 * Dry-run reads Redis, computes the full plan, runs the render-equivalence
 * check, and prints everything. It writes NOTHING. Commit additionally:
 *   1. backs up base:content / base:meta + records the migrated group/template ids,
 *   2. upserts the new groups + templates,
 *   3. rewrites base:content with the marker,
 * all in a single atomic Redis transaction — and only if the equivalence
 * check passes.
 *
 * Kind detection (advisory — user can re-classify in the UI):
 *   - `<<: *X` anchor reference                     → rule-set-policy (+ template X)
 *   - name in {默认 / dns / 国内 / 全球直连 / ...}    → system
 *   - include-all-providers + filter (no proxies)   → region (when filter looks regional)
 *   - include-all-providers + proxies + filter      → service
 *   - include-all-providers + type=url-test alone    → all-auto-pair (single half)
 *   - else                                          → raw
 */

import {
  parseDocument,
  parse as parseYaml,
  isMap,
  isScalar,
  isSeq,
  isAlias,
  type Document,
  type YAMLMap,
} from 'yaml';
import { parseBase } from '@/lib/engine/parser';
import { resolveConfig } from '@/lib/engine/resolve';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { getBase, type BaseMeta } from '@/lib/repos/baseRepo';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { listSubscriptions } from '@/lib/repos/subscriptionsRepo';
import { computeEtag } from '@/lib/services/baseService';
import { generateProxyGroupId } from '@/lib/services/proxyGroupService';
import { generateProxyGroupTemplateId } from '@/lib/services/proxyGroupTemplateService';
import {
  TEMPLATE_MERGE_FIELDS,
  type ProxyGroup,
  type ProxyGroupKind,
  type ProxyGroupTemplate,
  type ProxyGroupType,
} from '@/schemas';

const MARKER = '# === PROXY-GROUPS ===';
const RANK_STEP = 10;

const SYSTEM_NAMES = new Set([
  '默认',
  'dns',
  'DNS',
  'DNS出口',
  '国内',
  '全球直连',
  '直连',
  '兜底',
  '其它',
  '漏网之鱼',
  'fallback',
  'FALLBACK',
  'final',
  'FINAL',
]);

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/* ─── locate the top-level `proxy-groups:` block (line-based) ───────── */

function locateBlock(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => /^proxy-groups:\s*$/.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '' || /^\s/.test(line)) {
      end += 1;
      continue;
    }
    break;
  }
  return { start, end };
}

/* ─── classify each group, build template(s) ────────────────────────── */

interface GroupSource {
  /** Full effective field map (after anchor-merge expansion). */
  effective: Record<string, unknown>;
  /** Field names this group literally wrote (excludes anchor-sourced fields). */
  ownFields: Set<string>;
  /** Anchor name referenced via `<<: *X`, if any. */
  anchorRef: string | null;
}

/**
 * Walk a Pair where the key is `<<` (merge-key). The value may be a single
 * Alias or a Seq of Aliases. Return every referenced anchor name.
 */
function collectMergeAnchors(map: YAMLMap): string[] {
  const out: string[] = [];
  for (const pair of map.items) {
    const keyVal = isScalar(pair.key) ? pair.key.value : pair.key;
    if (keyVal !== '<<') continue;
    const v = pair.value;
    if (!v) continue;
    if (isAlias(v)) {
      out.push(v.source);
    } else if (isSeq(v)) {
      for (const item of v.items) {
        if (isAlias(item)) out.push(item.source);
      }
    }
  }
  return out;
}

/** Read `proxy-groups:` from a doc parsed WITHOUT merge — gives us a per-group view of literally-written fields + anchor refs. */
function extractGroupSources(content: string): GroupSource[] {
  // First pass: full effective view (anchors expanded).
  const merged = parseYaml(content, { merge: true }) as Record<string, unknown> | undefined;
  const effectiveSeq = (merged?.['proxy-groups'] ?? []) as Array<Record<string, unknown>>;

  // Second pass: raw AST so we can detect Alias / merge keys per group.
  const rawDoc: Document.Parsed = parseDocument(content, { merge: false });
  const rawSeq = rawDoc.get('proxy-groups');
  const rawItems = isSeq(rawSeq) ? rawSeq.items : [];

  const out: GroupSource[] = [];
  for (let i = 0; i < effectiveSeq.length; i++) {
    const effective = effectiveSeq[i] ?? {};
    const rawItem = rawItems[i];
    const ownFields = new Set<string>();
    let anchorRef: string | null = null;
    if (isMap(rawItem)) {
      const anchors = collectMergeAnchors(rawItem);
      if (anchors.length > 0) anchorRef = anchors[0]; // first wins; multi-merge edge case won't show up in user's config
      for (const pair of rawItem.items) {
        if (!isScalar(pair.key)) continue;
        const k = pair.key.value;
        if (typeof k === 'string' && k !== '<<') ownFields.add(k);
      }
    }
    out.push({ effective, ownFields, anchorRef });
  }
  return out;
}

function detectKind(src: GroupSource): ProxyGroupKind {
  const eff = src.effective;
  const name = String(eff['name'] ?? '');
  const filter = eff['filter'];
  const proxies = eff['proxies'];
  const includeAllProviders = eff['include-all-providers'] === true || eff['include-all'] === true;

  // Historical migration: kind taxonomy was simplified to 5 form-shapes
  // (manual / filter / all / single-sub / raw). The old structural buckets
  // (rule-set-policy / region / service / system) are gone — their semantic
  // "用途" moved to the free-text `section` field. The recategorize script
  // (scripts/recategorize-proxy-groups.ts) does both passes; this script
  // (already ran once) labels with the new form-shape values.
  if (SYSTEM_NAMES.has(name) || src.anchorRef) return 'manual';
  if (includeAllProviders && typeof filter === 'string') {
    return 'filter';
  }
  if (includeAllProviders) return 'all';
  if (Array.isArray(proxies)) return 'manual';
  return 'raw';
}

/* ─── main ──────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== migrate-proxy-groups-into-hash (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const defaultProfile = await getProfileByName('default');
  if (!defaultProfile) throw new Error('default profile missing — run `pnpm init:default-profile` first');
  const profileId = defaultProfile.id;

  const base = await getBase(profileId);
  if (!base) throw new Error('base:content 不存在,无法迁移。');
  const oldContent = base.content;
  const oldMeta: BaseMeta = {
    etag: base.etag,
    anchors: base.anchors,
    policies: base.policies,
    updated_at: base.updated_at,
  };

  const existingGroups = await listProxyGroups(profileId);
  const existingTemplates = await listProxyGroupTemplates();
  console.log(`base.etag        : ${oldMeta.etag}`);
  console.log(`hash 现有策略组  : ${existingGroups.length} 个`);
  console.log(`hash 现有模板    : ${existingTemplates.length} 个`);

  if (existingGroups.length > 0) {
    console.log('\n⚠ hash 中已有策略组数据。本脚本只追加,不覆盖。如果你想清空重来,请先手动 hdel proxy-groups。');
  }

  const lines = oldContent.split('\n');
  const block = locateBlock(lines);
  if (!block && oldContent.includes(MARKER)) {
    console.log('\nbase.yaml 已含 PROXY-GROUPS 标记、且无可迁移块。无操作。\n');
    return;
  }
  if (!block) {
    // Insert marker before `rules:` if there's no proxy-groups block at all.
    console.log('\nℹ base.yaml 无 proxy-groups 块。仅插入 marker。');
    const rulesIdx = lines.findIndex((l) => /^rules:\s*$/.test(l));
    const newLines =
      rulesIdx === -1
        ? [...lines, '', MARKER]
        : [...lines.slice(0, rulesIdx), MARKER, '', ...lines.slice(rulesIdx)];
    await maybeCommitMarkerOnly({ commit, profileId, oldContent, oldMeta, newContent: newLines.join('\n') });
    return;
  }

  const sources = extractGroupSources(oldContent);
  if (sources.length === 0) {
    console.log('\nproxy-groups 块为空,仅替换为 marker。');
  }

  /* group by anchor → template candidates */
  const anchorGroups = new Map<string, GroupSource[]>();
  for (const s of sources) {
    if (!s.anchorRef) continue;
    const list = anchorGroups.get(s.anchorRef) ?? [];
    list.push(s);
    anchorGroups.set(s.anchorRef, list);
  }

  const templatesByAnchor = new Map<string, ProxyGroupTemplate>();
  const newTemplates: ProxyGroupTemplate[] = [];

  for (const [anchorName, members] of anchorGroups) {
    // Skip if a template with this name already exists in the hash (re-run safety).
    const existing = existingTemplates.find((t) => t.name === sanitizeTemplateName(anchorName));
    if (existing) {
      templatesByAnchor.set(anchorName, existing);
      continue;
    }

    // Anchor-sourced fields = effective − ownFields (intersected across members for safety).
    // Templates only carry fields that ALL members inherit identically.
    const candidate: Record<string, unknown> = {};
    const first = members[0];
    for (const field of TEMPLATE_MERGE_FIELDS) {
      if (first.ownFields.has(field)) continue;
      const value = first.effective[field];
      if (value === undefined) continue;
      const consistent = members.every(
        (m) => !m.ownFields.has(field) && JSON.stringify(m.effective[field]) === JSON.stringify(value),
      );
      if (consistent) candidate[field] = value;
    }

    const tpl: ProxyGroupTemplate = {
      id: generateProxyGroupTemplateId(),
      name: sanitizeTemplateName(anchorName),
      notes: `迁移自 base.yaml YAML 锚点 *${anchorName}(${members.length} 个引用组)`,
      updated_at: nowSeconds(),
      ...(candidate as Partial<ProxyGroupTemplate>),
    };
    newTemplates.push(tpl);
    templatesByAnchor.set(anchorName, tpl);
  }

  /* build new groups */
  const newGroups: ProxyGroup[] = [];
  let rank = 0;
  for (const src of sources) {
    rank += RANK_STEP;
    const eff = src.effective;
    const name = String(eff['name'] ?? `unnamed-${rank}`);
    const type = (eff['type'] ?? 'select') as ProxyGroupType;
    const kind = detectKind(src);
    const template = src.anchorRef ? templatesByAnchor.get(src.anchorRef) ?? null : null;

    const group: ProxyGroup = {
      id: generateProxyGroupId(),
      kind,
      ...(template ? { template_id: template.id } : {}),
      rank,
      created_at: nowSeconds(),
      updated_at: nowSeconds(),
      name,
      type,
      ...buildGroupNativeFields(eff, src.ownFields, template),
      notes: `迁移自 base.yaml${src.anchorRef ? ` (锚点引用: *${src.anchorRef})` : ''}`,
    };
    newGroups.push(group);
  }

  /* report classification */
  console.log('\n— 策略组归类 —');
  for (const g of newGroups) {
    console.log(
      `  [${g.kind.padEnd(16)}] rank=${String(g.rank).padStart(4)}  ${g.name}  type=${g.type}` +
        (g.template_id ? `  → 模板=${newTemplates.find((t) => t.id === g.template_id)?.name ?? '?'}` : ''),
    );
  }
  if (newTemplates.length > 0) {
    console.log('\n— 新模板 —');
    for (const t of newTemplates) {
      const fields = Object.keys(t).filter(
        (k) => k !== 'id' && k !== 'name' && k !== 'notes' && k !== 'updated_at',
      );
      console.log(`  ${t.name}  字段=${fields.join(',')}`);
    }
  }

  /* build new base content with marker */
  const newLines = [...lines.slice(0, block.start), MARKER, ...lines.slice(block.end)];
  const newContent = newLines.join('\n');

  /* render-equivalence verification — proxy-groups block must produce the same JS object */
  console.log('\n— 渲染等价验证 —');
  const [rules, providers, subscriptions] = await Promise.all([
    listRules(profileId),
    listRuleSets(),
    listSubscriptions(),
  ]);

  // Old: literal block in base, empty hash.
  const oldRendered = await resolveConfig(oldContent, rules, subscriptions, [], [], {
    providers,
    ignoreFailedSubs: true,
    persistSnapshot: false,
  });
  // New: marker in base, hash has the migrated groups + templates.
  const newRendered = await resolveConfig(
    newContent,
    rules,
    subscriptions,
    [...existingGroups, ...newGroups],
    [...existingTemplates, ...newTemplates],
    {
      providers,
      ignoreFailedSubs: true,
      persistSnapshot: false,
    },
  );

  // Parse BOTH sides with merge:true so the literal block's `<<: *pr` merge
  // keys resolve to the same flat fields the hash render already emits —
  // otherwise OLD keeps a literal `<<` key and the comparison is apples-to-
  // oranges. Key order is irrelevant to mihomo, so canonicalise (sort object
  // keys, preserve array order) before stringifying.
  const oldPg =
    (parseYaml(oldRendered.content, { merge: true }) as { 'proxy-groups'?: unknown[] } | undefined)?.[
      'proxy-groups'
    ] ?? [];
  const newPg =
    (parseYaml(newRendered.content, { merge: true }) as { 'proxy-groups'?: unknown[] } | undefined)?.[
      'proxy-groups'
    ] ?? [];

  const oldStr = JSON.stringify(canonicalise(oldPg), null, 2);
  const newStr = JSON.stringify(canonicalise(newPg), null, 2);
  const equal = oldStr === newStr;
  console.log(`迁移前 proxy-groups 条数 : ${oldPg.length}`);
  console.log(`迁移后 proxy-groups 条数 : ${newPg.length}`);
  if (equal) {
    console.log('✓ 通过:迁移前后 proxy-groups 在结构上逐项一致(JSON 视角)。');
  } else {
    console.log('✗ 不一致。前 20 行差异:');
    const oldLines = oldStr.split('\n');
    const newLinesD = newStr.split('\n');
    let diffShown = 0;
    for (let i = 0; i < Math.max(oldLines.length, newLinesD.length) && diffShown < 20; i++) {
      if (oldLines[i] !== newLinesD[i]) {
        console.log(`    [${i + 1}] old: ${oldLines[i] ?? '∅'}`);
        console.log(`        new: ${newLinesD[i] ?? '∅'}`);
        diffShown++;
      }
    }
  }

  const blocked = !equal;

  if (!commit) {
    console.log('\n— 新 base.yaml 片段(标记处) —');
    const idx = newLines.findIndex((l) => l.trim() === MARKER);
    console.log(newLines.slice(Math.max(0, idx - 1), idx + 2).join('\n'));
    console.log(
      blocked
        ? '\n⚠ 等价校验不通过。请检查上述差异,修复后再 --commit。\n'
        : '\nDRY-RUN 完成,未写入任何数据。确认无误后加 --commit 执行。\n',
    );
    return;
  }

  if (blocked) throw new Error('等价校验不通过,拒绝写入。请先在 dry-run 下修复。');

  // Validate the rewritten YAML.
  parseBase(newContent);

  const redis = getRedis();
  const live = await redis.get<string>(REDIS_KEYS.base.content(profileId));
  if (live !== oldContent) {
    throw new Error('base:content 在本次运行期间被其他写入修改,已中止。请重新 dry-run。');
  }

  const ts = Date.now();
  const newMeta: BaseMeta = {
    etag: computeEtag(newContent),
    anchors: oldMeta.anchors,
    policies: oldMeta.policies,
    updated_at: nowSeconds(),
  };

  const groupPayload: Record<string, ProxyGroup> = {};
  for (const g of newGroups) groupPayload[g.id] = g;
  const tplPayload: Record<string, ProxyGroupTemplate> = {};
  for (const t of newTemplates) tplPayload[t.id] = t;

  const tx = redis.multi();
  tx.set(`base:content:backup:${ts}`, oldContent);
  tx.set(`base:meta:backup:${ts}`, oldMeta);
  if (newGroups.length > 0) {
    tx.set(`proxy-groups:migrated:${ts}`, JSON.stringify(newGroups.map((g) => g.id)));
    tx.hset(REDIS_KEYS.proxyGroups(profileId), groupPayload);
  }
  if (newTemplates.length > 0) {
    tx.set(
      `proxy-group-templates:migrated:${ts}`,
      JSON.stringify(newTemplates.map((t) => t.id)),
    );
    tx.hset(REDIS_KEYS.proxyGroupTemplates, tplPayload);
  }
  tx.set(REDIS_KEYS.base.content(profileId), newContent);
  tx.set(REDIS_KEYS.base.meta(profileId), newMeta);
  await tx.exec();

  console.log('\n✓ COMMIT 完成(原子事务):');
  console.log(`  base.content   : ${oldContent.length} → ${newContent.length} 字节`);
  console.log(`  base.etag      : ${oldMeta.etag} → ${newMeta.etag}`);
  console.log(`  新增策略组     : ${newGroups.length} 个 (hash 共 ${existingGroups.length + newGroups.length})`);
  console.log(`  新增模板       : ${newTemplates.length} 个 (hash 共 ${existingTemplates.length + newTemplates.length})`);
  console.log('  备份键:');
  console.log(`    base:content:backup:${ts}`);
  console.log(`    base:meta:backup:${ts}`);
  if (newGroups.length > 0) console.log(`    proxy-groups:migrated:${ts}`);
  if (newTemplates.length > 0) console.log(`    proxy-group-templates:migrated:${ts}`);
  console.log('\n撤销方式:用 base:content:backup 还原 base,并 hdel 列表中的 id。\n');
}

/* ─── helpers ──────────────────────────────────────────────────────── */

interface CommitMarkerOnlyArgs {
  commit: boolean;
  profileId: string;
  oldContent: string;
  oldMeta: BaseMeta;
  newContent: string;
}

async function maybeCommitMarkerOnly(args: CommitMarkerOnlyArgs): Promise<void> {
  if (!args.commit) {
    console.log('\nDRY-RUN: 仅会插入 PROXY-GROUPS marker(无策略组迁移)。--commit 执行。\n');
    return;
  }
  parseBase(args.newContent);
  const redis = getRedis();
  const live = await redis.get<string>(REDIS_KEYS.base.content(args.profileId));
  if (live !== args.oldContent) {
    throw new Error('base:content 在本次运行期间被其他写入修改,已中止。');
  }
  const ts = Date.now();
  const newMeta: BaseMeta = {
    etag: computeEtag(args.newContent),
    anchors: args.oldMeta.anchors,
    policies: args.oldMeta.policies,
    updated_at: nowSeconds(),
  };
  const tx = redis.multi();
  tx.set(`base:content:backup:${ts}`, args.oldContent);
  tx.set(`base:meta:backup:${ts}`, args.oldMeta);
  tx.set(REDIS_KEYS.base.content(args.profileId), args.newContent);
  tx.set(REDIS_KEYS.base.meta(args.profileId), newMeta);
  await tx.exec();
  console.log(`\n✓ 已写入 marker。备份:base:content:backup:${ts}\n`);
}

/**
 * Recursively sort object keys (arrays keep their order). Two proxy-group
 * maps that differ only in key order are identical to mihomo, so we
 * normalise key order before the byte-equivalence comparison.
 */
function canonicalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalise);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalise((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

function sanitizeTemplateName(anchor: string): string {
  // Template names follow the same regex as rule-sets: ^[a-z0-9_-]+$
  return anchor.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

/**
 * Build the native-field portion of a ProxyGroup from the merge-expanded
 * effective fields, excluding fields that came from the template (so the
 * group stays minimal and template edits propagate).
 */
function buildGroupNativeFields(
  effective: Record<string, unknown>,
  ownFields: Set<string>,
  template: ProxyGroupTemplate | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(effective)) {
    if (k === 'name' || k === 'type') continue; // already set explicitly
    if (v === undefined || v === null) continue;
    // Identity / member-list fields — always carry on the group, never the template.
    if (k === 'proxies' || k === 'use' || k === 'filter') {
      out[k] = v;
      continue;
    }
    // For template-merge fields: drop if the template carries the exact same value AND the group did not literally write it.
    if (template && !ownFields.has(k)) {
      const tplVal = (template as Record<string, unknown>)[k];
      if (tplVal !== undefined && JSON.stringify(tplVal) === JSON.stringify(v)) continue;
    }
    out[k] = v;
  }
  return out;
}

main().catch((err) => {
  console.error('\n[migrate] 失败:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
