/**
 * One-shot migration: pull an existing Clash YAML (typically the
 * mysub file hosted on Sub-Store) and seed Redis with the proxymanager
 * layout:
 *
 *   base:content  ← original YAML with `# === ANCHOR: prelude/manual/late ===`
 *                   markers inserted into the `rules:` block, and the user's
 *                   inline manual rules removed (they're moved to the rules hash).
 *   base:meta     ← parsed metadata (etag, anchors, policies, updated_at).
 *   rules         ← redis hash, one field per extracted manual rule
 *                   (source = "import", anchor = "manual").
 *
 * Run:
 *   npm run import:substore -- <url-or-path>
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/import-from-substore.ts <url-or-path>
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env.local without overwriting anything already in process.env.
try {
  process.loadEnvFile(resolve(process.cwd(), '.env.local'));
} catch {
  // Either Node < 20 (no loadEnvFile) or .env.local is absent — fall back to existing env.
}

import { parseBase } from '@/lib/engine/parser';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { computeEtag } from '@/lib/services/baseService';
import { getProfileByName } from '@/lib/repos/profilesRepo';
import type { BaseMeta } from '@/lib/repos/baseRepo';
import type { Rule, RuleType } from '@/schemas';

const MANUAL_TYPES = new Set<RuleType>([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
]);

const RULE_LINE = /^(\s*)-\s*([A-Z-]+)(?:,(.+?))?,([^,#]+?)\s*(?:#.*)?$/;
const MATCH_LINE = /^\s*-\s*MATCH,/;
const TOP_LEVEL_KEY = /^[A-Za-z0-9_-]+:\s*$/;

interface ExtractResult {
  transformedYaml: string;
  manualRules: Array<Pick<Rule, 'type' | 'value' | 'policy'>>;
}

function extractAnchorsAndManualRules(yaml: string): ExtractResult {
  const lines = yaml.split('\n');
  const rulesStart = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (rulesStart === -1) {
    throw new Error('Could not find a top-level `rules:` section.');
  }

  // Find the end of the rules block (next top-level key, or EOF).
  let rulesEnd = lines.length;
  for (let i = rulesStart + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (TOP_LEVEL_KEY.test(line)) {
      rulesEnd = i;
      break;
    }
  }

  const manualRules: Array<Pick<Rule, 'type' | 'value' | 'policy'>> = [];
  const newRulesBlock: string[] = [];
  const anchorsEmitted = { prelude: false, manual: false, late: false };

  for (let i = rulesStart + 1; i < rulesEnd; i++) {
    const line = lines[i];
    const match = RULE_LINE.exec(line);

    if (match && MANUAL_TYPES.has(match[2] as RuleType)) {
      manualRules.push({
        type: match[2] as RuleType,
        value: (match[3] ?? '').trim(),
        policy: match[4].trim(),
      });
      // First manual line we encounter — replace with prelude + manual markers.
      if (!anchorsEmitted.prelude) {
        const indent = match[1];
        newRulesBlock.push(`${indent}# === ANCHOR: prelude ===`);
        newRulesBlock.push(`${indent}# === ANCHOR: manual ===`);
        anchorsEmitted.prelude = true;
        anchorsEmitted.manual = true;
      }
      continue;
    }

    if (MATCH_LINE.test(line) && !anchorsEmitted.late) {
      const indent = line.match(/^\s*/)?.[0] ?? '  ';
      newRulesBlock.push(`${indent}# === ANCHOR: late ===`);
      anchorsEmitted.late = true;
    }

    newRulesBlock.push(line);
  }

  // Fallback inserts if the YAML had no manual rules or no MATCH.
  if (!anchorsEmitted.prelude || !anchorsEmitted.manual) {
    const indent = '  ';
    if (!anchorsEmitted.prelude) newRulesBlock.unshift(`${indent}# === ANCHOR: prelude ===`);
    if (!anchorsEmitted.manual) newRulesBlock.unshift(`${indent}# === ANCHOR: manual ===`);
  }
  if (!anchorsEmitted.late) {
    const indent = '  ';
    newRulesBlock.push(`${indent}# === ANCHOR: late ===`);
  }

  const transformedYaml = [
    ...lines.slice(0, rulesStart + 1),
    ...newRulesBlock,
    ...lines.slice(rulesEnd),
  ].join('\n');

  return { transformedYaml, manualRules };
}

async function loadInput(arg: string): Promise<string> {
  if (arg.startsWith('http://') || arg.startsWith('https://')) {
    const res = await fetch(arg);
    if (!res.ok) throw new Error(`Failed to fetch ${arg}: HTTP ${res.status}`);
    return res.text();
  }
  return readFileSync(arg, 'utf8');
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: import-from-substore <url-or-file-path>');
    process.exit(1);
  }

  const defaultProfile = await getProfileByName('default');
  if (!defaultProfile) throw new Error('default profile missing — run `pnpm init:default-profile` first');
  const profileId = defaultProfile.id;

  console.log(`[import] reading from: ${arg}`);
  const original = await loadInput(arg);
  console.log(`[import] loaded ${original.length} bytes`);

  const { transformedYaml, manualRules } = extractAnchorsAndManualRules(original);
  console.log(`[import] extracted ${manualRules.length} manual rule(s)`);

  // Parse the transformed YAML to validate + extract anchors/policies.
  const parsed = parseBase(transformedYaml);
  console.log(`[import] anchors: ${parsed.anchors.join(', ')}`);
  console.log(`[import] policies: ${parsed.policies.length} group(s)`);

  // Verify every extracted rule's policy exists in the parsed base.
  const policySet = new Set(parsed.policies);
  const orphans = manualRules.filter((r) => !policySet.has(r.policy));
  if (orphans.length > 0) {
    console.warn(`[import] WARNING: ${orphans.length} rule(s) target a policy not in base:`);
    for (const o of orphans) console.warn(`  - ${o.type},${o.value} -> ${o.policy}`);
    console.warn('[import] Importing anyway; these will surface as orphans in /api/v1/base.');
  }

  const now = Math.floor(Date.now() / 1000);
  const rules: Rule[] = manualRules.map((r, idx) => ({
    id: randomUUID(),
    anchor: 'manual',
    type: r.type,
    value: r.value,
    policy: r.policy,
    rank: (idx + 1) * 10,
    source: 'import',
    added_at: now,
    updated_at: now,
  }));

  const meta: BaseMeta = {
    etag: computeEtag(transformedYaml),
    anchors: parsed.anchors,
    policies: parsed.policies,
    updated_at: now,
  };

  const redis = getRedis();
  const tx = redis.multi();
  tx.set(REDIS_KEYS.base.content(profileId), transformedYaml);
  tx.set(REDIS_KEYS.base.meta(profileId), meta);
  if (rules.length > 0) {
    const hashPayload: Record<string, Rule> = {};
    for (const rule of rules) hashPayload[rule.id] = rule;
    tx.hset(REDIS_KEYS.rules(profileId), hashPayload);
  }
  await tx.exec();

  console.log('[import] done.');
  console.log(`  base.content : ${transformedYaml.length} bytes`);
  console.log(`  base.etag    : ${meta.etag}`);
  console.log(`  rules.count  : ${rules.length}`);
}

main().catch((err) => {
  console.error('[import] FAILED:', err);
  process.exit(1);
});
