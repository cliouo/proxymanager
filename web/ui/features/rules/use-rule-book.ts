'use client';

import { api, request } from '@/ui/data/api';
import { keys, refreshProfile } from '@/ui/data/hooks';
import { setQueryData, useQuery } from '@/ui/data/query';
import type { Rule, RulePageMeta, RulePatch } from '@/ui/data/types';

export interface RuleBook {
  rules: Rule[];
  version: number;
}

export const ruleBookKey = (profileId: string) => keys.scoped(profileId, 'rule-book');
const bookKey = ruleBookKey;

export async function fetchRuleBook(profileId: string): Promise<RuleBook> {
  const rules: Rule[] = [];
  let version = 0;
  for (let offset = 0; offset < 20_000; offset += 500) {
    const page = await request<{ data: Rule[]; meta: RulePageMeta }>('/rules', {
      query: { profileId, limit: 500, offset },
    });
    version = page.meta.configVersion;
    rules.push(...page.data);
    if (rules.length >= page.meta.total || page.data.length === 0) break;
  }
  return { rules, version };
}

export function useRuleBook(profileId: string) {
  return useQuery<RuleBook>(bookKey(profileId), () => fetchRuleBook(profileId), { staleTime: 3000 });
}

/** Optimistically patch rules in the cached book. */
export function patchBookLocally(profileId: string, update: (rules: Rule[]) => Rule[]) {
  setQueryData<RuleBook>(bookKey(profileId), (book) =>
    book ? { ...book, rules: update(book.rules) } : { rules: update([]), version: 0 },
  );
}

export interface RuleDraft {
  anchor: string;
  type: Rule['type'];
  value: string;
  policy: string;
  options?: string[];
  note?: string;
  enabled?: boolean;
}

export const ruleApi = {
  create(profileId: string, draft: RuleDraft) {
    return api.post<Rule>('/rules', { ...draft, source: 'manual' }, { profileId });
  },
  patch(profileId: string, rule: Rule, patch: RulePatch) {
    return api.patch<Rule>(
      `/rules/${rule.id}`,
      { ...patch, ...(rule.revision !== undefined ? { expectedRevision: rule.revision } : {}) },
      { profileId },
    );
  },
  remove(profileId: string, id: string) {
    return api.del(`/rules/${id}`, { profileId });
  },
  move(profileId: string, id: string, direction: 'up' | 'down', expectedVersion: number) {
    return api.post(`/rules/${id}/move`, { direction, expectedVersion }, { profileId });
  },
  /** Re-space ranks by 10 (one anchor, or every anchor when omitted). Order is preserved. */
  normalize(profileId: string, anchor?: string) {
    return api.post('/rules/reorder', anchor ? { anchor, step: 10 } : { step: 10 }, { profileId });
  },
  async batch(
    profileId: string,
    ops: Array<
      | { op: 'create'; rule: RuleDraft & { source: 'manual' } }
      | { op: 'update'; id: string; patch: RulePatch }
      | { op: 'delete'; id: string }
    >,
  ) {
    const result = await request<{ results: Array<{ status: number; error?: { title: string; detail?: string } }> }>(
      '/rules/batch',
      { method: 'POST', body: { ops }, query: { profileId } },
    );
    return result.results;
  },
};

export function afterRuleWrite(profileId: string) {
  refreshProfile(profileId);
}
