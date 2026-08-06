import { describe, expect, it } from 'vitest';
import {
  buildSaveCandidate,
  pipelineStatusMessage,
  saveBlockedBy,
  validateSaveCandidate,
} from '@/lib/proxies/pipelineSaveCandidate';
import { StoredOperatorListSchema, type StoredOperator } from '@/schemas/operator';

describe('save-candidate shared contract (finding 2)', () => {
  it('stored duplicate rename-template: parked by decode, rejected by the candidate check', () => {
    const decoded = StoredOperatorListSchema.parse([
      { id: 'rt-1', kind: 'rename-template' },
      { id: 'rt-2', kind: 'rename-template' },
    ]);
    expect(decoded[1]).toMatchObject({
      disabled: true,
      compatibility_issue: 'duplicate-rename-template',
    });
    const check = validateSaveCandidate(decoded);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.message).toContain('名称统一');
  });

  it('strips diagnostic fields from the candidate (API has no compatibility_issue)', () => {
    const decoded = StoredOperatorListSchema.parse([
      { id: 'x', kind: 'rename-regex', pattern: '(a+)+$', replacement: 'b' },
    ]);
    const candidate = buildSaveCandidate(decoded);
    expect(JSON.stringify(candidate)).not.toContain('compatibility_issue');
    // but the unsafe pattern still fails the contract until fixed
    expect(validateSaveCandidate(decoded).ok).toBe(false);
  });

  it('64 pass / 65 fail / duplicate ids fail through the same gate', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `op-${i}`,
        kind: 'filter-useless' as const,
        extra: [] as string[],
      })) as unknown as StoredOperator[];
    expect(validateSaveCandidate(mk(64)).ok).toBe(true);
    expect(validateSaveCandidate(mk(65)).ok).toBe(false);
    const dupes = mk(2);
    expect(validateSaveCandidate([dupes[0], dupes[0]]).ok).toBe(false);
  });
});

describe('visible accessible save-state text (final repair pass group 4)', () => {
  it('parked history gets an actionable visible message', () => {
    const decoded = StoredOperatorListSchema.parse([
      { id: 'ok', kind: 'filter-useless', extra: [] },
      { id: 'sk-TEST-TOKEN-123456', kind: 'mystery-operator' },
    ]);
    const status = pipelineStatusMessage(decoded);
    expect(status?.kind).toBe('parked');
    expect(status?.message).toContain('1 个无法解码的历史步骤');
    expect(status?.message).toContain('删除');
  });

  it('65+ loaded history explains exactly how many steps to remove', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      id: `legacy-${i}`,
      kind: 'filter-useless' as const,
      extra: [] as string[],
    })) as unknown as StoredOperator[];
    const status = pipelineStatusMessage(many);
    expect(status?.kind).toBe('over-limit');
    expect(status?.message).toContain('70 个步骤');
    expect(status?.message).toContain('删除 6 个步骤');
  });

  it('exactly 64 explains add is blocked while delete stays usable', () => {
    const at64 = Array.from({ length: 64 }, (_, i) => ({
      id: `op-${i}`,
      kind: 'filter-useless' as const,
      extra: [] as string[],
    })) as unknown as StoredOperator[];
    const status = pipelineStatusMessage(at64);
    expect(status?.kind).toBe('at-limit');
    expect(status?.message).toContain('64 个步骤上限');
    expect(status?.message).toContain('删除后可再添加');
  });

  it('exactly 64 VALID steps remain saveable (at-limit blocks Add only)', () => {
    const at64 = Array.from({ length: 64 }, (_, i) => ({
      id: `op-${i}`,
      kind: 'filter-useless' as const,
      extra: [] as string[],
    })) as unknown as StoredOperator[];
    expect(validateSaveCandidate(at64).ok).toBe(true);
    expect(saveBlockedBy(at64)).toBeNull();
  });

  it('parked/over-limit/invalid states block saving with the status message', () => {
    const decoded = StoredOperatorListSchema.parse([
      { id: 'ok', kind: 'filter-useless', extra: [] },
      { id: 'sk-TEST-TOKEN-123456', kind: 'mystery-operator' },
    ]);
    expect(saveBlockedBy(decoded)).toContain('无法解码');
    const many = Array.from({ length: 65 }, (_, i) => ({
      id: `legacy-${i}`,
      kind: 'filter-useless' as const,
      extra: [] as string[],
    })) as unknown as StoredOperator[];
    expect(saveBlockedBy(many)).toContain('删除 1 个步骤');
  });

  it('invalid/duplicate states surface the shared-contract message', () => {
    const dupes = [
      { id: 'a', kind: 'filter-useless' as const, extra: [] as string[] },
      { id: 'a', kind: 'filter-useless' as const, extra: [] as string[] },
    ] as unknown as StoredOperator[];
    const status = pipelineStatusMessage(dupes);
    expect(status?.kind).toBe('invalid');
    expect(status?.message).toContain('无法保存');
  });

  it('a healthy pipeline has no status announcement (no noise)', () => {
    const ok = [
      { id: 'a', kind: 'filter-useless' as const, extra: [] as string[] },
    ] as unknown as StoredOperator[];
    expect(pipelineStatusMessage(ok)).toBeNull();
  });
});

describe('round-9: buildSaveCandidate under prototype pollution', () => {
  function withProto<T>(key: string, descriptor: PropertyDescriptor, fn: () => T): T {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
    Object.defineProperty(Object.prototype, key, { configurable: true, ...descriptor });
    try {
      return fn();
    } finally {
      if (prior === undefined) {
        delete (Object.prototype as Record<string, unknown>)[key];
      } else {
        Object.defineProperty(Object.prototype, key, prior);
      }
    }
  }

  it('inherited compatibility_issue is ignored — own diagnostic is still stripped', () => {
    const op = { id: 'x', kind: 'rename-regex' as const, pattern: 'safe', replacement: '' };
    // Own diagnostic
    (op as Record<string, unknown>).compatibility_issue = 'runtime-validation-required';
    const ownResult = buildSaveCandidate([op as unknown as StoredOperator]);
    const ownJson = JSON.stringify(ownResult);
    expect(ownJson).not.toContain('compatibility_issue');

    // Inherited pollution (no own diagnostic) — field is NOT stripped (not own)
    const result = withProto(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      () => {
        const clean = { id: 'y', kind: 'filter-useless' as const, extra: [] as string[] };
        return buildSaveCandidate([clean as unknown as StoredOperator]);
      },
    );
    const json = JSON.stringify(result);
    expect(json).not.toContain('compatibility_issue');
  });

  it('inherited compatibility_issue GETTER: zero fires', () => {
    let fired = 0;
    withProto(
      'compatibility_issue',
      {
        get() {
          fired++;
          return 'polluted';
        },
        enumerable: false,
        configurable: true,
      },
      () => {
        buildSaveCandidate([
          {
            id: 'z',
            kind: 'filter-useless' as const,
            extra: [] as string[],
          } as unknown as StoredOperator,
        ]);
      },
    );
    expect(fired).toBe(0);
  });
});
