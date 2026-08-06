import { describe, expect, it } from 'vitest';
import {
  hasFlagRedundancy,
  matchesRenamedAt,
  renamedAfterManaged,
} from '@/lib/proxies/pipelineWarnings';
import type { Operator } from '@/schemas/operator';

function op(kind: Operator['kind'], over: Record<string, unknown> = {}): Operator {
  const base = {
    id: Math.random().toString(36).slice(2),
    kind,
    ...over,
  } as Operator;
  return base;
}

function renameTemplate(
  over: Record<string, unknown> = {},
): Extract<Operator, { kind: 'rename-template' }> {
  return op('rename-template', {
    template: '${emoji} ${region}${?index: · ${index}}',
    recognitionRules: [],
    ...over,
  }) as Extract<Operator, { kind: 'rename-template' }>;
}

describe('matchesRenamedAt', () => {
  it('marks filter-regex after an enabled rename as matching renamed names', () => {
    const ops = [
      op('rename-template'),
      op('filter-regex', { pattern: 'x', mode: 'keep' }),
      op('rename-regex', { pattern: 'a', replacement: 'b' }),
      op('filter-regex', { pattern: 'y', mode: 'keep' }),
    ];
    expect(matchesRenamedAt(ops)).toEqual([true, true, true, true]);
  });

  it('marks filter-regex before any rename as matching raw names', () => {
    const ops = [op('filter-regex', { pattern: 'x', mode: 'keep' }), op('rename-template')];
    expect(matchesRenamedAt(ops)).toEqual([false, true]);
  });

  it('disabled rename steps do not switch the mode', () => {
    const ops = [
      op('rename-template', { disabled: true }),
      op('filter-regex', { pattern: 'x', mode: 'keep' }),
    ];
    expect(matchesRenamedAt(ops)).toEqual([false, false]);
  });

  it('an empty-pattern rename-regex does not count (it renames nothing)', () => {
    const ops = [
      op('rename-regex', { pattern: '', replacement: '' }),
      op('filter-regex', { pattern: 'x', mode: 'keep' }),
    ];
    expect(matchesRenamedAt(ops)).toEqual([false, false]);
  });
});

describe('renamedAfterManaged (final rename stage)', () => {
  it('flags enabled rename-capable steps after an active rename-template', () => {
    const ops = [
      op('rename-template'),
      op('filter-regex', { pattern: 'x', mode: 'keep' }),
      op('rename-regex', { pattern: 'a', replacement: 'b' }),
      op('flag-emoji', { action: 'add' }),
      op('dedup', { by: 'name', action: 'drop' }),
    ];
    expect(renamedAfterManaged(ops)).toEqual([2, 3]);
    // non-rename steps after it are fine
    expect(
      renamedAfterManaged([
        op('rename-template'),
        op('filter-regex', { pattern: 'x', mode: 'keep' }),
      ]),
    ).toEqual([]);
    // disabled steps never count; steps before it never count
    expect(
      renamedAfterManaged([
        op('flag-emoji', { action: 'add' }),
        op('rename-template'),
        op('rename-regex', { pattern: 'a', replacement: 'b', disabled: true }),
      ]),
    ).toEqual([]);
  });
});

describe('hasFlagRedundancy', () => {
  it('warns when rename-template(flag) + flag-emoji(add) both run', () => {
    const ops = [renameTemplate(), op('flag-emoji', { action: 'add' })];
    expect(hasFlagRedundancy(ops)).toBe(true);
  });

  it('no warning when rename-template has no ${emoji} placeholder', () => {
    const ops = [
      renameTemplate({ template: '${region}${?index: · ${index}}' }),
      op('flag-emoji', { action: 'add' }),
    ];
    expect(hasFlagRedundancy(ops)).toBe(false);
  });

  it('no warning when the flag-emoji step removes flags', () => {
    const ops = [renameTemplate(), op('flag-emoji', { action: 'remove' })];
    expect(hasFlagRedundancy(ops)).toBe(false);
  });

  it('no warning when either side is disabled — both operators are kept, never removed', () => {
    expect(
      hasFlagRedundancy([renameTemplate({ disabled: true }), op('flag-emoji', { action: 'add' })]),
    ).toBe(false);
    expect(
      hasFlagRedundancy([renameTemplate(), op('flag-emoji', { action: 'add', disabled: true })]),
    ).toBe(false);
  });
});
