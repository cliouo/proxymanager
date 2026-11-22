import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProxyGroupSchema, RuleSchema, type Profile, type Subscription, type ProxyGroup, type Rule } from '@/schemas';
import type { NamingProfileChange } from '@/schemas/namingProfileChanges';
import type { NamingHistoryPlan } from '@/lib/repos/namingHistoryRepo';
import type { ProfileConfigState } from '@/lib/services/configPreflight';
import { ProblemDetailsError } from '@/lib/http/problem';

const db = vi.hoisted(() => ({
  entity: {} as Subscription,
  profiles: [] as Profile[], groups: new Map<string, ProxyGroup[]>(), rules: new Map<string, Rule[]>(),
  patches: [] as NamingProfileChange[], history: null as NamingHistoryPlan | null,
  version: 7, failedProfile: '', blocked: false, casConflict: false,
  checked: [] as ProfileConfigState[], commits: 0,
}));
const session = vi.hoisted(() => ({ seal: () => ({ expectedGeneration: 0, expectedGlobalSize: 0, sources: [] }) }));
vi.mock('@/lib/repos/configVersionRepo', () => ({ getConfigVersion: async () => db.version }));
vi.mock('@/lib/repos/profilesRepo', () => ({ listProfiles: async () => db.profiles }));
vi.mock('@/lib/repos/subscriptionsRepo', () => ({ listSubscriptions: async () => [db.entity] }));
vi.mock('@/lib/repos/collectionsRepo', () => ({ listCollections: async () => [] }));
vi.mock('@/lib/services/subscriptionService', () => ({ getSubscription: async () => db.entity, nowSeconds: () => 100 }));
vi.mock('@/lib/repos/resolvedRepo', () => ({ invalidateResolvedSnapshot: async () => undefined }));
vi.mock('@/lib/repos/namingHistoryRepo', () => ({ getNamingHistory: async () => db.history }));
vi.mock('@/lib/repos/nodeOrdinalRepo', async (original) => ({ ...await original<object>(), getOrdinalGeneration: async () => 0 }));
vi.mock('@/lib/services/nodeOrdinalService', async (original) => ({ ...await original<object>(), createOrdinalPlanningSession: async () => session }));
vi.mock('@/lib/services/namingCandidateService', () => ({
  loadNamingCandidateContext: async () => ({
    analyze: async () => ({ blocked: db.blocked }),
    changesFor: () => {
      if (db.blocked) throw ProblemDetailsError.unprocessable('ambiguous reference');
      return db.patches;
    },
    subscriptionSnapshot: new Map(), ordinalPlanningSession: session,
  }),
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: async (id: string, build: (state: ProfileConfigState) => object) => {
    const state: ProfileConfigState = { profile: db.profiles.find((p) => p.id === id)!,
      baseContent: '', subscriptions: [db.entity], collections: [], devices: [], templates: [], ruleSets: [],
      proxyGroups: db.groups.get(id) ?? [], rules: db.rules.get(id) ?? [] };
    const candidate = { ...state, ...await build(state) };
    db.checked.push(candidate);
    if (id === db.failedProfile) throw new Error('render rejected candidate');
    return { configVersion: db.version, ordinalGeneration: 0, candidate };
  },
}));
vi.mock('@/lib/repos/namingCasRepo', () => ({
  MAX_NAMING_HISTORY_BYTES: 65536,
  commitEntityWithNamingHistory: async (options: {
    recordJson: string; expectedVersion: number; profileChanges: NamingProfileChange[];
    history: { op: string; value: string }; audit: { payloadJson: string };
  }) => {
    db.commits += 1;
    if (db.casConflict || options.expectedVersion !== db.version) return { ok: false };
    db.entity = JSON.parse(options.recordJson);
    db.history = options.history.op === 'set' ? JSON.parse(options.history.value) : null;
    for (const patch of options.profileChanges) {
      db.groups.set(patch.profileId, (db.groups.get(patch.profileId) ?? []).map((g) => patch.groups.find((p) => p.before.id === g.id)?.after ?? g));
      db.rules.set(patch.profileId, (db.rules.get(patch.profileId) ?? []).map((r) => patch.rules.find((p) => p.before.id === r.id)?.after ?? r));
    }
    const audit = JSON.parse(options.audit.payloadJson);
    expect(audit.after.migration.profiles).toBe(db.patches.length);
    db.version += 1;
    return { ok: true };
  },
}));

import { applyNamingPlan, rollbackNamingPlan } from '@/lib/services/namingApplyService';

const ID = '11111111-1111-4111-8111-111111111111';
const P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const audit = { actor: 'user', scope: 'global' as const };
const apply = () => applyNamingPlan('subscription', ID, { template: '${region_code} ${index}' }, { audit, expectedVersion: 7, migrateGroups: true });
const snapshot = () => JSON.stringify({ entity: db.entity, history: db.history, version: db.version, groups: [...db.groups], rules: [...db.rules] });

beforeEach(() => {
  db.entity = { id: ID, name: 'airport', enabled: true, kind: 'local', content: 'unused', ttl_ms: 1000, tags: [], operators: [] } as Subscription;
  db.profiles = [P1, P2].map((id, i) => ({ id, name: `profile-${i}`, kind: 'normal', source: { type: 'subscription' as const, id: ID }, updated_at: 1 }));
  db.groups.clear(); db.rules.clear(); db.checked = []; db.patches = [];
  db.history = null; db.version = 7; db.failedProfile = ''; db.blocked = false; db.casConflict = false; db.commits = 0;
  for (const profile of db.profiles) {
    const beforeGroup = ProxyGroupSchema.parse({ id: profile.id, kind: 'manual', name: 'Group', type: 'select', rank: 0, updated_at: 1,
      'include-all-proxies': true, filter: '^old$', proxies: ['old'], 'dialer-proxy': 'old', notes: 'preserve me' });
    const beforeRule = RuleSchema.parse({ id: profile.id, anchor: 'RULES', type: 'DOMAIN', value: 'example.com', policy: 'old', rank: 0, source: 'manual', added_at: 1, updated_at: 1, revision: 1 });
    db.groups.set(profile.id, [beforeGroup]); db.rules.set(profile.id, [beforeRule]);
    db.patches.push({ profileId: profile.id,
      groups: [{ before: beforeGroup, after: { ...beforeGroup, filter: '^HK 01$', proxies: ['HK 01'], 'dialer-proxy': 'HK 01', updated_at: 2 } }],
      rules: [{ before: beforeRule, after: { ...beforeRule, policy: 'HK 01', updated_at: 2, revision: 8 } }],
    });
  }
});

describe('atomic naming + profile migration orchestration', () => {
  it('preflights all consumers with template, filters, manual, rule and dialer rewrites, then rolls everything back', async () => {
    await apply();
    expect(db.version).toBe(8);
    expect(db.commits).toBe(1);
    expect(db.checked).toHaveLength(2);
    for (const checked of db.checked) {
      expect(checked.proxyGroups[0].filter).toBe('^HK 01$');
      expect(checked.proxyGroups[0].proxies).toEqual(['HK 01']);
      expect(checked.proxyGroups[0]['dialer-proxy']).toBe('HK 01');
      expect(checked.rules[0].policy).toBe('HK 01');
      expect(checked.subscriptions[0].operators[0].kind).toBe('rename-template');
    }
    expect(db.history?.profileChanges).toHaveLength(2);
    db.checked = [];
    await rollbackNamingPlan('subscription', ID, { audit, expectedVersion: 8 });
    expect(db.version).toBe(9);
    expect(db.history).toBeNull();
    expect(db.entity.operators).toEqual([]);
    expect(db.checked).toHaveLength(2);
    for (const id of [P1, P2]) {
      expect(db.groups.get(id)?.[0]).toMatchObject({ filter: '^old$', proxies: ['old'], 'dialer-proxy': 'old', notes: 'preserve me' });
      expect(db.rules.get(id)?.[0]).toMatchObject({ policy: 'old', revision: 9 });
    }
  });

  it('writes nothing, including history, when any consumer preflight fails', async () => {
    db.failedProfile = P2;
    const before = snapshot();
    await expect(apply()).rejects.toThrow('render rejected candidate');
    expect(db.checked).toHaveLength(2);
    expect(db.commits).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('does not partially persist migrations when config CAS loses', async () => {
    db.casConflict = true;
    const before = snapshot();
    await expect(apply()).rejects.toMatchObject({ problem: { status: 412 } });
    expect(snapshot()).toBe(before);
  });

  it('blocks ambiguous reference mappings before writes', async () => {
    db.blocked = true;
    const before = snapshot();
    await expect(apply()).rejects.toThrow('ambiguous reference');
    expect(db.commits).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('refuses rollback rather than clobbering subsequent group edits', async () => {
    await apply();
    db.groups.set(P2, [{ ...db.groups.get(P2)![0], notes: 'edited later' }]);
    const before = snapshot();
    await expect(rollbackNamingPlan('subscription', ID, { audit, expectedVersion: 8 })).rejects.toThrow('已被编辑');
    expect(snapshot()).toBe(before);
    expect(db.commits).toBe(1);
  });

  it('rejects stale versions and non-admin migration authority without committing', async () => {
    db.version = 8;
    await expect(apply()).rejects.toMatchObject({ problem: { status: 412 } });
    await expect(applyNamingPlan('subscription', ID, { template: '${region}' }, {
      migrateGroups: true, audit: { actor: 'assistant', profileId: P1 },
    })).rejects.toMatchObject({ problem: { status: 403 } });
    expect(db.commits).toBe(0);
  });
});
