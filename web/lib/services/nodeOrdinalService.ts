/**
 * Stable-numbering ordinal snapshot for managed naming.
 *
 * Resolves the {@link OrdinalResolver} a rename-template executor needs:
 *   - serving paths (render / export / collection stage) call with
 *     `persist: true` — atomic get-or-assign via the repo, so every caller
 *     uses the SAME authoritative ordinal and new assignments are published
 *     with the render that served them;
 *   - preview / save-preflight / assistant paths call with `persist: false`
 *     — read-only snapshot; an abandoned candidate can never change what is
 *     served (criterion 14).
 *
 * PARITY: every fingerprint in the complete raw source domain reserves an
 * ordinal, including nodes whose current stage name has an upstream suffix.
 * The rename executor may display that upstream suffix, but it cannot change
 * the reservation sequence seen by another collection/profile policy.
 *
 * Identity comes from the envelope's immutable raw fingerprint first (the
 * same node keeps the same assignment across source and collection stages);
 * envelope-less test inputs fall back to computing the canonical hash from
 * the current object.
 */

import {
  nodeFingerprint,
  templateUsesIndexField,
  type OrdinalResolver,
  type RecognitionRule,
} from '@/lib/proxies/naming';
import { fingerprintOf, sourceOf, type SourceIdentity } from '@/lib/proxies/provenance';
import {
  allocateOrdinal,
  assignOrdinals,
  MAX_ORDINAL,
  MAX_TOTAL_ASSIGNMENTS,
  parseOrdinalCounter,
  readOrdinalStore,
  type OrdinalStoreSnapshot,
} from '@/lib/repos/nodeOrdinalRepo';
function identityOf(proxy: unknown): string | null {
  return fingerprintOf(proxy) ?? nodeFingerprint(proxy);
}

export class OrdinalPlanningError extends Error {
  constructor() {
    super('节点编号状态无法生成稳定计划，请刷新后重试。');
    this.name = 'OrdinalPlanningError';
  }
}

export interface OrdinalReservationPlan {
  expectedGeneration: number;
  expectedGlobalSize: number;
  sources: Array<{
    sourceKey: string;
    expectedCounterRaw: string | null;
    expectedSourceSize: number;
    nextCounter: number;
    fields: Array<{ fingerprint: string; ordinal: number }>;
  }>;
}

export interface OrdinalDomainRegistry {
  registerSourceDomain(
    proxies: readonly unknown[],
    sourceOfProxy?: (proxy: unknown) => SourceIdentity | undefined,
  ): void;
  fingerprintsForSource(sourceKey: string): readonly string[] | undefined;
}

class RuntimeOrdinalDomainRegistry implements OrdinalDomainRegistry {
  private readonly domains = new Map<string, string[]>();

  registerSourceDomain(
    proxies: readonly unknown[],
    sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
  ): void {
    registerDomains(this.domains, proxies, sourceOfProxy);
  }

  fingerprintsForSource(sourceKey: string): readonly string[] | undefined {
    return this.domains.get(sourceKey);
  }
}

function registerDomains(
  domains: Map<string, string[]>,
  proxies: readonly unknown[],
  sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined,
): void {
  const grouped = new Map<string, { order: string[]; seen: Set<string> }>();
  for (const proxy of proxies) {
    const source = sourceOfProxy(proxy);
    const fp = identityOf(proxy);
    if (!source || source.key === '' || fp === null) continue;
    const entries = grouped.get(source.key) ?? { order: [], seen: new Set<string>() };
    if (!entries.seen.has(fp)) {
      entries.seen.add(fp);
      entries.order.push(fp);
    }
    grouped.set(source.key, entries);
  }
  for (const [sourceKey, { order: entries }] of grouped) {
    const prior = domains.get(sourceKey);
    if (prior && (prior.length !== entries.length || prior.some((fp, i) => fp !== entries[i]))) {
      throw new OrdinalPlanningError();
    }
    if (!prior) domains.set(sourceKey, entries);
  }
}

export function createOrdinalDomainRegistry(): OrdinalDomainRegistry {
  return new RuntimeOrdinalDomainRegistry();
}

/**
 * One operation-local, read-only planning snapshot. Every source and
 * collection stage in the same save reuses this object, so a source-level
 * filter cannot make the collection stage independently renumber a surviving
 * fingerprint from the original Redis snapshot.
 */
export class OrdinalPlanningSession {
  private readonly domains = new Map<string, string[]>();
  private readonly proposals = new Map<string, Array<{ fingerprint: string; ordinal: number }>>();
  private plannedAssignmentCount = 0;

  constructor(private readonly snapshot: OrdinalStoreSnapshot) {}

  registerSourceDomain(
    proxies: readonly unknown[],
    sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
  ): void {
    registerDomains(this.domains, proxies, sourceOfProxy);
  }

  fingerprintsForSource(sourceKey: string): readonly string[] | undefined {
    return this.domains.get(sourceKey);
  }

  resolverFor(
    proxies: readonly unknown[],
    sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
  ): OrdinalResolver {
    if (this.snapshot.hashBroken || this.snapshot.generation === null) {
      throw new OrdinalPlanningError();
    }
    const requestedBySource = new Map<string, { order: string[]; seen: Set<string> }>();
    for (const proxy of proxies) {
      const source = sourceOfProxy(proxy);
      const fp = identityOf(proxy);
      if (!source?.key || fp === null) continue;
      const entries = requestedBySource.get(source.key) ?? { order: [], seen: new Set<string>() };
      if (!entries.seen.has(fp)) {
        entries.seen.add(fp);
        entries.order.push(fp);
      }
      requestedBySource.set(source.key, entries);
    }
    for (const [sourceKey, { order: entries }] of requestedBySource) {
      const domain = this.domains.get(sourceKey);
      if (!domain) {
        // Standalone preview callers may not have an explicit ingestion hook;
        // their current input is the complete domain they can observe.
        this.domains.set(sourceKey, entries);
      } else {
        const domainSet = new Set(domain);
        if (entries.some((fp) => !domainSet.has(fp))) throw new OrdinalPlanningError();
      }
    }
    for (const sourceKey of requestedBySource.keys()) this.reserveSource(sourceKey);
    return (proxy, sourceKey) => {
      const fp = identityOf(proxy);
      return fp === null ? undefined : this.snapshot.assignments.get(sourceKey)?.get(fp);
    };
  }

  private reserveSource(sourceKey: string): void {
    if (this.proposals.has(sourceKey)) return;
    if (
      this.snapshot.counterBroken.has(sourceKey) ||
      this.snapshot.duplicateSources.has(sourceKey)
    ) {
      throw new OrdinalPlanningError();
    }
    const domain = this.domains.get(sourceKey);
    if (!domain) throw new OrdinalPlanningError();
    const bucket = this.snapshot.assignments.get(sourceKey) ?? new Map<string, number>();
    this.snapshot.assignments.set(sourceKey, bucket);
    const invalid = this.snapshot.invalidFields.get(sourceKey) ?? new Set<string>();
    const expectedSourceSize = this.snapshot.hlenBySource.get(sourceKey) ?? 0;
    const expectedCounterRaw = this.snapshot.counters.get(sourceKey) ?? null;
    const maxExisting = Math.max(0, ...bucket.values());
    const parsedCounter = parseOrdinalCounter(expectedCounterRaw);
    let counter =
      parsedCounter === null || parsedCounter < maxExisting ? maxExisting : parsedCounter;
    const fields: Array<{ fingerprint: string; ordinal: number }> = [];
    const plannedBefore = this.plannedAssignmentCount;
    for (const fp of domain) {
      if (invalid.has(fp)) throw new OrdinalPlanningError();
      if (bucket.has(fp)) continue;
      if (this.snapshot.globalSize + plannedBefore + fields.length + 1 > MAX_TOTAL_ASSIGNMENTS) {
        throw new OrdinalPlanningError();
      }
      const ordinal = allocateOrdinal(String(counter), expectedSourceSize + fields.length, {
        hashCap: MAX_TOTAL_ASSIGNMENTS,
        maxOrdinal: MAX_ORDINAL,
      });
      // A persisted ${index} template may never fall back to input order:
      // reordering would otherwise churn names at the cap boundary.
      if (ordinal === null) throw new OrdinalPlanningError();
      counter = ordinal;
      bucket.set(fp, ordinal);
      fields.push({ fingerprint: fp, ordinal });
    }
    this.proposals.set(sourceKey, fields);
    this.plannedAssignmentCount += fields.length;
  }

  seal(): OrdinalReservationPlan {
    if (this.snapshot.generation === null) throw new OrdinalPlanningError();
    return {
      expectedGeneration: this.snapshot.generation,
      expectedGlobalSize: this.snapshot.globalSize,
      sources: [...this.proposals.entries()]
        .filter(([, fields]) => fields.length > 0)
        .map(([sourceKey, fields]) => ({
          sourceKey,
          expectedCounterRaw: this.snapshot.counters.get(sourceKey) ?? null,
          expectedSourceSize: this.snapshot.hlenBySource.get(sourceKey) ?? 0,
          nextCounter: fields.at(-1)?.ordinal ?? 0,
          fields: fields.map((field) => ({ ...field })),
        })),
    };
  }
}

export async function createOrdinalPlanningSession(
  sourceKeys: readonly string[],
): Promise<OrdinalPlanningSession> {
  return new OrdinalPlanningSession(await readOrdinalStore([...new Set(sourceKeys)]));
}

export async function resolveOrdinalsFor(
  proxies: readonly unknown[],
  sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
  options: {
    persist: boolean;
    /** The managed template — needed to replicate the executor's upstream-ordinal check. */
    template?: string;
    /** The op's saved recognition rules — same check as the executor. */
    recognitionRules?: RecognitionRule[];
    /** Config generation captured before a serving render read its inputs. */
    configVersion?: number;
    /** Shared by every persist:false stage in one save/preflight. */
    planningSession?: OrdinalPlanningSession;
    /** Complete raw domains for serving and preview collection stages. */
    domainRegistry?: OrdinalDomainRegistry;
  },
): Promise<OrdinalResolver> {
  const usesIndex = options.template !== undefined && templateUsesIndexField(options.template);
  if (!usesIndex) return () => undefined;
  const bySource = new Map<string, string[]>();
  for (const proxy of proxies) {
    const source = sourceOfProxy(proxy);
    const fp = identityOf(proxy);
    if (!source || source.key === '' || fp === null) continue;
    const entries = bySource.get(source.key) ?? [];
    entries.push(fp);
    bySource.set(source.key, entries);
  }

  let assignments: Map<string, Map<string, number>>;
  if (options.persist) {
    if (options.configVersion === undefined) {
      throw new Error('Serving ordinal resolution requires a captured config version.');
    }
    const configVersion = options.configVersion;
    assignments = new Map();
    for (const [sourceKey, entries] of bySource) {
      // Reserve the COMPLETE raw source domain in deterministic source order.
      // A policy may still prefer an upstream suffix at render time, but it
      // cannot make a different collection/profile consume a different
      // allocation sequence for the same source.
      const unique = [
        ...new Set(options.domainRegistry?.fingerprintsForSource(sourceKey) ?? entries),
      ];
      if (unique.length === 0) {
        assignments.set(sourceKey, new Map());
        continue;
      }
      const got = await assignOrdinals(sourceKey, unique, configVersion);
      if (got.size !== unique.length) throw new OrdinalPlanningError();
      assignments.set(sourceKey, got);
    }
  } else {
    const session =
      options.planningSession ?? (await createOrdinalPlanningSession([...bySource.keys()]));
    return session.resolverFor(proxies, sourceOfProxy);
  }

  return (proxy, sourceKey) => {
    const fp = identityOf(proxy);
    if (fp === null) return undefined;
    return assignments.get(sourceKey)?.get(fp);
  };
}
