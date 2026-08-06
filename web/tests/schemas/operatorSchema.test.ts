import { describe, expect, it } from 'vitest';
import {
  hasOwnCompatibilityIssue,
  isExecutableOperator,
  OperatorListSchema,
  OperatorSchema,
  StoredOperatorListSchema,
  STORED_OPERATOR_COMPATIBILITY_ISSUE,
  STORED_OPERATOR_DUPLICATE_ISSUE,
  STORED_OPERATOR_MALFORMED_ISSUE,
  STORED_OPERATOR_UNKNOWN_KIND_ISSUE,
  type Operator,
  type RenameTemplateOp,
} from '@/schemas/operator';
import { CollectionUpdateSchema, SubscriptionUpdateSchema } from '@/schemas';

let seq = 0;
function baseOp(kind: Operator['kind']): Operator {
  const id = `op-${seq++}`;
  switch (kind) {
    case 'filter-regex':
      return { id, kind, mode: 'keep', pattern: 'HK', flags: 'i' } as Operator;
    case 'filter-useless':
      return { id, kind, extra: [] } as Operator;
    case 'rename-regex':
      return { id, kind, pattern: 'a', replacement: 'b', flags: 'gi' } as Operator;
    case 'flag-emoji':
      return { id, kind, action: 'add' } as Operator;
    case 'filter-type':
      return { id, kind, mode: 'keep', types: ['ss'] } as Operator;
    case 'sort':
      return { id, kind, by: 'name', order: 'asc' } as Operator;
    case 'set-prop':
      return { id, kind } as Operator;
    case 'dedup':
      return { id, kind, by: 'name', action: 'drop' } as Operator;
    case 'filter-region':
      return { id, kind, mode: 'keep', regions: ['HK'] } as Operator;
    case 'rename-template':
      return {
        id,
        kind,
        template: '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}',
        recognitionRules: [],
      } as Operator;
  }
}

function renameTemplate(over: Partial<RenameTemplateOp> = {}): Operator {
  return { ...baseOp('rename-template'), ...over } as Operator;
}

describe('rename-template schema', () => {
  it('requires a valid template and fills recognitionRules default', () => {
    const parsed = OperatorSchema.parse({
      id: 'x',
      kind: 'rename-template',
      template: '${emoji} ${region}${?index: · ${index}}',
    });
    expect(parsed).toMatchObject({
      kind: 'rename-template',
      template: '${emoji} ${region}${?index: · ${index}}',
      recognitionRules: [],
    });
  });

  it('rejects malformed templates with the DSL error message', () => {
    const bad = OperatorSchema.safeParse(
      renameTemplate({ template: '${foo}' } as unknown as Partial<RenameTemplateOp>),
    );
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues[0]?.message).toContain('未知占位符');
    }
  });

  it('rejects ambiguous dual configuration (template + legacy components)', () => {
    const dual = OperatorSchema.safeParse({
      id: 'x',
      kind: 'rename-template',
      template: '${region}',
      preset: 'balanced',
      components: {
        flag: true,
        region: true,
        route: false,
        vendor: false,
        protocol: false,
        rate: true,
        source: false,
        index: true,
      },
    });
    expect(dual.success).toBe(false);
    if (!dual.success) {
      expect(dual.error.issues[0]?.message).toContain('旧版成分配置');
    }
  });

  it('accepts sourceAliases and recognitionRules within bounds', () => {
    const ok = OperatorSchema.safeParse(
      renameTemplate({
        sourceAliases: { 'airport-a': '机场A' },
        recognitionRules: [{ pattern: '机场A', field: 'vendor', value: '机场A' }],
      }),
    );
    expect(ok.success).toBe(true);
    const tooLong = OperatorSchema.safeParse(
      renameTemplate({ sourceAliases: { 'airport-a': 'x'.repeat(41) } }),
    );
    expect(tooLong.success).toBe(false);
    const badRule = OperatorSchema.safeParse(
      renameTemplate({
        recognitionRules: [{ pattern: '(a+)+$', field: 'vendor', value: 'x' }],
      }),
    );
    expect(badRule.success).toBe(false);
    const tooManyRules = OperatorSchema.safeParse(
      renameTemplate({
        recognitionRules: Array.from({ length: 33 }, () => ({
          pattern: 'x',
          field: 'vendor' as const,
          value: 'x',
        })),
      }),
    );
    expect(tooManyRules.success).toBe(false);
  });
});

describe('at most one rename-template per pipeline (list schema)', () => {
  it('single rename-template + other ops passes (rename ops before it)', () => {
    const list = [baseOp('flag-emoji'), baseOp('filter-regex'), renameTemplate()];
    expect(OperatorListSchema.safeParse(list).success).toBe(true);
  });

  it('rename-capable steps AFTER an active rename-template are rejected (final rename stage)', () => {
    const afterFlag = [renameTemplate(), baseOp('flag-emoji')];
    const flagResult = OperatorListSchema.safeParse(afterFlag);
    expect(flagResult.success).toBe(false);
    if (!flagResult.success) {
      expect(flagResult.error.issues[0].path).toEqual([1, 'kind']);
      expect(flagResult.error.issues[0].message).toContain('最终改名');
    }
    const afterRegex = [renameTemplate(), baseOp('rename-regex')];
    expect(OperatorListSchema.safeParse(afterRegex).success).toBe(false);
    // non-rename operators may still follow the managed stage
    expect(
      OperatorListSchema.safeParse([
        renameTemplate(),
        baseOp('filter-regex'),
        baseOp('dedup'),
        baseOp('set-prop'),
      ]).success,
    ).toBe(true);
    // a DISABLED rename-capable step after it is not rejected (never runs)
    expect(
      OperatorListSchema.safeParse([renameTemplate(), { ...baseOp('flag-emoji'), disabled: true }])
        .success,
    ).toBe(true);
  });

  it('two rename-template steps fail with an actionable path', () => {
    const list = [renameTemplate({ id: 'rt-1' }), renameTemplate({ id: 'rt-2' })];
    const result = OperatorListSchema.safeParse(list);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0];
      expect(issue.path).toEqual([1, 'kind']);
      expect(issue.message).toContain('名称统一');
    }
  });

  it('enforced through SubscriptionUpdateSchema and CollectionUpdateSchema', () => {
    const dupes = [renameTemplate(), renameTemplate()];
    expect(SubscriptionUpdateSchema.safeParse({ operators: dupes }).success).toBe(false);
    expect(CollectionUpdateSchema.safeParse({ operators: dupes }).success).toBe(false);
  });

  it('still rejects >64 steps', () => {
    const many = Array.from({ length: 65 }, () => baseOp('filter-useless'));
    expect(OperatorListSchema.safeParse(many).success).toBe(false);
  });
});

describe('stored list schema parks duplicate rename-template steps', () => {
  it('a single stored rename-template decodes active', () => {
    const stored = [{ id: 'rt-1', kind: 'rename-template' }];
    const [out] = StoredOperatorListSchema.parse(stored);
    expect(out).toMatchObject({ id: 'rt-1', kind: 'rename-template' });
    expect(out.disabled).toBeUndefined();
  });

  it('the FIRST rename-template stays active; later ones park disabled', () => {
    const stored = [
      { id: 'rt-1', kind: 'rename-template' },
      { id: 'rt-2', kind: 'rename-template' },
      { id: 'other', kind: 'filter-useless' },
    ];
    const out = StoredOperatorListSchema.parse(stored);
    expect(out[0]).toMatchObject({ id: 'rt-1' });
    expect(out[0].disabled).toBeUndefined();
    expect(out[1]).toMatchObject({
      id: 'rt-2',
      kind: 'rename-template',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_DUPLICATE_ISSUE,
    });
    expect(out[2]).toMatchObject({ id: 'other', kind: 'filter-useless' });
    expect(out[2].disabled).toBeUndefined();
  });

  it('legacy incompatible steps still park with the runtime-validation issue', () => {
    // Compiles (historical decode ok) but fails the CURRENT runtime-safety
    // schema (catastrophic backtracking) → parked, never executed.
    const stored = [{ id: 'old', kind: 'filter-regex', pattern: '(a+)+$', mode: 'keep' }];
    const [out] = StoredOperatorListSchema.parse(stored);
    expect(out).toMatchObject({
      disabled: true,
      compatibility_issue: STORED_OPERATOR_COMPATIBILITY_ISSUE,
    });
  });
});

describe('stored lists allow >64 historical steps; current writes stay bounded', () => {
  it('loads and executes a 65+ step stored array (historical compatibility)', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      id: `legacy-${i}`,
      kind: 'filter-useless' as const,
      extra: [] as string[],
    }));
    const out = StoredOperatorListSchema.parse(many);
    expect(out).toHaveLength(70);
    // the first rename-template still parks later duplicates
    const withDupe = [
      ...many.slice(0, 30),
      { id: 'rt-1', kind: 'rename-template' },
      ...many.slice(30),
      { id: 'rt-2', kind: 'rename-template' },
    ];
    const parked = StoredOperatorListSchema.parse(withDupe);
    expect(parked.filter((o) => o.kind === 'rename-template')).toHaveLength(2);
    expect(
      parked.filter(
        (o) =>
          (o as { compatibility_issue?: string }).compatibility_issue ===
          STORED_OPERATOR_DUPLICATE_ISSUE,
      ),
    ).toHaveLength(1);
  });

  it('current write/preview lists still enforce max 64 + uniqueness', () => {
    const many = Array.from({ length: 65 }, () => baseOp('filter-useless'));
    expect(OperatorListSchema.safeParse(many).success).toBe(false);
    const dupes = [renameTemplate(), renameTemplate()];
    expect(OperatorListSchema.safeParse(dupes).success).toBe(false);
  });
});

describe('legacy stored rename-template migration (DSL compatibility)', () => {
  it('a legacy component row projects to an equivalent template and decodes active', () => {
    const stored = [
      {
        id: 'rt-legacy',
        kind: 'rename-template',
        preset: 'balanced',
        components: {
          flag: true,
          region: true,
          route: true,
          vendor: false,
          protocol: false,
          rate: true,
          source: false,
          index: true,
        },
        regionLabel: 'zh',
        rateDisplay: 'omit-1x',
        separator: ' · ',
      },
    ];
    const [out] = StoredOperatorListSchema.parse(stored);
    expect(out).toMatchObject({
      id: 'rt-legacy',
      kind: 'rename-template',
      disabled: undefined,
    });
    expect((out as { template?: string }).template).toBe(
      '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
    );
  });

  it('a DISABLED legacy row decodes disabled (never silently activated)', () => {
    const [out] = StoredOperatorListSchema.parse([
      {
        id: 'rt-off',
        kind: 'rename-template',
        disabled: true,
        preset: 'detailed',
        components: {
          flag: true,
          region: true,
          route: true,
          vendor: true,
          protocol: true,
          rate: true,
          source: false,
          index: true,
        },
        regionLabel: 'zh',
        rateDisplay: 'all',
        separator: ' | ',
      },
    ]);
    expect(out).toMatchObject({ id: 'rt-off', disabled: true });
    expect((out as { template?: string }).template).toContain('${?protocol:');
  });

  it('a new-shape row (template) decodes as-is; dual rows: template wins', () => {
    const [newShape] = StoredOperatorListSchema.parse([
      { id: 'rt-new', kind: 'rename-template', template: '${region}' },
    ]);
    expect(newShape).toMatchObject({ id: 'rt-new', template: '${region}' });
    const [dual] = StoredOperatorListSchema.parse([
      {
        id: 'rt-dual',
        kind: 'rename-template',
        template: '${region_code}',
        preset: 'minimal',
      },
    ]);
    expect((dual as { template?: string }).template).toBe('${region_code}');
  });

  it('a stored row with an invalid template parks with the runtime issue, editable', () => {
    const [out] = StoredOperatorListSchema.parse([
      { id: 'rt-bad', kind: 'rename-template', template: '${?index: · ${index}}' },
    ]);
    expect(out).toMatchObject({
      id: 'rt-bad',
      kind: 'rename-template',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_COMPATIBILITY_ISSUE,
    });
    expect(isExecutableOperator(out)).toBe(true); // editable, never executed
  });

  it('an ALL-COMPONENTS-OFF legacy row decodes ACTIVE with the equivalent ${note} template', () => {
    const stored = [
      {
        id: 'rt-minimal-off',
        kind: 'rename-template',
        preset: 'custom',
        components: {
          flag: false,
          region: false,
          route: false,
          vendor: false,
          protocol: false,
          rate: false,
          source: false,
          index: false,
        },
        regionLabel: 'zh',
        rateDisplay: 'omit-1x',
        separator: ' · ',
      },
    ];
    const [out] = StoredOperatorListSchema.parse(stored);
    // ACTIVE (never silently disabled): legacy composed only the residual base
    expect(out).toMatchObject({
      id: 'rt-minimal-off',
      kind: 'rename-template',
      disabled: undefined,
    });
    expect((out as { template?: string }).template).toBe('${note}');
    expect(isExecutableOperator(out)).toBe(true);
  });
});

describe('mixed historical decode — per-item (Delivery pass 2 finding 1)', () => {
  it('never echoes a raw historical id — parked ids are synthetic from position', () => {
    const out = StoredOperatorListSchema.parse([
      { id: 'sk-TEST-TOKEN-123456', kind: 'mystery-operator' },
      'raw-string-row',
    ]);
    expect(out[0]).toMatchObject({
      id: 'parked-0',
      compatibility_issue: STORED_OPERATOR_UNKNOWN_KIND_ISSUE,
    });
    expect(out[1]).toMatchObject({
      id: 'parked-1',
      compatibility_issue: STORED_OPERATOR_MALFORMED_ISSUE,
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('sk-TEST-TOKEN');
    expect(serialized).not.toContain('raw-string-row');
  });

  it('valid steps survive in exact order next to unknown-kind and malformed rows', () => {
    const stored = [
      { id: 'a', kind: 'filter-useless', extra: [] },
      { id: 'b', kind: 'mystery-operator', whatever: { secret: 'x' } },
      { id: 'c', kind: 'rename-regex', pattern: 'HK', replacement: '香港' },
      'not-an-object',
      { id: 'd', kind: 'filter-type', mode: 'keep', types: ['ss'] },
      { id: 'e', kind: 'flag-emoji', action: 'add' },
      { id: 'f', kind: 'rename-regex' }, // malformed: missing pattern
    ];
    const out = StoredOperatorListSchema.parse(stored);
    expect(out).toHaveLength(7);
    // valid steps keep exact positions
    expect(out[0]).toMatchObject({ id: 'a', kind: 'filter-useless' });
    expect(out[2]).toMatchObject({ id: 'c', kind: 'rename-regex' });
    expect(out[4]).toMatchObject({ id: 'd', kind: 'filter-type' });
    expect(out[5]).toMatchObject({ id: 'e', kind: 'flag-emoji' });
    // bad items parked in place with FIXED diagnostics, no raw fields
    expect(out[1]).toMatchObject({
      kind: '__incompatible__',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_UNKNOWN_KIND_ISSUE,
    });
    expect(JSON.stringify(out[1])).not.toContain('secret');
    expect(out[3]).toMatchObject({
      kind: '__incompatible__',
      compatibility_issue: STORED_OPERATOR_MALFORMED_ISSUE,
    });
    expect(out[6]).toMatchObject({
      kind: '__incompatible__',
      compatibility_issue: STORED_OPERATOR_MALFORMED_ISSUE,
    });
  });

  it('known-kind runtime-invalid steps stay editable (fields preserved), never executed', async () => {
    const out = StoredOperatorListSchema.parse([
      { id: 'x', kind: 'rename-regex', pattern: '(a+)+$', replacement: 'b' },
    ]);
    const [op] = out;
    expect(op).toMatchObject({
      id: 'x',
      kind: 'rename-regex',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_COMPATIBILITY_ISSUE,
    });
    expect((op as { pattern?: string }).pattern).toBe('(a+)+$'); // editable
    // it is Operator-shaped (not a placeholder) — the ENGINE skips it because
    // it is disabled, so it never executes
    expect(isExecutableOperator(op)).toBe(true);
    const { applyOperators } = await import('@/lib/proxies/operators');
    const applied = applyOperators(
      [{ name: 'aaaaaaaaaaaaaaaa', type: 'ss', server: 'example.test', port: 443 }],
      [op as never],
    );
    expect(applied.proxies).toHaveLength(1);
    expect(applied.steps[0]).toMatchObject({ applied: false });
    // once the user fixes the pattern, it parses as a plain operator
    const fixed = OperatorSchema.parse({
      id: 'x',
      kind: 'rename-regex',
      pattern: 'HK',
      replacement: 'b',
    });
    expect(fixed.disabled).toBeUndefined();
  });

  it('70 valid historical steps load in order', () => {
    const many = Array.from({ length: 70 }, (_, i) => ({
      id: `legacy-${i}`,
      kind: 'filter-useless' as const,
      extra: [] as string[],
    }));
    const out = StoredOperatorListSchema.parse(many);
    expect(out).toHaveLength(70);
    expect(out[69]).toMatchObject({ id: 'legacy-69' });
  });
});

describe('current write contract: 64 cap + duplicate ids (finding 2)', () => {
  it('64 current steps pass, 65 fail', () => {
    const at64 = Array.from({ length: 64 }, () => baseOp('filter-useless'));
    expect(OperatorListSchema.safeParse(at64).success).toBe(true);
    const at65 = Array.from({ length: 65 }, () => baseOp('filter-useless'));
    expect(OperatorListSchema.safeParse(at65).success).toBe(false);
  });

  it('duplicate operator ids reject with an actionable path', () => {
    const dupes = [baseOp('filter-useless'), baseOp('filter-useless')];
    const forced = [{ ...dupes[0] }, { ...dupes[0] }]; // same id
    const result = OperatorListSchema.safeParse(forced);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([1, 'id']);
      expect(result.error.issues[0].message).toContain('重复');
    }
  });
});

describe('round-9: own-property compatibility_issue (Object.hasOwn) under prototype pollution', () => {
  const RT = {
    id: 'rt-1',
    kind: 'rename-template' as const,
    template: '${emoji} ${region}',
  };
  const FILTER = { id: 'f-1', kind: 'filter-useless' as const };

  /** Temporarily define an Object.prototype property, restoring the exact
   * prior descriptor even if an assertion throws. */
  function withProtoPollution<T>(key: string, descriptor: PropertyDescriptor, fn: () => T): T {
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

  it('non-enumerable Object.prototype.compatibility_issue DATA: first valid template stays current, second stays duplicate', () => {
    const result = withProtoPollution(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      () => StoredOperatorListSchema.parse([RT, RT]),
    );
    // First RT is current-valid (no own issue); second is duplicate-parked
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('rename-template');
    expect(result[0]).not.toHaveProperty('compatibility_issue');
    expect(result[1].kind).toBe('rename-template');
    expect((result[1] as Record<string, unknown>).compatibility_issue).toBe(
      'duplicate-rename-template',
    );
  });

  it('inherited DATA on parked placeholders stays unobserved and falls back to unknown-kind parking', () => {
    const result = withProtoPollution(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: false, configurable: true },
      () =>
        StoredOperatorListSchema.parse([
          { kind: '__incompatible__', id: 'parked-0', disabled: true },
          RT,
          { ...RT, id: 'rt-2' },
        ]),
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: 'parked-0',
      kind: '__incompatible__',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_UNKNOWN_KIND_ISSUE,
    });
    expect(Object.hasOwn(result[0] as object, 'compatibility_issue')).toBe(true);
    expect(result[1]).toMatchObject({
      id: 'rt-1',
      kind: 'rename-template',
      template: '${emoji} ${region}',
    });
    expect(Object.hasOwn(result[1] as object, 'compatibility_issue')).toBe(false);
    expect(result[2]).toMatchObject({
      id: 'rt-2',
      kind: 'rename-template',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_DUPLICATE_ISSUE,
    });
    expect(Object.hasOwn(result[2] as object, 'compatibility_issue')).toBe(true);
  });

  it('throwing inherited GETTER on parked placeholders fires zero times and does not abort decode', () => {
    let fired = 0;
    const result = withProtoPollution(
      'compatibility_issue',
      {
        get() {
          fired += 1;
          throw new Error('prototype getter should stay unobserved');
        },
        enumerable: false,
        configurable: true,
      },
      () =>
        StoredOperatorListSchema.parse([
          { kind: '__incompatible__', id: 'parked-0', disabled: true },
          RT,
          { ...RT, id: 'rt-2' },
        ]),
    );
    expect(fired).toBe(0);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      id: 'parked-0',
      kind: '__incompatible__',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_UNKNOWN_KIND_ISSUE,
    });
    expect(Object.hasOwn(result[0] as object, 'compatibility_issue')).toBe(true);
    expect(result[1]).toMatchObject({
      id: 'rt-1',
      kind: 'rename-template',
      template: '${emoji} ${region}',
    });
    expect(Object.hasOwn(result[1] as object, 'compatibility_issue')).toBe(false);
    expect(result[2]).toMatchObject({
      id: 'rt-2',
      kind: 'rename-template',
      disabled: true,
      compatibility_issue: STORED_OPERATOR_DUPLICATE_ISSUE,
    });
    expect(Object.hasOwn(result[2] as object, 'compatibility_issue')).toBe(true);
  });

  it('GETTER variant fires zero times and first template stays current', () => {
    let fired = 0;
    const result = withProtoPollution(
      'compatibility_issue',
      {
        get() {
          fired++;
          return 'polluted';
        },
        enumerable: false,
        configurable: true,
      },
      () => StoredOperatorListSchema.parse([RT, FILTER]),
    );
    expect(fired).toBe(0);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('rename-template');
  });
  it('hasOwnCompatibilityIssue returns false for inherited DATA and GETTER', () => {
    // Own — true (no prototype pollution active here)
    const obj: Record<string, unknown> = { kind: 'rename-template', id: 'x' };
    obj.compatibility_issue = 'runtime-validation-required';
    expect(hasOwnCompatibilityIssue(obj)).toBe(true);

    // Inherited DATA — false; owns only kind+id, not compatibility_issue
    withProtoPollution(
      'compatibility_issue',
      { value: 'polluted', writable: true, enumerable: true, configurable: true },
      () => {
        const clean: Record<string, unknown> = { kind: 'rename-template', id: 'y' };
        expect(hasOwnCompatibilityIssue(clean)).toBe(false);
      },
    );

    // Inherited GETTER — false, getter fires zero times.
    // NOTE: a getter-only accessor on Object.prototype makes ANY property
    // assignment to `compatibility_issue` on ANY object throw, so we avoid
    // passing objects to expect() which may internally clone/compare.
    let getterFired = 0;
    let result = false;
    withProtoPollution(
      'compatibility_issue',
      {
        get() {
          getterFired++;
          return 'polluted';
        },
        enumerable: true,
        configurable: true,
      },
      () => {
        const clean: Record<string, unknown> = { kind: 'rename-template', id: 'z' };
        // Object.hasOwn never fires the getter — safe to check
        result = hasOwnCompatibilityIssue(clean);
      },
    );
    expect(getterFired).toBe(0);
    expect(result).toBe(false);
  });
});
