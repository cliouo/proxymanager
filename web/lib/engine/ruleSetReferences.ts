const LOGIC_RULE_TYPES = new Set(['AND', 'OR', 'NOT']);
const MAX_REFERENCE_LOGIC_DEPTH = 16;

/**
 * Collect RULE-SET payloads from the actual fixed-Mihomo rule tree. Text
 * scanning is unsafe here: a DOMAIN-REGEX may contain `RULE-SET,foo` as literal
 * regex text, while a real provider name may itself contain parentheses.
 */
export function collectRuleSetReferencesFromRuleLine(raw: string, refs: Set<string>): void {
  collectRuleSetReferences(raw, refs, false, 0);
}

function collectRuleSetReferences(
  raw: string,
  refs: Set<string>,
  nested: boolean,
  depth: number,
): void {
  if (depth > MAX_REFERENCE_LOGIC_DEPTH) return;
  const fields = raw.split(',').map(trimAsciiSpaces);
  const type = fields[0]?.toUpperCase() ?? '';
  if (type === 'RULE-SET') {
    const name = fields[1] ?? '';
    if (name !== '') refs.add(name);
    return;
  }
  if (!LOGIC_RULE_TYPES.has(type) && type !== 'SUB-RULE') return;

  const payload = nested ? fields.slice(1).join(',') : fields.slice(1, -1).join(',');
  if (payload === '') return;
  const expression = type === 'SUB-RULE' ? `(${payload})` : payload;
  for (const child of outermostLogicChildren(expression)) {
    collectRuleSetReferences(child, refs, true, depth + 1);
  }
}

function trimAsciiSpaces(value: string): string {
  return value.replace(/^ +| +$/gu, '');
}

/** Mirror fixed rules/logic.findSubRuleRange for reference discovery. */
function outermostLogicChildren(payload: string): string[] {
  if (!payload.startsWith('(') || !payload.endsWith(')')) return [];
  const stack: number[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < payload.length; index += 1) {
    if (payload[index] === '(') {
      stack.push(index);
    } else if (payload[index] === ')') {
      const start = stack.pop();
      if (start === undefined) return [];
      ranges.push({ start, end: index });
    }
  }
  if (stack.length > 0) return [];

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    if (range.start === 0 && range.end === payload.length - 1) continue;
    if (selected.some((parent) => parent.start < range.start && parent.end > range.end)) continue;
    selected.push(range);
  }
  return selected.map((range) => payload.slice(range.start + 1, range.end));
}
