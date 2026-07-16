import { describe, expect, it } from 'vitest';
import { applyOperators, type ClashProxy } from '@/lib/proxies/operators';
import { isSafeRuntimeRegex } from '@/lib/proxies/regexSafety';
import type { Operator, OperatorKind } from '@/schemas/operator';

let seq = 0;
// Loose builder: an index signature absorbs the kind-specific fields so each
// object literal isn't excess-property-checked against the operator union.
function op(o: { kind: OperatorKind } & Record<string, unknown>): Operator {
  return { id: `op-${seq++}`, ...o } as Operator;
}

const sample: ClashProxy[] = [
  { name: '🇭🇰 香港 01', type: 'ss', server: 'a.com', port: 443 },
  { name: 'HK 香港 02', type: 'vmess', server: 'b.com', port: 443 },
  { name: '日本 Tokyo 01', type: 'trojan', server: 'c.com', port: 8443 },
  { name: 'US Los Angeles', type: 'ss', server: 'd.com', port: 443 },
  { name: '剩余流量：88.8 GB', type: 'ss', server: 'e.com', port: 1 },
  { name: '官网 https://airport.com', type: 'ss', server: 'f.com', port: 2 },
];

describe('applyOperators · filter-regex', () => {
  it('keeps matches', () => {
    const { proxies } = applyOperators(sample, [
      op({ kind: 'filter-regex', mode: 'keep', pattern: '香港', flags: 'i' }),
    ]);
    expect(proxies.map((p) => p.name)).toEqual(['🇭🇰 香港 01', 'HK 香港 02']);
  });
  it('drops matches', () => {
    const { proxies } = applyOperators(sample, [
      op({ kind: 'filter-regex', mode: 'drop', pattern: '香港' }),
    ]);
    expect(proxies).toHaveLength(4);
    expect(proxies.find((p) => p.name === '🇭🇰 香港 01')).toBeUndefined();
  });
  it('reports dropped count in the step trace', () => {
    const { steps } = applyOperators(sample, [
      op({ kind: 'filter-regex', mode: 'keep', pattern: '香港' }),
    ]);
    expect(steps[0]).toMatchObject({ before: 6, after: 2, dropped: 4, applied: true });
  });
});

describe('applyOperators · filter-useless', () => {
  it('drops info/ad nodes', () => {
    const { proxies } = applyOperators(sample, [op({ kind: 'filter-useless', extra: [] })]);
    const names = proxies.map((p) => p.name);
    expect(names).not.toContain('剩余流量：88.8 GB');
    expect(names).not.toContain('官网 https://airport.com');
    expect(proxies).toHaveLength(4);
  });
  it('honours extra keywords', () => {
    const { proxies } = applyOperators(sample, [op({ kind: 'filter-useless', extra: ['Tokyo'] })]);
    expect(proxies.find((p) => p.name === '日本 Tokyo 01')).toBeUndefined();
  });

  // Legacy values bypassing the write schema must fail closed as well; silently
  // skipping a configured pattern would publish a different pipeline.
  it('P0-5: rejects an invalid legacy extra fragment', () => {
    expect(() => applyOperators(sample, [op({ kind: 'filter-useless', extra: ['('] })])).toThrow(
      /unsafe|invalid/i,
    );
  });

  it('P0-5: rejects an empty-matching legacy fragment instead of dropping all nodes', () => {
    expect(() => applyOperators(sample, [op({ kind: 'filter-useless', extra: ['a|'] })])).toThrow(
      /empty string/i,
    );
  });
});

describe('FilterUselessOpSchema.extra validation (P0-5)', () => {
  it('rejects a fragment that fails to compile', async () => {
    const { FilterUselessOpSchema } = await import('@/schemas/operator');
    expect(() =>
      FilterUselessOpSchema.parse({ id: 'x', kind: 'filter-useless', extra: ['('] }),
    ).toThrow();
  });
  it('rejects a fragment that matches the empty string', async () => {
    const { FilterUselessOpSchema } = await import('@/schemas/operator');
    expect(() =>
      FilterUselessOpSchema.parse({ id: 'x', kind: 'filter-useless', extra: ['a|'] }),
    ).toThrow();
    expect(() =>
      FilterUselessOpSchema.parse({ id: 'x', kind: 'filter-useless', extra: ['.*'] }),
    ).toThrow();
  });
  it('accepts a normal keyword fragment', async () => {
    const { FilterUselessOpSchema } = await import('@/schemas/operator');
    const r = FilterUselessOpSchema.parse({
      id: 'x',
      kind: 'filter-useless',
      extra: ['官网', 'Tokyo'],
    });
    expect(r.extra).toEqual(['官网', 'Tokyo']);
  });

  it.each(['^(a+)+$', '(a|aa)+$', '^([a-z]*)([a-m]*)$'])(
    'rejects a ReDoS-prone pattern: %s',
    async (pattern) => {
      const { FilterRegexOpSchema, RenameRegexOpSchema } = await import('@/schemas/operator');
      expect(() => FilterRegexOpSchema.parse({ id: 'x', kind: 'filter-regex', pattern })).toThrow();
      expect(() => RenameRegexOpSchema.parse({ id: 'x', kind: 'rename-regex', pattern })).toThrow();
    },
  );

  it.each([
    '(K|KK)+$',
    '(K|\\u212AK)+$',
    String.raw`(K|\u{000212A}K)+$`,
    String.raw`(K|\u{0000212A}K)+$`,
    `(K|\\u{${'0'.repeat(64)}212A}K)+$`,
    '(K|[℀-∀]K)+$',
    '(K|[\\u2100-\\u2200]K)+$',
    '(K|\\p{L}K)+$',
    '(K|[\\P{ASCII}]K)+$',
  ])('rejects a Unicode IgnoreCase bypass under explicit iu flags: %s', async (pattern) => {
    const { FilterRegexOpSchema, RenameRegexOpSchema } = await import('@/schemas/operator');
    expect(() =>
      FilterRegexOpSchema.parse({
        id: 'x',
        kind: 'filter-regex',
        pattern,
        flags: 'iu',
      }),
    ).toThrow();
    expect(() =>
      RenameRegexOpSchema.parse({
        id: 'x',
        kind: 'rename-regex',
        pattern,
        flags: 'iu',
      }),
    ).toThrow();
  });

  it.each([
    String.raw`(K|\u{000212A}K)+$`,
    String.raw`(K|\u{0000212A}K)+$`,
    `(K|\\u{${'0'.repeat(64)}212A}K)+$`,
  ])('rejects a long braced Kelvin escape at the runtime guard: %s', (pattern) => {
    expect(isSafeRuntimeRegex(pattern, 'iu')).toBe(false);
  });

  it('keeps uncased non-ASCII operator patterns usable under explicit iu flags', async () => {
    const { FilterRegexOpSchema } = await import('@/schemas/operator');
    expect(() =>
      FilterRegexOpSchema.parse({
        id: 'x',
        kind: 'filter-regex',
        pattern: '香港|🇺🇸',
        flags: 'iu',
      }),
    ).not.toThrow();
  });

  it('fails closed on IgnoreCase plus UnicodeSets string classes', () => {
    expect(isSafeRuntimeRegex(String.raw`[\q{a|aa}]+$`, 'iv')).toBe(false);
    expect(isSafeRuntimeRegex('香港', 'iv')).toBe(false);
  });

  it('accepts a bounded safe lookbehind pattern', async () => {
    const { RenameRegexOpSchema } = await import('@/schemas/operator');
    expect(() =>
      RenameRegexOpSchema.parse({
        id: 'x',
        kind: 'rename-regex',
        pattern: '(?<![A-Za-z])US(?![A-Za-z])',
      }),
    ).not.toThrow();
  });
});

describe('applyOperators · rename-regex', () => {
  it('replaces matches and counts changes', () => {
    const { proxies, steps } = applyOperators(sample, [
      op({ kind: 'rename-regex', pattern: '\\s*01$', replacement: '', flags: 'g' }),
    ]);
    expect(proxies[0].name).toBe('🇭🇰 香港');
    expect(steps[0].changed).toBeGreaterThan(0);
    expect(steps[0].dropped).toBe(0);
  });
});

describe('applyOperators · flag-emoji', () => {
  it('adds a leading flag based on region', () => {
    const { proxies } = applyOperators(
      [{ name: '日本 Tokyo 01' }, { name: 'US Los Angeles' }],
      [op({ kind: 'flag-emoji', action: 'add' })],
    );
    expect(proxies[0].name).toBe('🇯🇵 日本 Tokyo 01');
    expect(proxies[1].name).toBe('🇺🇸 US Los Angeles');
  });
  it('does not double-prefix an existing flag', () => {
    const { proxies } = applyOperators(
      [{ name: '🇭🇰 香港 01' }],
      [op({ kind: 'flag-emoji', action: 'add' })],
    );
    expect(proxies[0].name).toBe('🇭🇰 香港 01');
  });
  it('removes flags', () => {
    const { proxies } = applyOperators(
      [{ name: '🇭🇰 香港 01' }],
      [op({ kind: 'flag-emoji', action: 'remove' })],
    );
    expect(proxies[0].name).toBe('香港 01');
  });
  it('maps Taiwan to the China flag when tw2cn is set', () => {
    const { proxies } = applyOperators(
      [{ name: '🇹🇼 台北 01' }, { name: '台湾 02' }, { name: '🇭🇰 香港' }],
      [op({ kind: 'flag-emoji', action: 'add', tw2cn: true })],
    );
    expect(proxies[0].name).toBe('🇨🇳 台北 01'); // existing TW flag swapped
    expect(proxies[1].name).toBe('🇨🇳 台湾 02'); // detected by keyword
    expect(proxies[2].name).toBe('🇭🇰 香港'); // other regions untouched
  });
  it('keeps the Taiwan flag when tw2cn is off', () => {
    const { proxies } = applyOperators(
      [{ name: '台湾 01' }],
      [op({ kind: 'flag-emoji', action: 'add' })],
    );
    expect(proxies[0].name).toBe('🇹🇼 台湾 01');
  });
});

describe('applyOperators · filter-type', () => {
  it('keeps selected protocols', () => {
    const { proxies } = applyOperators(sample, [
      op({ kind: 'filter-type', mode: 'keep', types: ['ss'] }),
    ]);
    expect(proxies.every((p) => p.type === 'ss')).toBe(true);
  });
  it('no-ops when no types selected', () => {
    const { proxies } = applyOperators(sample, [
      op({ kind: 'filter-type', mode: 'keep', types: [] }),
    ]);
    expect(proxies).toHaveLength(sample.length);
  });
});

describe('applyOperators · sort', () => {
  it('sorts by name ascending with numeric awareness', () => {
    const input: ClashProxy[] = [{ name: 'node-10' }, { name: 'node-2' }, { name: 'node-1' }];
    const { proxies } = applyOperators(input, [op({ kind: 'sort', by: 'name', order: 'asc' })]);
    expect(proxies.map((p) => p.name)).toEqual(['node-1', 'node-2', 'node-10']);
  });
  it('descending reverses', () => {
    const input: ClashProxy[] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const { proxies } = applyOperators(input, [op({ kind: 'sort', by: 'name', order: 'desc' })]);
    expect(proxies.map((p) => p.name)).toEqual(['c', 'b', 'a']);
  });
});

describe('applyOperators · set-prop', () => {
  it('forces only the specified props', () => {
    const { proxies, steps } = applyOperators(
      [{ name: 'x', udp: false }],
      [op({ kind: 'set-prop', udp: true, skipCertVerify: true })],
    );
    expect(proxies[0].udp).toBe(true);
    expect(proxies[0]['skip-cert-verify']).toBe(true);
    expect(proxies[0].tfo).toBeUndefined();
    expect(steps[0].changed).toBe(1);
  });
});

describe('applyOperators · dedup', () => {
  const dup: ClashProxy[] = [
    { name: 'A', server: 's1', port: 1 },
    { name: 'A', server: 's2', port: 2 },
    { name: 'B', server: 's1', port: 1 },
  ];
  it('drops duplicates by name', () => {
    const { proxies, steps } = applyOperators(dup, [
      op({ kind: 'dedup', by: 'name', action: 'drop' }),
    ]);
    expect(proxies.map((p) => p.name)).toEqual(['A', 'B']);
    expect(steps[0].dropped).toBe(1);
  });
  it('renames duplicates by name with an index', () => {
    const { proxies } = applyOperators(dup, [op({ kind: 'dedup', by: 'name', action: 'rename' })]);
    expect(proxies.map((p) => p.name)).toEqual(['A', 'A #2', 'B']);
  });
  it('dedups by server:port', () => {
    const { proxies } = applyOperators(dup, [
      op({ kind: 'dedup', by: 'server-port', action: 'drop' }),
    ]);
    expect(proxies).toHaveLength(2); // s1:1 collapses
  });
});

describe('applyOperators · filter-region', () => {
  it('keeps only selected regions', () => {
    const { proxies } = applyOperators(sample, [
      op({ kind: 'filter-region', mode: 'keep', regions: ['HK'] }),
    ]);
    expect(proxies.map((p) => p.name)).toEqual(['🇭🇰 香港 01', 'HK 香港 02']);
  });
});

describe('applyOperators · pipeline ordering + disabled', () => {
  it('runs operators in array order', () => {
    const { proxies } = applyOperators(sample, [
      op({ kind: 'filter-useless', extra: [] }),
      op({ kind: 'filter-region', mode: 'keep', regions: ['HK', 'JP'] }),
      op({ kind: 'flag-emoji', action: 'add' }),
      op({ kind: 'sort', by: 'name', order: 'asc' }),
    ]);
    expect(proxies).toHaveLength(3);
    expect(proxies.every((p) => /^[\u{1F1E6}-\u{1F1FF}]{2}/u.test(p.name ?? ''))).toBe(true);
  });
  it('skips disabled steps but still records a non-applied trace', () => {
    const { proxies, steps } = applyOperators(sample, [
      op({ kind: 'filter-useless', extra: [], disabled: true }),
    ]);
    expect(proxies).toHaveLength(sample.length);
    expect(steps[0]).toMatchObject({ applied: false, dropped: 0 });
  });
});
