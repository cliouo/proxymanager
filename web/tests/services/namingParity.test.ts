import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { applyRenameTemplate, withRawIdentity } from '@/lib/proxies/naming';
import { sourceOf } from '@/lib/proxies/provenance';
import {
  createOrdinalDomainRegistry,
  createOrdinalPlanningSession,
  OrdinalPlanningError,
  resolveOrdinalsFor,
} from '@/lib/services/nodeOrdinalService';
import {
  ASSIGN_ORDINALS_LUA,
  MAX_ORDINAL,
  MAX_TOTAL_ASSIGNMENTS,
  ORDINAL_SNAPSHOT_LUA,
} from '@/lib/repos/nodeOrdinalRepo';

const hashes = new Map<string, Map<string, string>>();
const strings = new Map<string, string>();
const wrongTypes = new Map<string, string>();

function hash(key: string): Map<string, string> {
  let value = hashes.get(key);
  if (!value) {
    value = new Map();
    hashes.set(key, value);
  }
  return value;
}

function keyType(key: string): string {
  return (
    wrongTypes.get(key) ??
    (hashes.has(key)
      ? 'hash'
      : strings.has(key) ||
          key === REDIS_KEYS.configVersion ||
          key === REDIS_KEYS.nodeOrdinalGeneration ||
          key.startsWith('node-ordinal-counter:')
        ? 'string'
        : 'none')
  );
}

const fakeRedis = {
  get: async (key: string) => strings.get(key) ?? null,
  eval: async (script: string, keys: string[], args: string[]) => {
    if (script === ORDINAL_SNAPSHOT_LUA) {
      if (!['hash', 'none'].includes(keyType(keys[0]))) return [2, 'hash-wrongtype'];
      if (!['string', 'none'].includes(keyType(keys[1]))) return [2, 'generation-wrongtype'];
      const pairs = [...hash(keys[0])].flatMap(([field, value]) => [field, value]);
      const counters = args.map((counterKey) =>
        ['string', 'none'].includes(keyType(counterKey))
          ? (strings.get(counterKey) ?? null)
          : [2, 'counter-wrongtype'],
      );
      return [0, pairs, hash(keys[0]).size, strings.get(keys[1]) ?? null, ...counters];
    }
    expect(script).toBe(ASSIGN_ORDINALS_LUA);
    if (strings.get(keys[2]) !== args[2]) return ['__error__', 'stale-config'];
    if (
      ![keys[0], keys[1], keys[2], keys[3]].every((key, i) => {
        const expected = i === 0 ? ['hash', 'none'] : ['string', 'none'];
        return expected.includes(keyType(key));
      })
    )
      return ['__error__', 'wrongtype'];

    const generationRaw = strings.get(keys[3]) ?? '0';
    if (
      !/^(0|[1-9][0-9]*)$/.test(generationRaw) ||
      !Number.isSafeInteger(Number(generationRaw)) ||
      Number(generationRaw) > Number.MAX_SAFE_INTEGER - 1
    ) {
      return ['__error__', 'generation-overflow'];
    }

    const store = hash(keys[0]);
    const sourcePrefix = args[3];
    const sourceEntries = [...store].filter(([field]) => field.startsWith(sourcePrefix));
    const seenExisting = new Set<string>();
    for (const [, value] of sourceEntries) {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > MAX_ORDINAL) continue;
      if (seenExisting.has(value)) return ['__error__', 'ordinal-existing-duplicate'];
      seenExisting.add(value);
    }
    const maxExisting = Math.max(
      0,
      ...sourceEntries.map(([, value]) => (/^[1-9][0-9]*$/.test(value) ? Number(value) : 0)),
    );
    const counterRaw = strings.get(keys[1]);
    let counter =
      counterRaw && /^(0|[1-9][0-9]*)$/.test(counterRaw) && Number.isSafeInteger(Number(counterRaw))
        ? Math.max(Number(counterRaw), maxExisting)
        : maxExisting;
    let sourceSize = sourceEntries.length;
    let wrote = false;
    const out: Array<string | number> = [];
    for (const field of args.slice(4)) {
      const existing = store.get(field);
      if (existing !== undefined) {
        out.push(/^[1-9][0-9]*$/.test(existing) && Number(existing) <= MAX_ORDINAL ? existing : '');
        continue;
      }
      const next = counter + 1;
      if (
        store.size + 1 > MAX_TOTAL_ASSIGNMENTS ||
        sourceSize + 1 > MAX_TOTAL_ASSIGNMENTS ||
        next > MAX_ORDINAL
      ) {
        out.push('');
        continue;
      }
      store.set(field, String(next));
      counter = next;
      sourceSize += 1;
      wrote = true;
      out.push(next);
    }
    if (wrote) {
      strings.set(keys[1], String(counter));
      strings.set(keys[3], String(Number(strings.get(keys[3]) ?? '0') + 1));
    }
    return out;
  },
};

vi.mock('@/lib/redis/client', () => ({ getRedis: () => fakeRedis }));

const TEMPLATE = '${emoji} ${region}${?source: · ${source}}${?index: · ${index}}';
const IDENTITY = { key: 'airport-a', label: '机场A' };

function node(name: string, server: string): Record<string, unknown> {
  return withRawIdentity({ name, type: 'ss', server, port: 443, cipher: 'aes-128-gcm' }, IDENTITY);
}

function names(
  proxies: Record<string, unknown>[],
  ordinals: Awaited<ReturnType<typeof resolveOrdinalsFor>>,
): string[] {
  return applyRenameTemplate(
    proxies,
    { template: TEMPLATE, sourceAliases: {}, recognitionRules: [] },
    sourceOf,
    ordinals,
  ).proxies.map((proxy) => proxy.name as string);
}

beforeEach(() => {
  hashes.clear();
  strings.clear();
  wrongTypes.clear();
  strings.set(REDIS_KEYS.configVersion, '7');
});

describe('shared ordinal planning and serving parity', () => {
  it('reserves the full raw domain once across source filtering and collection naming', async () => {
    const raw = [node('美国 alpha', 'a.example'), node('日本 beta', 'b.example')];
    const session = await createOrdinalPlanningSession([IDENTITY.key]);
    session.registerSourceDomain(raw, () => IDENTITY);

    // Source operators leave only B; the collection stage must still reuse
    // the full raw A/B plan instead of independently predicting B=1.
    const filtered = [raw[1]];
    const resolver = await resolveOrdinalsFor(filtered, sourceOf, {
      persist: false,
      template: TEMPLATE,
      recognitionRules: [],
      planningSession: session,
      domainRegistry: session,
    });
    expect(resolver(raw[1], IDENTITY.key)).toBe(2);
    expect(names(filtered, resolver)).toEqual(['🇯🇵 日本 · 机场A · 02']);
    expect(session.seal()).toMatchObject({
      expectedGeneration: 0,
      sources: [
        {
          sourceKey: IDENTITY.key,
          fields: [{ ordinal: 1 }, { ordinal: 2 }],
          nextCounter: 2,
        },
      ],
    });
    expect(hash(REDIS_KEYS.nodeOrdinals).size).toBe(0);
  });

  it('preview and first serving render agree; upstream suffixes display upstream but still reserve', async () => {
    const raw = [node('香港 05', 'a.example'), node('日本 beta', 'b.example')];
    const session = await createOrdinalPlanningSession([IDENTITY.key]);
    session.registerSourceDomain(raw, () => IDENTITY);
    const preview = await resolveOrdinalsFor(raw, sourceOf, {
      persist: false,
      template: TEMPLATE,
      recognitionRules: [],
      planningSession: session,
    });
    expect(names(raw, preview)).toEqual(['🇭🇰 香港 · 机场A · 05', '🇯🇵 日本 · 机场A · 02']);
    expect(hash(REDIS_KEYS.nodeOrdinals).size).toBe(0);

    const registry = createOrdinalDomainRegistry();
    registry.registerSourceDomain(raw, () => IDENTITY);
    const serving = await resolveOrdinalsFor(raw, sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: registry,
    });
    expect(names(raw, serving)).toEqual(names(raw, preview));
    expect(hash(REDIS_KEYS.nodeOrdinals).size).toBe(2);
  });

  it('preview and serving both self-heal a leading-zero counter from ordinal 1', async () => {
    strings.set(REDIS_KEYS.nodeOrdinalCounter(IDENTITY.key), '01');
    const raw = [node('日本 alpha', 'a.example')];
    const session = await createOrdinalPlanningSession([IDENTITY.key]);
    session.registerSourceDomain(raw, () => IDENTITY);
    const preview = await resolveOrdinalsFor(raw, sourceOf, {
      persist: false,
      template: TEMPLATE,
      recognitionRules: [],
      planningSession: session,
    });
    expect(preview(raw[0], IDENTITY.key)).toBe(1);
    expect(session.seal().sources[0]).toMatchObject({
      expectedCounterRaw: '01',
      nextCounter: 1,
      fields: [{ ordinal: 1 }],
    });

    const registry = createOrdinalDomainRegistry();
    registry.registerSourceDomain(raw, () => IDENTITY);
    const serving = await resolveOrdinalsFor(raw, sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: registry,
    });
    expect(serving(raw[0], IDENTITY.key)).toBe(1);
    expect(strings.get(REDIS_KEYS.nodeOrdinalCounter(IDENTITY.key))).toBe('1');
  });

  it('preview and serving both self-heal an above-safe counter from ordinal 1', async () => {
    strings.set(REDIS_KEYS.nodeOrdinalCounter(IDENTITY.key), '9007199254740992');
    const raw = [node('日本 alpha', 'a.example')];
    const session = await createOrdinalPlanningSession([IDENTITY.key]);
    session.registerSourceDomain(raw, () => IDENTITY);
    const preview = await resolveOrdinalsFor(raw, sourceOf, {
      persist: false,
      template: TEMPLATE,
      recognitionRules: [],
      planningSession: session,
    });
    expect(preview(raw[0], IDENTITY.key)).toBe(1);
    expect(session.seal().sources[0]).toMatchObject({
      expectedCounterRaw: '9007199254740992',
      nextCounter: 1,
      fields: [{ ordinal: 1 }],
    });

    const registry = createOrdinalDomainRegistry();
    registry.registerSourceDomain(raw, () => IDENTITY);
    const serving = await resolveOrdinalsFor(raw, sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: registry,
    });
    expect(serving(raw[0], IDENTITY.key)).toBe(1);
    expect(strings.get(REDIS_KEYS.nodeOrdinalCounter(IDENTITY.key))).toBe('1');
  });

  it('preview and serving reject an ordinal generation that cannot be incremented', async () => {
    strings.set(REDIS_KEYS.nodeOrdinalGeneration, String(Number.MAX_SAFE_INTEGER));
    const raw = [node('日本 alpha', 'a.example')];
    await expect(
      resolveOrdinalsFor(raw, sourceOf, {
        persist: false,
        template: TEMPLATE,
        recognitionRules: [],
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);

    const registry = createOrdinalDomainRegistry();
    registry.registerSourceDomain(raw, () => IDENTITY);
    await expect(
      resolveOrdinalsFor(raw, sourceOf, {
        persist: true,
        template: TEMPLATE,
        recognitionRules: [],
        configVersion: 7,
        domainRegistry: registry,
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);
  });

  it('a serving collection request allocates every newly registered raw node, not its filtered subset', async () => {
    const raw = [node('日本 C', 'c.example'), node('美国 D', 'd.example')];
    const registry = createOrdinalDomainRegistry();
    registry.registerSourceDomain(raw, () => IDENTITY);
    const onlyD = await resolveOrdinalsFor([raw[1]], sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: registry,
    });
    expect(onlyD(raw[1], IDENTITY.key)).toBe(2);
    const onlyC = await resolveOrdinalsFor([raw[0]], sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: registry,
    });
    expect(onlyC(raw[0], IDENTITY.key)).toBe(1);
  });

  it('reordering upstream does not churn persisted ordinals', async () => {
    const raw = [node('日本 A', 'a.example'), node('美国 B', 'b.example')];
    const firstRegistry = createOrdinalDomainRegistry();
    firstRegistry.registerSourceDomain(raw, () => IDENTITY);
    const first = await resolveOrdinalsFor(raw, sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: firstRegistry,
    });
    const reordered = [raw[1], raw[0]];
    const secondRegistry = createOrdinalDomainRegistry();
    secondRegistry.registerSourceDomain(reordered, () => IDENTITY);
    const second = await resolveOrdinalsFor(reordered, sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: secondRegistry,
    });
    expect(new Set(names(reordered, second))).toEqual(new Set(names(raw, first)));
  });

  it('fails closed at the global/per-source cap instead of input-order fallback churn', async () => {
    for (let i = 0; i < MAX_TOTAL_ASSIGNMENTS; i += 1) {
      hash(REDIS_KEYS.nodeOrdinals).set(`old:fp-${i}`, String(i + 1));
    }
    const raw = [node('日本 A', 'a.example')];
    await expect(
      resolveOrdinalsFor(raw, sourceOf, {
        persist: false,
        template: TEMPLATE,
        recognitionRules: [],
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);
    await expect(
      resolveOrdinalsFor(raw, sourceOf, {
        persist: true,
        template: TEMPLATE,
        recognitionRules: [],
        configVersion: 7,
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);
  });

  it('fails closed on corrupt snapshot types/counters for an index plan', async () => {
    wrongTypes.set(REDIS_KEYS.nodeOrdinals, 'string');
    await expect(
      resolveOrdinalsFor([node('日本 A', 'a.example')], sourceOf, {
        persist: false,
        template: TEMPLATE,
        recognitionRules: [],
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);
  });

  it('fails closed on fully assigned duplicate ordinals in preview and serving', async () => {
    const raw = [node('日本 A', 'a.example'), node('日本 B', 'b.example')];
    // First use the real fingerprint path to populate two legitimate fields,
    // then corrupt only the second stored ordinal.
    const registry = createOrdinalDomainRegistry();
    registry.registerSourceDomain(raw, () => IDENTITY);
    await resolveOrdinalsFor(raw, sourceOf, {
      persist: true,
      template: TEMPLATE,
      recognitionRules: [],
      configVersion: 7,
      domainRegistry: registry,
    });
    const storedFields = [...hash(REDIS_KEYS.nodeOrdinals).keys()];
    expect(storedFields).toHaveLength(2);
    hash(REDIS_KEYS.nodeOrdinals).set(storedFields[1], '1');
    strings.set(REDIS_KEYS.nodeOrdinalCounter(IDENTITY.key), '1');

    await expect(
      resolveOrdinalsFor(raw, sourceOf, {
        persist: false,
        template: TEMPLATE,
        recognitionRules: [],
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);
    await expect(
      resolveOrdinalsFor(raw, sourceOf, {
        persist: true,
        template: TEMPLATE,
        recognitionRules: [],
        configVersion: 7,
        domainRegistry: registry,
      }),
    ).rejects.toBeInstanceOf(OrdinalPlanningError);
  });

  it('handles a 20k duplicate-heavy raw domain without quadratic dedupe', async () => {
    const unique = Array.from({ length: 10_000 }, (_, i) => node(`日本 ${i}`, `${i}.example`));
    const raw = [...unique, ...unique];
    const session = await createOrdinalPlanningSession([IDENTITY.key]);
    session.registerSourceDomain(raw, () => IDENTITY);
    const resolver = await resolveOrdinalsFor(raw, sourceOf, {
      persist: false,
      template: TEMPLATE,
      recognitionRules: [],
      planningSession: session,
    });
    expect(resolver(unique.at(-1), IDENTITY.key)).toBe(10_000);
    expect(session.seal().sources[0].fields).toHaveLength(10_000);
  }, 60_000);
});
