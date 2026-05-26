import { createHash } from 'node:crypto';
import type { BaseOrphan, BaseValidationResult } from '@/schemas';
import { BaseParseError, type ParsedBase, parseBase } from '@/lib/engine/parser';
import { validateBase } from '@/lib/engine/validator';
import { listRules } from '@/lib/repos/rulesRepo';
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

export interface ParseAndValidateResult {
  parsedBase: ParsedBase;
  validation: BaseValidationResult;
}

export async function parseAndValidate(content: string): Promise<ParseAndValidateResult> {
  let parsedBase: ParsedBase;
  try {
    parsedBase = parseBase(content);
  } catch (err) {
    if (err instanceof BaseParseError) {
      throw ProblemDetailsError.unprocessable(`Invalid YAML: ${err.message}`);
    }
    throw err;
  }
  const rules = await listRules();
  const validation = validateBase(parsedBase, rules);
  const blockViolations = rulesBlockViolations(content);
  if (blockViolations.length > 0) {
    validation.orphans = [...validation.orphans, ...blockViolations];
    validation.valid = false;
  }
  return { parsedBase, validation };
}
