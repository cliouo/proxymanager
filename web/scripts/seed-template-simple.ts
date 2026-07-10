/**
 * One-time seed: create the `template-simple`(简单模板) profile — the most
 * minimal usable shape. Three proxy-groups only:
 *
 *   - 默认     select    自动选择 置顶 + 全部节点 (include-all-proxies)
 *   - 自动选择  url-test  全部节点
 *   - dns      select    自动选择 置顶 + 全部节点(小写 dns:base 的
 *                        nameserver-policy 以 `#dns` 引用该组名)
 *
 * Rules keep the bare closed loop, 国内固定直连(不给组、不可选):
 *   GEOIP,lan → 直连 (prelude);cn_domain → DIRECT、geolocation-!cn → 默认、
 *   cn_ip → DIRECT、MATCH → 默认 (late)。
 * Base skeleton (content + meta) is copied verbatim from `template-general`
 * (原 copy 自 template-minimal,该模版已于 2026-07-10 下线;两者 base 同源),
 * mirroring cloneProfileConfig semantics — same content ⇒ same etag; base
 * dns.nameserver-policy 引用的 rule-set 由 renderer 从 base 文本自动注入。
 *
 *   Dry-run (default):  tsx --env-file=.env.local scripts/seed-template-simple.ts
 *   Commit:             tsx --env-file=.env.local scripts/seed-template-simple.ts --commit
 *
 * Both modes end with an in-memory resolveConfig() render of the would-be
 * profile so schema/marker/policy problems surface before (and after) writing.
 *
 * 撤销:hdel profiles <id>;del base:content:<id> base:meta:<id>
 *       proxy-groups:<id> rules:<id>。
 */

import { resolveConfig } from '@/lib/engine/resolve';
import { getBase, setBase } from '@/lib/repos/baseRepo';
import { getProfileByName, upsertProfile } from '@/lib/repos/profilesRepo';
import { upsertProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { invalidateResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { upsertRules } from '@/lib/repos/rulesRepo';
import { ProxyGroupSchema, RuleSchema, type Profile, type ProxyGroup, type Rule } from '@/schemas';

const PROFILE_NAME = 'template-simple';
const DISPLAY_NAME = '简单模板';
const BASE_SOURCE_PROFILE = 'template-general';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildGroups(now: number): ProxyGroup[] {
  const groups = [
    {
      id: crypto.randomUUID(),
      kind: 'all',
      section: '系统',
      rank: 10,
      notes: 'seed-template-simple',
      created_at: now,
      updated_at: now,
      name: '默认',
      type: 'select',
      proxies: ['自动选择'],
      'include-all-proxies': true,
      // base 字面 proxy「直连」只给 GEOIP,lan 规则当出口用,不进任何组。
      'exclude-filter': '^直连$',
    },
    {
      id: crypto.randomUUID(),
      kind: 'all',
      section: '入口',
      rank: 20,
      notes: 'seed-template-simple',
      created_at: now,
      updated_at: now,
      name: '自动选择',
      type: 'url-test',
      'include-all-proxies': true,
      'exclude-filter': '^直连$',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 10,
    },
    {
      id: crypto.randomUUID(),
      kind: 'all',
      section: '系统',
      rank: 30,
      notes: 'seed-template-simple',
      created_at: now,
      updated_at: now,
      name: 'dns',
      type: 'select',
      proxies: ['自动选择'],
      'include-all-proxies': true,
      'exclude-filter': '^直连$',
    },
  ];
  return groups.map((g) => ProxyGroupSchema.parse(g));
}

function buildRules(now: number): Rule[] {
  const rules = [
    {
      id: crypto.randomUUID(),
      anchor: 'prelude',
      type: 'GEOIP',
      value: 'lan',
      policy: '直连',
      rank: 10,
      source: 'manual',
      added_at: now,
      updated_at: now,
      note: 'seed-template-simple · 局域网直连',
      options: ['no-resolve'],
    },
    {
      id: crypto.randomUUID(),
      anchor: 'late',
      type: 'RULE-SET',
      value: 'cn_domain',
      policy: 'DIRECT',
      rank: 360,
      source: 'manual',
      added_at: now,
      updated_at: now,
      note: 'seed-template-simple · 国内域名固定直连',
    },
    {
      id: crypto.randomUUID(),
      anchor: 'late',
      type: 'RULE-SET',
      value: 'geolocation-!cn',
      policy: '默认',
      rank: 370,
      source: 'manual',
      added_at: now,
      updated_at: now,
      note: 'seed-template-simple · 国外域名走默认',
    },
    {
      id: crypto.randomUUID(),
      anchor: 'late',
      type: 'RULE-SET',
      value: 'cn_ip',
      policy: 'DIRECT',
      rank: 390,
      source: 'manual',
      added_at: now,
      updated_at: now,
      note: 'seed-template-simple · 国内 IP 固定直连',
    },
    {
      id: crypto.randomUUID(),
      anchor: 'late',
      type: 'MATCH',
      value: '',
      policy: '默认',
      rank: 400,
      source: 'manual',
      added_at: now,
      updated_at: now,
      note: 'seed-template-simple · 兜底走默认',
    },
  ];
  return rules.map((r) => RuleSchema.parse(r));
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  console.log(`\n=== seed-template-simple (${commit ? 'COMMIT' : 'DRY-RUN'}) ===\n`);

  const dup = await getProfileByName(PROFILE_NAME);
  if (dup) {
    console.log(`⚠ 已存在 name="${PROFILE_NAME}" 的 profile (id=${dup.id}),跳过(无操作)。\n`);
    return;
  }

  const baseSrcProfile = await getProfileByName(BASE_SOURCE_PROFILE);
  if (!baseSrcProfile) throw new Error(`base 来源 profile "${BASE_SOURCE_PROFILE}" 不存在`);
  const srcBase = await getBase(baseSrcProfile.id);
  if (!srcBase) throw new Error(`profile "${BASE_SOURCE_PROFILE}" 没有 base 骨架`);

  const now = nowSeconds();
  const profile: Profile = {
    id: crypto.randomUUID(),
    name: PROFILE_NAME,
    display_name: DISPLAY_NAME,
    source: { type: 'none' },
    notes:
      '最简单用法的模板: 三个策略组(默认/自动选择/dns),全部节点自动纳入,' +
      '规则只保留局域网直连 + MATCH 走默认,不做分流。',
    created_at: now,
    updated_at: now,
  };
  const groups = buildGroups(now);
  const rules = buildRules(now);

  console.log(`profile : ${profile.name} (${profile.display_name}) id=${profile.id}`);
  console.log(`base    : 复制自 ${BASE_SOURCE_PROFILE} (etag=${srcBase.etag}, ${srcBase.content.length} chars)`);
  console.log(`groups  : ${groups.map((g) => `${g.name}[${g.type}]`).join(', ')}`);
  console.log(`rules   : ${rules.map((r) => `${r.type}${r.value ? ',' + r.value : ''}→${r.policy}`).join('  ')}`);

  // 渲染验证(两种模式都跑):source none ⇒ 不注入订阅,骨架必须自洽。
  const ruleSets = await listRuleSets();
  const resolved = await resolveConfig(srcBase.content, rules, [], groups, [], {
    providers: ruleSets,
    persistSnapshot: false,
    boundSource: { type: 'none' },
  });
  console.log(`\n— resolveConfig 验证 —`);
  console.log(`  proxy-groups 输出数 : ${resolved.proxyGroupCount}`);
  console.log(`  注入 rule-providers : ${resolved.ruleProvidersApplied.join(', ') || '(无)'}`);
  console.log(`  unmatched anchors   : ${resolved.unmatchedAnchors.join(', ') || '(无)'}`);
  console.log(`  warnings            : ${resolved.warnings.join(' | ') || '(无)'}`);
  const lines = resolved.content.split('\n');
  const gi = lines.findIndex((l) => l.startsWith('proxy-groups:'));
  if (gi >= 0) {
    console.log(`\n— 渲染出的 proxy-groups / rules 片段 —`);
    console.log(
      lines
        .slice(gi)
        .filter((l) => !l.startsWith('rule-providers:'))
        .slice(0, 40)
        .join('\n'),
    );
  }

  if (!commit) {
    console.log('\nDRY-RUN 完成,未写入。确认无误后加 --commit 执行。\n');
    return;
  }

  await setBase(
    profile.id,
    srcBase.content,
    { etag: srcBase.etag, anchors: srcBase.anchors, policies: srcBase.policies, updated_at: now },
    null,
  );
  await upsertProxyGroups(profile.id, groups);
  await upsertRules(profile.id, rules);
  await upsertProfile(profile);
  await invalidateResolvedSnapshot().catch(() => undefined);

  console.log('\n✓ COMMIT 完成:');
  console.log(`  profile id : ${profile.id}`);
  console.log(`  订阅链接    : /api/sub/{token}/${PROFILE_NAME}`);
  console.log(
    `\n撤销:hdel profiles ${profile.id};` +
      `del base:content:${profile.id} base:meta:${profile.id} proxy-groups:${profile.id} rules:${profile.id}\n`,
  );
}

main().catch((err) => {
  console.error('\n✗ 失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
