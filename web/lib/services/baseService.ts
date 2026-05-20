import { createHash } from 'node:crypto';
import type { BaseValidationResult } from '@/schemas';
import { BaseParseError, type ParsedBase, parseBase } from '@/lib/engine/parser';
import { validateBase } from '@/lib/engine/validator';
import { listRules } from '@/lib/repos/rulesRepo';
import { ProblemDetailsError } from '@/lib/http/problem';

export function computeEtag(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
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
  return { parsedBase, validation };
}
