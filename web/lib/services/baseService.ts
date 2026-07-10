import { createHash } from 'node:crypto';
import type { BaseOrphan, BaseValidationResult } from '@/schemas';
import { BaseParseError, type ParsedBase, parseBase } from '@/lib/engine/parser';
import { validateBase } from '@/lib/engine/validator';
import { referencedProviderNamesInText } from '@/lib/engine/renderer';
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { ProblemDetailsError } from '@/lib/http/problem';

export function computeEtag(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The skeleton's `rules:` block must hold nothing but anchor markers — all
 * actual rules live in the `rules` hash and are injected at render time. Any
 * literal rule list-item (`- TYPE,...`) is a violation; comments and markers
 * are fine. Returns one orphan per offending line so they surface in the
 * existing validation UI.
 */
export function rulesBlockViolations(content: string): BaseOrphan[] {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^rules:\s*$/.test(l));
  if (start === -1) return [];
  const out: BaseOrphan[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A new top-level mapping key (col 0, `key:`) ends the rules block.
    if (!/^\s/.test(line) && /^[A-Za-z0-9_.'"-]+:(\s|$)/.test(line)) break;
    const m = line.trim().match(/^-\s+(.+)$/);
    if (m) {
      out.push({
        rule_id: `rules:line ${i + 1}`,
        reason: `规则行「${m[1].trim()}」请到「规则」页管理；结构里的 rules: 只保留锚点标记`,
      });
    }
  }
  return out;
}

/**
 * Like {@link rulesBlockViolations}, but for the `rule-providers:` block:
 * provider declarations are managed in the「规则集」library and injected at
 * render time via the `# === RULE-PROVIDERS ===` marker (a comment, which
 * passes). Any literal top-level provider entry left in the skeleton is a
 * violation — one per offending entry — so it surfaces in the validation UI.
 */
export function ruleProvidersBlockViolations(content: string): BaseOrphan[] {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => /^rule-providers:\s*$/.test(l));
  if (start === -1) return [];
  const out: BaseOrphan[] = [];
  let childIndent: number | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) break; // first col-0 line ends the block
    const indent = line.length - line.trimStart().length;
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue; // nested provider option (type:/url:/…)
    const m = line.trim().match(/^([A-Za-z0-9_.-]+):/);
    if (m) {
      out.push({
        rule_id: `rule-providers:${m[1]}`,
        reason: `规则提供者「${m[1]}」请到「规则集」页管理；base 里用 # === RULE-PROVIDERS === 标记（运行 migrate:providers 迁移）`,
      });
    }
  }
  return out;
}

export interface ParseAndValidateResult {
  parsedBase: ParsedBase;
  validation: BaseValidationResult;
}

export async function parseAndValidate(
  profileId: string,
  content: string,
): Promise<ParseAndValidateResult> {
  let parsedBase: ParsedBase;
  try {
    parsedBase = parseBase(content);
  } catch (err) {
    if (err instanceof BaseParseError) {
      throw ProblemDetailsError.unprocessable(`Invalid YAML: ${err.message}`);
    }
    throw err;
  }
  const [rules, providerSets, proxyGroups] = await Promise.all([
    listRules(profileId),
    listRuleSets(),
    listProxyGroups(profileId),
  ]);
  const providerNames = new Set(providerSets.map((s) => s.name));
  // 策略组在 hash 里、渲染时才注入 base——校验候选 base 内容时必须把它们
  // 计入合法 policy 全集，否则指向托管组的规则全被误判孤立(保存必 422)。
  const validation = validateBase(
    parsedBase,
    rules,
    providerNames,
    proxyGroups.map((g) => g.name),
  );
  const blockViolations = [...rulesBlockViolations(content), ...ruleProvidersBlockViolations(content)];
  if (blockViolations.length > 0) {
    validation.orphans = [...validation.orphans, ...blockViolations];
    validation.valid = false;
  }

  // P0-4: if enabled RULE-SET rules (or base-body `rule-set:` keys) reference a
  // library rule-set, the base MUST carry the `# === RULE-PROVIDERS ===` marker
  // — that's the only place the `rule-providers:` declarations get injected.
  // Saving a base that drops the marker while references exist yields a config
  // mihomo rejects with `not found rule-set`. Block the save with a clear reason.
  const referencedSets = new Set<string>();
  for (const r of rules) {
    if (r.enabled !== false && r.type === 'RULE-SET' && r.value && providerNames.has(r.value)) {
      referencedSets.add(r.value);
    }
  }
  for (const name of referencedProviderNamesInText(content)) {
    if (providerNames.has(name)) referencedSets.add(name);
  }
  const markerPresent = /^[ \t]*#\s*===\s*RULE-PROVIDERS\s*===[ \t]*$/m.test(content);
  if (referencedSets.size > 0 && !markerPresent) {
    validation.orphans = [
      ...validation.orphans,
      {
        rule_id: 'rule-providers:marker',
        reason: `有 ${referencedSets.size} 个被引用的规则集(${[...referencedSets].slice(0, 3).join('、')}${referencedSets.size > 3 ? '…' : ''})需要注入，但结构里缺少 # === RULE-PROVIDERS === 标记；请插入该标记，否则渲染出的配置会被 mihomo 以 not found rule-set 拒载。`,
      },
    ];
    validation.valid = false;
  }
  return { parsedBase, validation };
}
