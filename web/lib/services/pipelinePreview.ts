/**
 * Node-processing preview payloads + structured, credential-free issues.
 *
 * Both preview endpoints (subscription + collection) share this so the
 * workbench sees one issue vocabulary:
 *   - duplicate final names — a rename/filter combination that leaves two
 *     nodes with the same name (the Mihomo validator rejects those, and the
 *     rename-template executor disambiguates with ` #N` — reported here);
 *   - resolved rename collisions — formatted duplicates the rename-template
 *     step disambiguated (informational);
 *   - orphaned references — nodes a proxy-group member / chain backend /
 *     rule policy pins by name that a rename or filter would drop.
 *
 * Issues contain node/group/rule handles only — never credentials, URLs or
 * raw proxy fields.
 */

import { findNodeReferences, type NodeReference } from '@/lib/services/nodeReferenceService';
import { redactSensitiveText } from '@/lib/proxies/namingSanitize';
import { listProfiles } from '@/lib/repos/profilesRepo';
import type { OperatorStep } from '@/lib/proxies/operators';
import { buildSourceAliasScope } from '@/lib/proxies/handleScopes';

/** Cap the node-name lists in preview responses so a huge sub stays light. */
export const NAME_CAP = 300;

/**
 * Issue strings are SCRUBBED + bounded at creation: a credential-shaped node
 * name (full proxy URL, host/IP/port, UUID/token) must never be returned
 * verbatim in structured issues. Opaque enough to stay private, readable
 * enough for the UI to explain and locate the problem.
 */
export function safeIssueText(text: string): string {
  const redacted = redactSensitiveText(text).replace(/\s+/g, ' ').trim();
  return (redacted === '' ? '(已脱敏)' : redacted).slice(0, 64);
}

/** Cap the number of issues of one kind — the workbench lists, not floods. */
export const ISSUE_CAP = 20;

export interface NamesPayload {
  count: number;
  names: string[];
  truncated: boolean;
}

function nameOf(proxy: unknown): string {
  if (proxy && typeof proxy === 'object' && 'name' in proxy) {
    const name = (proxy as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

export function namesPayload(proxies: unknown[]): NamesPayload {
  // Credential-shaped spans (URLs, hosts, IPs, tokens…) are redacted from
  // EVERY management projection — the workbench and workspace previews must
  // never echo them verbatim; bounded semantic text survives.
  const names = proxies.slice(0, NAME_CAP).map((p) => safeIssueText(nameOf(p) || '(无名)'));
  return { count: proxies.length, names, truncated: proxies.length > NAME_CAP };
}

export type PreviewIssue =
  | {
      code: 'duplicate-final-name';
      name: string;
      count: number;
    }
  | {
      code: 'rename-collision-resolved';
      name: string;
    }
  | {
      code: 'true-dedup';
      kept: string;
      dropped: string;
    }
  | {
      code: 'orphaned-reference';
      kind: NodeReference['kind'];
      node: string;
      via: string;
    };

/** Duplicate names in the FINAL list (post-pipeline) — scrubbed for issues. */
export function duplicateFinalNames(after: unknown[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of after) {
    const name = nameOf(p);
    if (name === '') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, ISSUE_CAP)
    .map(([name, count]) => ({ name: safeIssueText(name), count }));
}

/** Formatted-name collisions the rename-template step resolved — scrubbed. */
export function renameTemplateCollisions(steps: OperatorStep[]): string[] {
  const out: string[] = [];
  for (const step of steps) {
    if (step.applied && step.collisions && step.collisions.length > 0) {
      out.push(...step.collisions);
    }
  }
  return [...new Set(out)].slice(0, ISSUE_CAP).map(safeIssueText);
}

/**
 * TRUE duplicates the rename-template step removed by node identity (same
 * node config, different display names) — the source-priority dedup policy in
 * action. Entries are already bounded+redacted at creation in the engine;
 * safeIssueText is defense-in-depth.
 */
function trueDedupIssues(steps: OperatorStep[]): PreviewIssue[] {
  const out: PreviewIssue[] = [];
  for (const step of steps) {
    if (!step.applied || !step.deduped || step.deduped.length === 0) continue;
    for (const d of step.deduped) {
      out.push({
        code: 'true-dedup',
        kept: safeIssueText(d.kept),
        dropped: safeIssueText(d.dropped),
      });
      if (out.length >= ISSUE_CAP) return out;
    }
  }
  return out;
}

/**
 * Dedup diagnostics from the SHARED final dedup state machine
 * (lib/proxies/nodeDedup) that the preview routes run after their operator
 * pipelines — the same machine render/single-export/collection-export use.
 * Each entry is scrubbed + bounded (ISSUE_CAP); huge previews report at most
 * ISSUE_CAP of each kind, exactly like every other issue class.
 */
export function dedupMachineIssues(diagnostics: {
  deduped: Array<{ kept: string; dropped: string }>;
  resolved: Array<{ from: string; to: string }>;
}): PreviewIssue[] {
  const out: PreviewIssue[] = [];
  for (const d of diagnostics.deduped) {
    out.push({
      code: 'true-dedup',
      kept: safeIssueText(d.kept),
      dropped: safeIssueText(d.dropped),
    });
    if (out.length >= ISSUE_CAP) return out;
  }
  for (const r of diagnostics.resolved) {
    out.push({ code: 'rename-collision-resolved', name: safeIssueText(r.from) });
    if (out.length >= ISSUE_CAP) return out;
  }
  return out;
}

/**
 * Find references that a rename/filter would orphan: names present before the
 * pipeline but gone after it (renamed or dropped) that some profile's
 * proxy-group member / chain backend / rule policy pins by name.
 *
 * Scans every profile (few) — the preview endpoint is source-scoped, so the
 * conservative interpretation is "any consumer that could be affected".
 */
export async function orphanedReferenceIssues(
  before: unknown[],
  after: unknown[],
): Promise<PreviewIssue[]> {
  const beforeNames = new Set<string>();
  for (const p of before) {
    const name = nameOf(p);
    if (name !== '') beforeNames.add(name);
  }
  const afterNames = new Set<string>();
  for (const p of after) {
    const name = nameOf(p);
    if (name !== '') afterNames.add(name);
  }
  const disappeared = [...beforeNames].filter((n) => !afterNames.has(n));
  if (disappeared.length === 0) return [];

  const profiles = await listProfiles();
  const issues: PreviewIssue[] = [];
  for (const profile of profiles) {
    const refs = await findNodeReferences(profile.id, disappeared);
    for (const ref of refs) {
      issues.push({
        code: 'orphaned-reference',
        kind: ref.kind,
        node: safeIssueText(ref.node),
        via: safeIssueText(ref.via),
      });
      if (issues.length >= ISSUE_CAP) return issues;
    }
  }
  return issues;
}

/** Full issue set for a preview response. */
export async function buildPreviewIssues(
  before: unknown[],
  after: unknown[],
  steps: OperatorStep[],
): Promise<PreviewIssue[]> {
  const issues: PreviewIssue[] = [
    ...duplicateFinalNames(after).map((d) => ({ code: 'duplicate-final-name' as const, ...d })),
    ...renameTemplateCollisions(steps).map((name) => ({
      code: 'rename-collision-resolved' as const,
      name,
    })),
    ...trueDedupIssues(steps),
    ...(await orphanedReferenceIssues(before, after)),
  ];
  return issues.slice(0, ISSUE_CAP * 3);
}

/** Project preview steps: rename-template dedup provenance carries stable
 * source keys — keyed src handles only (pass-7 blocker 1). */
export function projectStepsSourceKeys(steps: OperatorStep[]): OperatorStep[] {
  // round-1: ONE collision-checked index over the COMPLETE source-key domain
  // across ALL steps before any projection — ambiguous src- handles never
  // reach a preview
  const scope = buildSourceAliasScope(
    steps.flatMap((step) =>
      (step.deduped ?? []).flatMap((d) => (d.sourceKey !== undefined ? [d.sourceKey] : [])),
    ),
  );
  return steps.map((step) =>
    step.deduped === undefined
      ? step
      : {
          ...step,
          deduped: step.deduped.map((d) => ({
            ...d,
            ...(d.sourceKey !== undefined ? { sourceKey: scope.project(d.sourceKey) } : {}),
          })),
        },
  );
}

/** Member-fetch diagnostics scrubbed for preview responses (name AND error). */
export function safeMemberErrors(
  members: Array<{ name: string; error: string }> | undefined,
): Array<{ name: string; error: string }> | undefined {
  if (!members || members.length === 0) return members;
  return members.map((m) => ({
    name: safeIssueText(m.name),
    error: safeIssueText(m.error).slice(0, 120),
  }));
}
