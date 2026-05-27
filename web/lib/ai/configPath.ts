/**
 * Shared config-path utilities for the assistant's whole-config read/write.
 *
 * Path syntax: dot-separated keys, with `[name]` selecting a named item in a
 * sequence-of-maps. Examples: `dns.enhanced-mode`, `proxy-groups[OpenAI]`,
 * `rule-providers[openai_classic].behavior`.
 */

import { ProblemDetailsError } from '@/lib/http/problem';

/** Keys whose value is a credential anywhere in the tree. */
export const SENSITIVE_KEY =
  /(password|passwd|secret|token|uuid|psk|private[-_]?key|credential|auth)/i;

/**
 * Top-level blocks config-section edits must never touch, with the reason shown
 * to the model. `proxies` is partly auto-injected from enabled subscriptions
 * at render time — hand-editing fights the resolve pipeline. `proxy-providers`
 * is no longer managed by the project (subscriptions inject straight into
 * `proxies:`); any literal entries the user wrote stay untouched. `rules` and
 * `rule-providers` are owned by their respective dedicated actions and live
 * in Redis hashes, not base.yaml.
 */
const FORBIDDEN_EDIT_ROOTS: Record<string, string> = {
  proxies: '节点由订阅源自动注入；要增减节点请到「订阅源」页',
  'proxy-providers':
    '本项目不再管理 proxy-providers（订阅源直接注入到 proxies）；用户在 base 里手写的条目会原样透传，AI 不要触碰',
  rules: '规则请用 add_rule / update_rule / delete_rule 管理，不能经 config-section 改',
  'rule-providers':
    '规则集由 create_rule_provider / update_rule_provider / delete_rule_provider 管理，不能经 config-section 改',
};

export interface Segment {
  key: string;
  selector?: string;
}

export function parsePath(path: string): Segment[] {
  const parts = path
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw ProblemDetailsError.badRequest('路径不能为空。');
  return parts.map((part) => {
    const m = /^([^[\]]+)(?:\[([^\]]+)\])?$/.exec(part);
    if (!m) throw ProblemDetailsError.badRequest(`无效路径段："${part}"。`);
    return { key: m[1], selector: m[2] };
  });
}

/**
 * Never-List for edits: the AI may read everything (redacted) but may only
 * change policy/behaviour blocks — never node sources or credential fields.
 */
export function assertEditablePath(segs: Segment[]): void {
  const root = segs[0]?.key;
  if (root && root in FORBIDDEN_EDIT_ROOTS) {
    throw ProblemDetailsError.forbidden(`不允许修改 ${root}（${FORBIDDEN_EDIT_ROOTS[root]}）。`);
  }
  for (const s of segs) {
    if (SENSITIVE_KEY.test(s.key)) {
      throw ProblemDetailsError.forbidden(`不允许修改敏感字段 "${s.key}"。`);
    }
  }
}
