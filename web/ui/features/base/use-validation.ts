'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { ApiError, request, type ConfigIssue } from '@/ui/data/api';
import type { BaseValidationResult, Rule } from '@/ui/data/types';
import { checkYamlSyntax, describeServerParseIssue, type SyntaxIssue } from './yaml-tools';

/* ─── live validation: client syntax first, then the server (debounced) ── */

interface ServerResult {
  content: string;
  result?: BaseValidationResult;
  /** 422 from the server's own parse (merge keys, invalid proxies, …). */
  issue?: ConfigIssue;
  error?: unknown;
}

export type ValidationStatus = 'empty' | 'syntax' | 'checking' | 'invalid' | 'orphans' | 'valid' | 'error';

export interface Validation {
  status: ValidationStatus;
  syntax: SyntaxIssue | null;
  /** Server verdict for the current text (undefined while checking). */
  result?: BaseValidationResult;
  /** Last verdict we got, kept while the next one is in flight. */
  lastResult?: BaseValidationResult;
  issue?: ConfigIssue;
  error?: unknown;
  retry: () => void;
}

export function useBaseValidation(profileId: string, content: string, enabled: boolean): Validation {
  const deferred = useDeferredValue(content);
  const syntax = useMemo(() => (enabled ? checkYamlSyntax(deferred) : null), [deferred, enabled]);
  const [server, setServer] = useState<ServerResult | null>(null);
  const [lastResult, setLastResult] = useState<BaseValidationResult | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled || syntax) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await request<{ data: BaseValidationResult }>('/base/validate', {
          method: 'POST',
          body: { content: deferred },
          query: { profileId },
          signal: controller.signal,
        });
        setServer({ content: deferred, result: response.data });
        setLastResult(response.data);
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        if (error instanceof ApiError && error.status === 422) {
          const first = error.issues[0] ?? { message: error.detail ?? error.title };
          setServer({ content: deferred, issue: { ...first, message: describeServerParseIssue(first.message) } });
        } else {
          setServer({ content: deferred, error });
        }
      }
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [deferred, enabled, syntax, profileId, nonce]);

  const retry = () => setNonce((n) => n + 1);

  if (!enabled) return { status: 'checking', syntax: null, lastResult, retry };
  if (!content.trim()) return { status: 'empty', syntax: null, lastResult, retry };
  if (syntax && deferred === content) return { status: 'syntax', syntax, lastResult, retry };
  const current = server && server.content === content ? server : null;
  if (!current) return { status: 'checking', syntax: null, lastResult, retry };
  if (current.issue) return { status: 'invalid', syntax: null, issue: current.issue, lastResult, retry };
  if (current.error) return { status: 'error', syntax: null, error: current.error, lastResult, retry };
  const result = current.result!;
  return { status: result.valid ? 'valid' : 'orphans', syntax: null, result, lastResult, retry };
}

/* ─── orphan grouping ────────────────────────────────────────────────── */

export interface Orphan {
  rule_id: string;
  reason: string;
}

export type OrphanGroup =
  | { kind: 'anchor' | 'policy' | 'rule-set'; name: string; rules: Array<{ id: string; rule?: Rule }> }
  | { kind: 'literal-rule'; line: number; text: string }
  | { kind: 'literal-provider'; name: string }
  | { kind: 'providers-marker'; reason: string }
  | { kind: 'other'; reason: string; ids: string[] };

const REASONS: Array<{ kind: 'anchor' | 'policy' | 'rule-set'; re: RegExp }> = [
  { kind: 'anchor', re: /^anchor "(.+)" not present in base\.yaml$/ },
  { kind: 'policy', re: /^policy "(.+?)" 不存在/ },
  { kind: 'rule-set', re: /^RULE-SET 引用的规则集 "(.+?)" 不在规则集库中/ },
];

export function groupOrphans(orphans: Orphan[], rulesById: Map<string, Rule>): OrphanGroup[] {
  const groups: OrphanGroup[] = [];
  const byKey = new Map<string, OrphanGroup>();
  for (const orphan of orphans) {
    const literal = /^rules:line (\d+)$/.exec(orphan.rule_id);
    if (literal) {
      groups.push({
        kind: 'literal-rule',
        line: Number(literal[1]),
        text: /「(.+)」/.exec(orphan.reason)?.[1] ?? '',
      });
      continue;
    }
    if (orphan.rule_id === 'rule-providers:marker') {
      groups.push({ kind: 'providers-marker', reason: orphan.reason });
      continue;
    }
    const provider = /^rule-providers:(.+)$/.exec(orphan.rule_id);
    if (provider) {
      groups.push({ kind: 'literal-provider', name: provider[1] });
      continue;
    }
    const known = REASONS.map(({ kind, re }) => ({ kind, match: re.exec(orphan.reason) })).find((r) => r.match);
    if (known?.match) {
      const key = `${known.kind}:${known.match[1]}`;
      let group = byKey.get(key);
      if (!group) {
        group = { kind: known.kind, name: known.match[1], rules: [] };
        byKey.set(key, group);
        groups.push(group);
      }
      if (group.kind === known.kind) {
        (group as Extract<OrphanGroup, { rules: unknown }>).rules.push({
          id: orphan.rule_id,
          rule: rulesById.get(orphan.rule_id),
        });
      }
      continue;
    }
    const key = `other:${orphan.reason}`;
    const existing = byKey.get(key);
    if (existing && existing.kind === 'other') existing.ids.push(orphan.rule_id);
    else {
      const group: OrphanGroup = { kind: 'other', reason: orphan.reason, ids: [orphan.rule_id] };
      byKey.set(key, group);
      groups.push(group);
    }
  }
  return groups;
}

/** How many managed rules a set of orphan groups would knock out. */
export function affectedRuleCount(groups: OrphanGroup[]): number {
  return groups.reduce(
    (sum, g) => sum + ('rules' in g ? g.rules.length : g.kind === 'other' ? g.ids.length : 0),
    0,
  );
}

/** Pull `{rule_id, reason}` entries out of a 422 problem document. */
export function orphansFromError(error: unknown): Orphan[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const raw = error.raw as { errors?: unknown } | null;
  if (!raw || !Array.isArray(raw.errors)) return null;
  const list = raw.errors.filter(
    (e): e is Orphan =>
      !!e && typeof e === 'object' && typeof (e as Orphan).rule_id === 'string' && typeof (e as Orphan).reason === 'string',
  );
  return list.length ? list : null;
}
