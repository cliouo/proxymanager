import { beforeEach, expect, it, vi } from 'vitest';
import { ruleAnchorAppendScenario } from '@/lib/scenarios/rule-anchor-append/scenario';
import type { OpContext } from '@/lib/scenarios/_shared/types';
import type { Rule } from '@/schemas';
const initial: Rule = {
  id: '11111111-1111-4111-8111-111111111111',
  anchor: 'manual',
  type: 'DOMAIN',
  value: 'example.com',
  policy: 'DIRECT',
  rank: 10,
  source: 'manual',
  added_at: 1,
  updated_at: 1,
  revision: 1,
};
let current: Rule;
const remove = vi.fn();
const upsert = vi.fn();
const ctx = {
  profileId: 'profile',
  rules: { get: async () => current, delete: remove, upsert },
} as unknown as OpContext;
beforeEach(() => {
  current = { ...initial };
  vi.clearAllMocks();
});
it('rejects an old form revision even if both writes have the same timestamp', async () => {
  current = { ...initial, revision: 2, policy: 'REJECT' };
  await expect(
    ruleAnchorAppendScenario.ops.patch(ctx, {
      id: initial.id,
      expectedRevision: 1,
      patch: { note: 'new note', policy: 'DIRECT' },
    }),
  ).rejects.toMatchObject({ problem: { status: 412 } });
  expect(upsert).not.toHaveBeenCalled();
});
it.each(['create', 'update'])('refuses stale %s undo within the same second', async (action) => {
  current = { ...initial, revision: 2, note: 'later write' };
  await expect(
    ruleAnchorAppendScenario.inverses![action](ctx, {
      id: crypto.randomUUID(),
      ruleId: initial.id,
      before: initial,
      after: initial,
    }),
  ).rejects.toMatchObject({ problem: { status: 409 } });
  expect(remove).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
});
it('protects legacy snapshots without revisions using complete state comparison', async () => {
  const legacy = { ...initial };
  delete legacy.revision;
  current = { ...legacy, note: 'later same-second change' };
  await expect(
    ruleAnchorAppendScenario.inverses!.create(ctx, {
      id: crypto.randomUUID(),
      ruleId: initial.id,
      after: legacy,
    }),
  ).rejects.toMatchObject({ problem: { status: 409 } });
  expect(remove).not.toHaveBeenCalled();
});
it('allows undo of an unchanged creation', async () => {
  remove.mockResolvedValue(true);
  await ruleAnchorAppendScenario.inverses!.create(ctx, {
    id: crypto.randomUUID(),
    ruleId: initial.id,
    after: initial,
  });
  expect(remove).toHaveBeenCalledWith(initial.id);
});
