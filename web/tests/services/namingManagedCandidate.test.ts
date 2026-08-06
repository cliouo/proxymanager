/**
 * Shared managed-candidate builder (namingManagedCandidate) — literal oracle.
 *
 * One pure builder over the aligned raw OperatorSnapshot serves workspace
 * preview, assistant confirmation preview AND apply. The oracle:
 *   - preserves every non-managed raw row byte-for-byte (parked/malformed
 *     rows included) in identical order;
 *   - preserves an existing managed row's id + index and ENABLES it;
 *   - otherwise inserts at the clamped position with the deterministic first
 *     free id `naming-plan`, `naming-plan-2`, … over EVERY raw string id;
 *   - returns { storage, row, id, index, mode }.
 */

import { describe, expect, it } from 'vitest';
import { buildOperatorSnapshot } from '@/lib/repos/rawOperators';
import { buildManagedCandidate } from '@/lib/services/namingManagedCandidate';
import type { NamingManagedPlan } from '@/lib/services/namingManagedCandidate';

function snapshotOf(operators: unknown[]) {
  return buildOperatorSnapshot({ operators });
}

const PLAN: NamingManagedPlan = {
  template: '${emoji} ${region}',
  tw2cn: true,
  sourceAliases: { 'src-1111111111111111': '机场A' },
  recognitionRules: [{ pattern: '专线', field: 'route', value: '专线' }],
};

describe('buildManagedCandidate — deterministic collision-free allocation', () => {
  it('empty pipeline: inserts at index 0 with id naming-plan, mode added', () => {
    const out = buildManagedCandidate(snapshotOf([]), PLAN);
    expect(out.mode).toBe('added');
    expect(out.id).toBe('naming-plan');
    expect(out.index).toBe(0);
    expect(out.row).toMatchObject({
      id: 'naming-plan',
      kind: 'rename-template',
      template: PLAN.template,
      tw2cn: true,
      sourceAliases: PLAN.sourceAliases,
      recognitionRules: PLAN.recognitionRules,
    });
    expect(out.storage).toEqual([out.row]);
  });

  it('appends after ordinary rows; deterministic across calls', () => {
    const ops = [
      { id: 'f-1', kind: 'flag-emoji', action: 'add' },
      { id: 's-1', kind: 'sort', by: 'name', order: 'asc' },
    ];
    const a = buildManagedCandidate(snapshotOf(ops), PLAN);
    const b = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(a.id).toBe('naming-plan');
    expect(a.index).toBe(2);
    expect(a.id).toBe(b.id);
    expect(a.storage[0]).toEqual(ops[0]);
    expect(a.storage[1]).toEqual(ops[1]);
    expect(a.storage[2]).toEqual(a.row);
  });

  it('an ordinary row already named naming-plan yields naming-plan-2 (collision-free over EVERY raw id)', () => {
    const ops = [{ id: 'naming-plan', kind: 'flag-emoji', action: 'add' }];
    const out = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(out.id).toBe('naming-plan-2');
    expect(out.index).toBe(1);
    expect(out.storage[0]).toEqual(ops[0]);
  });

  it('occupied naming-plan and naming-plan-2 yield naming-plan-3', () => {
    const ops = [
      { id: 'naming-plan', kind: 'dedup', by: 'name', action: 'drop' },
      { id: 'naming-plan-2', kind: 'sort', by: 'name', order: 'asc' },
    ];
    expect(buildManagedCandidate(snapshotOf(ops), PLAN).id).toBe('naming-plan-3');
  });

  it('position is clamped to the pipeline bounds', () => {
    const ops = [{ id: 'f-1', kind: 'flag-emoji', action: 'add' }];
    expect(buildManagedCandidate(snapshotOf(ops), PLAN, { position: 999 }).index).toBe(1);
    expect(buildManagedCandidate(snapshotOf(ops), PLAN, { position: -5 }).index).toBe(0);
  });

  it('deterministic: an identical snapshot + plan always produce identical bytes', () => {
    const ops = [
      { id: 'x', kind: 'filter-regex', mode: 'keep', pattern: 'HK', flags: 'i' },
      { id: 'naming-plan', kind: 'flag-emoji', action: 'add' },
    ];
    const a = buildManagedCandidate(snapshotOf(ops), PLAN);
    const b = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildManagedCandidate — existing managed row', () => {
  const managed = {
    id: 'the-plan',
    kind: 'rename-template',
    template: '${region}',
    tw2cn: false,
    sourceAliases: { key: 'old' },
    recognitionRules: [],
    disabled: true,
  };

  it('keeps the managed id + index and enables it (mode replaced)', () => {
    const ops = [{ id: 'f-1', kind: 'flag-emoji', action: 'add' }, managed];
    const out = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(out.mode).toBe('replaced');
    expect(out.id).toBe('the-plan');
    expect(out.index).toBe(1);
    expect(out.row).toMatchObject({
      id: 'the-plan',
      kind: 'rename-template',
      template: PLAN.template,
    });
    expect(out.row).not.toHaveProperty('disabled'); // apply always activates
    // the non-managed row keeps its raw bytes
    expect(out.storage[0]).toEqual(ops[0]);
    expect(out.storage).toHaveLength(2);
  });

  it('keeps a managed row at index 0 with rows after it untouched', () => {
    const ops = [
      { id: 'the-plan', kind: 'rename-template', template: '${region}', recognitionRules: [] },
      { id: 'f-1', kind: 'flag-emoji', action: 'add' },
    ];
    const out = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(out.index).toBe(0);
    expect(out.id).toBe('the-plan');
    expect(out.storage[1]).toEqual(ops[1]);
  });

  it('an enabled managed row with an identical plan is a kept no-op (same bytes)', () => {
    const ops = [
      {
        id: 'the-plan',
        kind: 'rename-template',
        template: PLAN.template,
        tw2cn: true,
        sourceAliases: PLAN.sourceAliases,
        recognitionRules: PLAN.recognitionRules,
      },
    ];
    const out = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(out.mode).toBe('kept');
    expect(out.id).toBe('the-plan');
    expect(JSON.stringify(out.storage)).toBe(JSON.stringify(ops));
  });
});

describe('buildManagedCandidate — hostile/raw preservation', () => {
  it('parked malformed rows survive byte-for-byte and the candidate never classifies them as managed', () => {
    const parked = { id: 'p-1', kind: 'rename-template', template: 42 };
    const ops = [
      { id: 'p-0', kind: 'rename-template', template: 42, flags: 'x' }, // malformed
      parked,
      { id: 'f-1', kind: 'flag-emoji', action: 'add' },
    ];
    const out = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(out.mode).toBe('added');
    expect(out.id).toBe('naming-plan');
    expect(out.index).toBe(3);
    expect(out.storage[0]).toEqual(ops[0]);
    expect(out.storage[1]).toEqual(ops[1]);
    expect(out.storage[2]).toEqual(ops[2]);
  });

  it('null/primitive rows survive untouched', () => {
    const ops = [null, 'string-row', 42, { id: 'f-1', kind: 'flag-emoji', action: 'add' }];
    const out = buildManagedCandidate(snapshotOf(ops), PLAN);
    expect(out.index).toBe(4);
    expect(out.storage[0]).toBeNull();
    expect(out.storage[1]).toBe('string-row');
    expect(out.storage[2]).toBe(42);
    expect(out.storage[3]).toEqual(ops[3]);
  });

  it('empty sourceAliases are omitted from the row; recognitionRules default to []', () => {
    const out = buildManagedCandidate(snapshotOf([]), {
      template: '${region}',
    });
    expect(out.row).toMatchObject({ template: '${region}', kind: 'rename-template' });
    // the persisted (JSON-serialized) row omits the empty alias table
    expect(JSON.parse(JSON.stringify(out.row))).not.toHaveProperty('sourceAliases');
    expect(out.row).toMatchObject({ recognitionRules: [] });
  });
});
