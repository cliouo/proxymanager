/**
 * 智能命名 workspace + generic workbench UI acceptance (static markup —
 * existing React/Vitest facilities only, same seam as namingWorkspaceRender).
 *
 * Product acceptance covered here:
 *   - FIRST-USE applyability: an ABSENT managed plan is applyable without any
 *     template edit (the deterministic recommendation is the draft);
 *   - RE-ENABLE applyability: a DISABLED managed plan is applyable with the
 *     stored policy unchanged;
 *   - an ENABLED unchanged plan is NOT applyable; a changed draft is;
 *   - the workspace owns the AI trigger and truthfully discloses exactly what
 *     crosses the model boundary (bounded sanitized original display names +
 *     safe source labels), rendering sources as `label ?? id` — never
 *     [object Object];
 *   - the generic workbench renders the managed rename-template row as an
 *     immutable summary + 智能命名 link — no toggle/delete/move control, no
 *     generic add entry — while ordinary rows keep their controls.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// OperatorWorkbench calls useRouter() for leave-navigation; static markup
// has no app-router context, so the test seam provides a stub.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
import {
  AiAnalysisPanel,
  NamingWorkspace,
  completeDraftFromSuggestion,
  namingPlanEquals,
  policyBody,
  runNamingAnalysisRequest,
  type CompleteNamingPlan,
} from '@/app/(authed)/subscriptions/_pipeline/NamingWorkspace';
import {
  ADDABLE_KINDS,
  OperatorWorkbench,
  canMoveStep,
  isLogicalManagedOperator,
} from '@/app/(authed)/subscriptions/_pipeline/OperatorWorkbench';
import type { StoredOperator } from '@/schemas/operator';
import type { NamingSuggestion, ScrubbedPayload } from '@/schemas/namingAnalysis';

const RECOMMENDED = '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}';

const BASE = {
  configVersion: 7,
  entity: { type: 'subscription' as const, ref: 'ref-1111111111111111', label: '机场A' },
  aggregate: false,
  managed: { present: false },
  priorPlan: { present: false },
  recommended: RECOMMENDED,
  health: [],
  diagnostics: {
    nodeCount: 0,
    changed: 0,
    collisions: [],
    deduped: [],
    beforeNames: [],
    afterNames: [],
    truncated: false,
  },
  references: { consumingProfiles: [], orphaned: [] },
};

function renderWorkspace(over: Record<string, unknown>): string {
  const data = { ...BASE, ...over } as never;
  return renderToStaticMarkup(
    createElement(NamingWorkspace, {
      workspacePath: '/api/v1/naming/subscription/sub-1',
      backHref: '/subscriptions',
      crumbPrefix: '订阅源',
      initialData: data,
    }),
  );
}

const hasDisabledApply = (html: string): boolean =>
  /<button[^>]*>保存并应用模板<\/button>/.test(html) &&
  /<button[^>]*disabled=""[^>]*>保存并应用模板<\/button>/.test(html);

describe('智能命名 workspace — activation state (absent | disabled | enabled)', () => {
  it('FIRST-USE: an absent managed plan is applyable with the unchanged deterministic recommendation', () => {
    const html = renderWorkspace({});
    expect(html).toContain(RECOMMENDED);
    expect(html).toContain('保存并应用模板');
    // the apply button must NOT be disabled even though draft === recommended
    expect(hasDisabledApply(html)).toBe(false);
    // the status must not claim the draft equals the applied state
    expect(html).not.toContain('已与保存状态一致');
  });

  it('RE-ENABLE: a disabled managed plan is applyable with the stored policy unchanged', () => {
    const html = renderWorkspace({
      managed: { present: true, disabled: true, template: '${region} ${index}' },
    });
    expect(html).toContain('${region} ${index}');
    expect(hasDisabledApply(html)).toBe(false);
  });

  it('ENABLED + unchanged draft: not applyable; rollback stays available', () => {
    const html = renderWorkspace({
      managed: { present: true, disabled: false, template: '${emoji} ${region}' },
      priorPlan: { present: true, template: '${region}' },
    });
    expect(html).toContain('已与保存状态一致');
    expect(hasDisabledApply(html)).toBe(true);
    expect(html).toContain('回滚到上一方案');
  });
});

describe('智能命名 workspace — COMPLETE-PLAN dirty/applyability (round-7 HIGH-1)', () => {
  const PLAN: CompleteNamingPlan = {
    template: '${emoji} ${region}',
    tw2cn: true,
    sourceAliases: { 'airport-a': '机场A' },
    recognitionRules: [{ pattern: '^IPLC$', field: 'route', value: 'iplc' }],
  };

  // unit regressions exercise the REAL exported helper the Apply button's
  // applyable computation calls — not a duplicate test-only comparison
  it('complete equality (template + tw2cn + aliases + rules) is NOT a change', () => {
    expect(namingPlanEquals(PLAN, { ...PLAN })).toBe(true);
  });

  it('same template with a changed tw2cn partition IS a change', () => {
    expect(namingPlanEquals(PLAN, { ...PLAN, tw2cn: false })).toBe(false);
    expect(namingPlanEquals(PLAN, { ...PLAN, tw2cn: undefined })).toBe(false); // true ≠ unset
  });

  it('same template with a changed sourceAliases partition IS a change', () => {
    expect(namingPlanEquals(PLAN, { ...PLAN, sourceAliases: { 'airport-a': '机场B' } })).toBe(
      false,
    );
    expect(namingPlanEquals(PLAN, { ...PLAN, sourceAliases: {} })).toBe(false);
  });

  it('same template with a changed recognitionRules partition IS a change', () => {
    expect(
      namingPlanEquals(PLAN, {
        ...PLAN,
        recognitionRules: [{ pattern: '^IPLC$', field: 'route', value: 'iplc-direct' }],
      }),
    ).toBe(false);
    expect(namingPlanEquals(PLAN, { ...PLAN, recognitionRules: [] })).toBe(false);
  });

  it('default normalization: unset tw2cn ≡ false, empty aliases ≡ undefined, empty rules ≡ undefined', () => {
    expect(
      namingPlanEquals(
        { template: 'x', tw2cn: undefined, sourceAliases: undefined, recognitionRules: [] },
        { template: 'x', tw2cn: false, sourceAliases: {}, recognitionRules: undefined },
      ),
    ).toBe(true);
  });

  it('ENABLED + complete plan equal (every partition stored) disables Apply in the rendered UI', () => {
    const html = renderWorkspace({
      managed: { present: true, disabled: false, ...PLAN },
    });
    expect(html).toContain('已与保存状态一致');
    expect(hasDisabledApply(html)).toBe(true);
  });

  it('ENABLED + same template but stored partition differences keep the stored plan equal-only comparison honest', () => {
    // stored aliases exist; the seeded draft carries the same stored values
    // → complete equality → not applyable
    const html = renderWorkspace({
      managed: {
        present: true,
        disabled: false,
        template: PLAN.template,
        tw2cn: PLAN.tw2cn,
        sourceAliases: PLAN.sourceAliases,
        recognitionRules: PLAN.recognitionRules,
      },
    });
    expect(hasDisabledApply(html)).toBe(true);
  });
});

describe('智能命名 workspace — HIGH-A: AI suggestion without tw2cn is a complete explicit-false plan', () => {
  const TEMPLATE = '${emoji} ${region}';
  // pre-boundary model-output shape: deliberately NOT a NamingSuggestion —
  // it omits tw2cn exactly as a raw model JSON object would
  const SUGGESTION_NO_TW2CN = {
    template: TEMPLATE,
    sourceAliases: { 'src-1111111111111111': '机场A' },
    recognitionRules: [{ pattern: '^IPLC$', field: 'route', value: 'iplc' }],
    reason: '识别稳定。',
  };

  it('omitted tw2cn becomes an explicit false complete draft through the PRODUCTION helper applyAi stores', () => {
    const draft = completeDraftFromSuggestion(SUGGESTION_NO_TW2CN);
    expect(draft.tw2cn).toBe(false); // undefined would fail this assertion
    expect(Object.hasOwn(draft, 'tw2cn')).toBe(true);
    expect(JSON.stringify(draft)).toContain('"tw2cn":false');
    // explicit true/false stay exact through the same helper
    expect(completeDraftFromSuggestion({ ...SUGGESTION_NO_TW2CN, tw2cn: true }).tw2cn).toBe(true);
    expect(completeDraftFromSuggestion({ ...SUGGESTION_NO_TW2CN, tw2cn: false }).tw2cn).toBe(false);
  });

  it('the REAL preview/apply body carries own key tw2cn:false in JSON when the stored plan was true', () => {
    // policyBody is the ONE production builder runPreview/applyDraft use —
    // this body is exactly what the component would POST after applyAi
    const policy = completeDraftFromSuggestion(SUGGESTION_NO_TW2CN);
    const body = { apply: { template: TEMPLATE, ...policyBody(policy) } };
    expect(Object.keys(body.apply)).toContain('tw2cn');
    expect(body.apply.tw2cn).toBe(false);
    expect(JSON.stringify(body)).toContain('"tw2cn":false');
    expect(JSON.stringify(body)).not.toContain('"tw2cn":true');
    // stored plan was tw2cn:true → the complete draft is a REAL change, so
    // the normalized equality (the ONE Apply-button comparison) stays honest
    expect(
      namingPlanEquals(
        { template: TEMPLATE, ...policy },
        {
          template: TEMPLATE,
          tw2cn: true,
          sourceAliases: policy.sourceAliases,
          recognitionRules: policy.recognitionRules,
        },
      ),
    ).toBe(false);
    // the same complete draft against a stored tw2cn:false plan is NOT a
    // change (draft and stored share every partition)
    expect(
      namingPlanEquals(
        { template: TEMPLATE, ...policy },
        {
          template: TEMPLATE,
          tw2cn: false,
          sourceAliases: policy.sourceAliases,
          recognitionRules: policy.recognitionRules,
        },
      ),
    ).toBe(true);
  });
});

describe('智能命名 workspace — AI trigger + truthful disclosure', () => {
  it('the workspace owns a reachable AI suggestion control', () => {
    const html = renderWorkspace({});
    expect(html).toContain('AI 建议模板');
    expect(html).not.toContain('type="text" name="type"'); // no raw type/id payload
  });

  it('the UI AI request is EXACTLY { ref } for BOTH source and collection entities — never type/id', async () => {
    const suggestion: NamingSuggestion = {
      template: '${emoji} ${region}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
      reason: '识别稳定。',
    };
    const payload: ScrubbedPayload = {
      nodeCount: 0,
      sampled: 0,
      nodes: [],
      sources: [],
      sourcesTotal: 0,
      sourcesTruncated: false,
      regions: [],
      regionsTotal: 0,
      regionsTruncated: false,
      rates: [],
      ratesTotal: 0,
      ratesTruncated: false,
    };
    // capture the outbound call through the REAL request function the
    // workspace button handler invokes, for both entity kinds
    const captured: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
    const fakeApi = async <T>(
      path: string,
      init?: { method?: string; body?: unknown },
    ): Promise<T> => {
      captured.push({ path, init });
      return { data: { suggestion, payload } } as T;
    };
    for (const ref of ['ref-1111111111111111', 'ref-2222222222222222']) {
      const result = await runNamingAnalysisRequest(fakeApi, ref);
      expect(result).toEqual({ suggestion, payload });
    }
    expect(captured).toHaveLength(2);
    for (const call of captured) {
      expect(call.path).toBe('/api/v1/assistant/naming-analysis');
      expect(call.init?.method).toBe('POST');
      const body = call.init?.body as Record<string, unknown>;
      expect(body).toEqual({ ref: expect.stringMatching(/^ref-[0-9a-f]{16}$/) });
      expect(Object.keys(body)).toEqual(['ref']);
      expect(body).not.toHaveProperty('type');
      expect(body).not.toHaveProperty('id');
    }
    // both workspace entity kinds render the reachable AI control
    expect(renderWorkspace({})).toContain('AI 建议模板');
    expect(
      renderWorkspace({
        entity: { type: 'collection' as const, ref: 'ref-2222222222222222', label: '聚合甲' },
        aggregate: true,
      }),
    ).toContain('AI 建议模板');
  });

  it('disclosure panel renders sources as label ?? id and bounded sanitized names — never [object Object]', () => {
    const payload: ScrubbedPayload = {
      nodeCount: 2,
      sampled: 2,
      nodes: [
        {
          i: 0,
          name: '香港 01',
          src: 'src-0000000000000001',
          region: 'HK',
          rate: 1,
          route: null,
          entry: null,
          vendor: null,
          type: 'ss',
          hasResidual: true,
        },
        {
          i: 1,
          name: '日本 2x',
          src: null,
          region: 'JP',
          rate: 2,
          route: null,
          entry: null,
          vendor: null,
          type: 'vmess',
          hasResidual: false,
        },
      ],
      sources: [
        { id: 'src-0000000000000001', label: '机场A' },
        { id: 'src-0000000000000002', label: null },
      ],
      sourcesTotal: 2,
      sourcesTruncated: false,
      regions: [{ code: 'HK', count: 1 }],
      regionsTotal: 1,
      regionsTruncated: false,
      rates: [1, 2],
      ratesTotal: 2,
      ratesTruncated: false,
    };
    const suggestion: NamingSuggestion = {
      template: '${emoji} ${region}${?source: · ${source}}',
      tw2cn: false,
      sourceAliases: {},
      recognitionRules: [],
      reason: '识别稳定，建议均衡方案。',
    };
    const html = renderToStaticMarkup(
      createElement(AiAnalysisPanel, {
        suggestion,
        payload,
        onApply: () => undefined,
      }),
    );
    expect(html).toContain('机场A'); // sanitized source label
    expect(html).toContain('src-0000000000000002'); // null label → opaque id
    expect(html).toContain('香港 01'); // bounded sanitized original display name
    expect(html).toContain('已脱敏'); // truthful disclosure copy
    expect(html).toContain('原始显示名');
    expect(html).not.toContain('[object Object]');
    // credentials / endpoints / internal ids never render
    for (const seed of [
      'evil.example',
      'sk-abc',
      '00000000-0000-4000-8000-000000000000',
      'my-sub',
    ]) {
      expect(html).not.toContain(seed);
    }
  });
});

describe('generic OperatorWorkbench — immutable managed-row authority', () => {
  const managedRow = {
    id: 'naming-plan',
    kind: 'rename-template',
    template: '${emoji} ${region}',
    recognitionRules: [],
  };
  const ordinaryRow = { id: 'f-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } };
  const ordinary2 = { id: 'f-2', kind: 'flag-emoji', regions: { JP: '🇯🇵' } };
  const ordinary3 = { id: 'f-3', kind: 'flag-emoji', regions: { US: '🇺🇸' } };

  function renderWorkbench(operators: unknown[]): string {
    return renderToStaticMarkup(
      createElement(OperatorWorkbench, {
        entityId: 'sub-1',
        loadPath: '/api/v1/subscriptions/sub-1',
        previewPath: '/api/v1/subscriptions/sub-1/preview',
        savePath: '/api/v1/subscriptions/sub-1',
        backHref: '/subscriptions',
        crumbPrefix: '订阅源',
        introNoun: '订阅源',
        aggregate: false,
        pickLabel: () => '机场A',
        initialEntity: { name: 'my-sub', display_name: '机场A', operators },
      } as never),
    );
  }

  it('the generic add menu excludes rename-template (managed rows are not generically creatable)', () => {
    for (const kinds of Object.values(ADDABLE_KINDS)) {
      expect(kinds).not.toContain('rename-template');
    }
    expect(ADDABLE_KINDS.naming).toContain('rename-regex');
    expect(ADDABLE_KINDS.naming).toContain('flag-emoji');
  });

  it('a managed rename-template row renders an immutable summary + 智能命名 link — no toggle/delete/move', () => {
    // only the managed row renders here so the absence assertions are
    // scoped to ITS card (the ordinary-row controls are asserted separately)
    const html = renderWorkbench([managedRow]);
    // the template summary is rendered read-only
    expect(html).toContain('${emoji} ${region}');
    // the immutable card links to the dedicated naming workspace
    expect(html).toContain('href="/subscriptions/sub-1/naming"');
    expect(html).toContain('打开智能命名工作台');
    // no generic mutation controls for the managed row: the card carries no
    // 停用/删除/上移/下移 buttons and no editable textarea
    expect(html).not.toContain('aria-label="停用"');
    expect(html).not.toContain('aria-label="删除"');
    expect(html).not.toContain('aria-label="上移"');
    expect(html).not.toContain('aria-label="下移"');
    expect(html).not.toContain('<textarea');
    // the summary is display-only: no AI control, no alias editor inputs
    expect(html).not.toContain('AI 建议模板');
    expect(html).not.toContain('aria-label="来源标识"');
  });

  it('ordinary rows keep their generic edit/toggle/move controls', () => {
    const html = renderWorkbench([managedRow, ordinaryRow]);
    expect(html).toContain('aria-label="停用"');
    expect(html).toContain('aria-label="删除"');
    expect(html).toContain('aria-label="上移"');
    expect(html).toContain('aria-label="下移"');
  });

  it('ordinary move controls are anchor-boundary aware — crossing the managed row is unavailable in the rendered UI (round-7 HIGH-2)', () => {
    // before → after crossing: [o1, o2, managed] — o2's DOWN must be disabled
    const beforeAnchor = renderWorkbench([ordinaryRow, ordinary2, managedRow]);
    expect(moveButtonCount(beforeAnchor, '上移')).toBe(2);
    expect(disabledMoveCount(beforeAnchor, '上移')).toBe(1); // o1 at boundary
    expect(moveButtonCount(beforeAnchor, '下移')).toBe(2);
    expect(disabledMoveCount(beforeAnchor, '下移')).toBe(1); // o2 would cross the anchor
    // after → before crossing: [managed, o1, o2, o3] — o1's UP must be disabled
    const afterAnchor = renderWorkbench([managedRow, ordinaryRow, ordinary2, ordinary3]);
    expect(moveButtonCount(afterAnchor, '上移')).toBe(3);
    expect(disabledMoveCount(afterAnchor, '上移')).toBe(1); // o1 would cross the anchor
    expect(moveButtonCount(afterAnchor, '下移')).toBe(3);
    expect(disabledMoveCount(afterAnchor, '下移')).toBe(1); // o3 at boundary
    // same-side moves on both sides stay AVAILABLE (not disabled)
    expect(moveButtonCount(afterAnchor, '上移') - disabledMoveCount(afterAnchor, '上移')).toBe(2);
    expect(moveButtonCount(afterAnchor, '下移') - disabledMoveCount(afterAnchor, '下移')).toBe(2);
  });

  it('canMoveStep — the ONE predicate behind the rendered controls — allows same-side and forbids crossing moves (round-7 HIGH-2)', () => {
    const ops = [managedRow, ordinaryRow, ordinary2] as StoredOperator[];
    // managed row itself is never movable
    expect(canMoveStep(ops, 0, 1)).toBe(false);
    expect(canMoveStep(ops, 0, -1)).toBe(false);
    // ordinary row adjacent AFTER the anchor cannot move up across it
    expect(canMoveStep(ops, 1, -1)).toBe(false);
    // same-side reorder below the anchor stays valid
    expect(canMoveStep(ops, 1, 1)).toBe(true);
    expect(canMoveStep(ops, 2, -1)).toBe(true);
    // ordinary rows adjacent BEFORE the anchor: same-side moves stay valid,
    // crossing DOWN onto the anchor is unavailable
    const before = [ordinaryRow, ordinary2, managedRow] as StoredOperator[];
    expect(canMoveStep(before, 0, 1)).toBe(true);
    expect(canMoveStep(before, 1, -1)).toBe(true);
    expect(canMoveStep(before, 1, 1)).toBe(false);
    // boundaries
    expect(canMoveStep(before, 0, -1)).toBe(false);
    expect(canMoveStep(before, 2, 1)).toBe(false);
  });
});

/** Count of rendered move-control buttons with the given aria-label. */
function moveButtonCount(html: string, label: string): number {
  return Array.from(html.matchAll(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'g')))
    .length;
}

/** Count of rendered move-control buttons that are disabled. */
function disabledMoveCount(html: string, label: string): number {
  return Array.from(
    html.matchAll(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'g')),
  ).filter((m) => m[0].includes('disabled=""')).length;
}

/** Occurrence count of a literal substring in rendered markup. */
function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('generic OperatorWorkbench — logical-managed authority (round-8 HIGH-2)', () => {
  // The stored decoder's EXACT discriminants: only the FIRST current-valid
  // rename-template row decodes plain; runtime-invalid and later-duplicate
  // rename-shaped rows carry a fixed compatibility_issue.
  const managedRow = {
    id: 'naming-plan',
    kind: 'rename-template',
    template: '${emoji} ${region}',
    recognitionRules: [],
  };
  const invalidRT = {
    id: 'rt-old',
    kind: 'rename-template',
    template: '${region} ${index}',
    disabled: true,
    compatibility_issue: 'runtime-validation-required',
  };
  const duplicateRT = {
    id: 'rt-2',
    kind: 'rename-template',
    template: '${emoji} ${region}',
    disabled: true,
    compatibility_issue: 'duplicate-rename-template',
  };
  const parkedRow = {
    id: 'parked-1',
    kind: '__incompatible__',
    disabled: true,
    compatibility_issue: 'malformed-operator',
  };
  const ordinaryRow = { id: 'f-1', kind: 'flag-emoji', regions: { HK: '🇭🇰' } };
  const ordinary2 = { id: 'f-2', kind: 'flag-emoji', regions: { JP: '🇯🇵' } };

  function renderWorkbench(operators: unknown[]): string {
    return renderToStaticMarkup(
      createElement(OperatorWorkbench, {
        entityId: 'sub-1',
        loadPath: '/api/v1/subscriptions/sub-1',
        previewPath: '/api/v1/subscriptions/sub-1/preview',
        savePath: '/api/v1/subscriptions/sub-1',
        backHref: '/subscriptions',
        crumbPrefix: '订阅源',
        introNoun: '订阅源',
        aggregate: false,
        pickLabel: () => '机场A',
        initialEntity: { name: 'my-sub', display_name: '机场A', operators },
      } as never),
    );
  }

  function expectNoGenericEditorPath(html: string): void {
    expect(html).not.toContain('aria-label="无法启停"');
    expect(html).not.toContain('aria-label="启用"');
    expect(html).not.toContain('aria-label="停用"');
    expect(html).not.toContain('aria-label="展开"');
    expect(html).not.toContain('aria-label="收起"');
    expect(html).not.toMatch(/<button[^>]*class="[^"]*_titleBtn_[^"]*"[^>]*aria-expanded=/);
    expect(html).not.toContain('href="/subscriptions/sub-1/naming"');
    expect(html).not.toContain('打开智能命名工作台');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('这个步骤的历史数据无法解码');
  }

  function withTemporaryCompatibilityIssue<T>(descriptor: PropertyDescriptor, fn: () => T): T {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'compatibility_issue');
    Object.defineProperty(Object.prototype, 'compatibility_issue', descriptor);
    try {
      return fn();
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(Object.prototype, 'compatibility_issue');
      } else {
        Object.defineProperty(Object.prototype, 'compatibility_issue', prior);
      }
    }
  }

  it('runtime-invalid rename-template BEFORE the valid managed row is NOT an anchor — moves pass over it, the later valid row stays the only anchor', () => {
    const ops = [invalidRT, ordinaryRow, managedRow] as StoredOperator[];
    // the invalid row itself moves like an ordinary row
    expect(canMoveStep(ops, 0, 1)).toBe(true);
    expect(canMoveStep(ops, 0, -1)).toBe(false); // boundary
    // an ordinary row can cross the invalid row…
    expect(canMoveStep(ops, 1, -1)).toBe(true);
    // …but never the real managed anchor; the anchor itself never moves
    expect(canMoveStep(ops, 1, 1)).toBe(false);
    expect(canMoveStep(ops, 2, -1)).toBe(false);
    expect(canMoveStep(ops, 2, 1)).toBe(false); // boundary
  });

  it('runtime-invalid rename-template renders only recovery affordances, no toggle/expand/editor path (round-9)', () => {
    const html = renderWorkbench([invalidRT]);
    expect(html).toContain('历史模板不符合当前规则');
    expect(html).toContain('aria-label="上移"');
    expect(html).toContain('aria-label="下移"');
    expect(html).toContain('aria-label="删除"');
    expectNoGenericEditorPath(html);
    expect(countOccurrences(renderWorkbench([invalidRT, managedRow]), '打开智能命名工作台')).toBe(
      1,
    );
  });

  it('valid managed row + later duplicate: the duplicate is NOT a second anchor — moves pass around it on the same side', () => {
    const ops = [managedRow, ordinaryRow, duplicateRT, ordinary2] as StoredOperator[];
    // the managed row itself never moves
    expect(canMoveStep(ops, 0, 1)).toBe(false);
    expect(canMoveStep(ops, 0, -1)).toBe(false);
    // …but move freely around the duplicate on their same side
    expect(canMoveStep(ops, 1, 1)).toBe(true);
    expect(canMoveStep(ops, 2, -1)).toBe(true);
    expect(canMoveStep(ops, 2, 1)).toBe(true);
    expect(canMoveStep(ops, 3, -1)).toBe(true);
    expect(canMoveStep(ops, 3, 1)).toBe(false); // boundary
  });

  it('duplicate rename-template renders only recovery affordances, no toggle/expand/editor path (round-9)', () => {
    const html = renderWorkbench([duplicateRT]);
    expect(html).toContain('重复的历史名称统一步骤');
    expect(html).toContain('aria-label="上移"');
    expect(html).toContain('aria-label="下移"');
    expect(html).toContain('aria-label="删除"');
    expectNoGenericEditorPath(html);
    expect(countOccurrences(renderWorkbench([managedRow, duplicateRT]), '打开智能命名工作台')).toBe(
      1,
    );
  });

  it('no-valid-runtime state (only runtime-invalid rename-template): no managed anchor — ordinary moves are never falsely blocked', () => {
    const ops = [ordinaryRow, invalidRT, ordinary2] as StoredOperator[];
    expect(canMoveStep(ops, 0, 1)).toBe(true);
    expect(canMoveStep(ops, 1, -1)).toBe(true);
    expect(canMoveStep(ops, 1, 1)).toBe(true);
    expect(canMoveStep(ops, 2, -1)).toBe(true);
    expect(canMoveStep(ops, 0, -1)).toBe(false); // boundary
    expect(canMoveStep(ops, 2, 1)).toBe(false); // boundary
    // the invalid row keeps movement and deletion; NO toggle (round-9)
    const html = renderWorkbench([ordinaryRow, invalidRT, ordinary2]);
    expect(html).toContain('aria-label="删除"');
    expect(html).not.toContain('aria-label="启用"');
    expect(html).not.toContain('打开智能命名工作台');
  });

  it('fixed __incompatible__ parked placeholders keep only diagnostic + move/delete affordances', () => {
    const ops = [parkedRow, ordinaryRow] as StoredOperator[];
    // parked rows are NOT managed anchors: moves over them stay available
    expect(canMoveStep(ops, 0, 1)).toBe(true);
    expect(canMoveStep(ops, 1, -1)).toBe(true);
    const html = renderWorkbench([parkedRow]);
    expect(html).toContain('无法解码');
    expect(html).toContain('malformed-operator'); // fixed diagnostic code, never raw fields
    expect(moveButtonCount(html, '上移')).toBe(1);
    expect(moveButtonCount(html, '下移')).toBe(1);
    expect(html).toContain('aria-label="删除"');
    expectNoGenericEditorPath(html);
  });

  it('isLogicalManagedOperator — the ONE shared predicate classifies every decoded discriminant exactly', () => {
    expect(isLogicalManagedOperator(managedRow as StoredOperator)).toBe(true); // plain valid
    expect(isLogicalManagedOperator(invalidRT as StoredOperator)).toBe(false); // runtime-invalid
    expect(isLogicalManagedOperator(duplicateRT as StoredOperator)).toBe(false); // duplicate
    expect(isLogicalManagedOperator(parkedRow as StoredOperator)).toBe(false); // parked
    expect(isLogicalManagedOperator(ordinaryRow as StoredOperator)).toBe(false); // ordinary kind
  });

  it('temporary compatibility_issue helper restores an exact prior descriptor after throws', () => {
    const environmentPrior = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'compatibility_issue',
    );
    const sentinel: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      writable: true,
      value: 'sentinel',
    };
    const boom = new Error('restore-sentinel');
    let caught: unknown;
    try {
      Object.defineProperty(Object.prototype, 'compatibility_issue', sentinel);
      try {
        withTemporaryCompatibilityIssue(
          {
            configurable: true,
            enumerable: true,
            get() {
              return 'runtime-validation-required';
            },
          },
          () => {
            throw boom;
          },
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(boom);
      expect(Object.getOwnPropertyDescriptor(Object.prototype, 'compatibility_issue')).toEqual(
        sentinel,
      );
    } finally {
      if (environmentPrior === undefined) {
        Reflect.deleteProperty(Object.prototype, 'compatibility_issue');
      } else {
        Object.defineProperty(Object.prototype, 'compatibility_issue', environmentPrior);
      }
    }
  });

  it('inherited Object.prototype compatibility_issue never demotes a valid managed row and never fires a getter', () => {
    const dataResult = withTemporaryCompatibilityIssue(
      {
        configurable: true,
        value: 'runtime-validation-required',
        writable: true,
        enumerable: true,
      },
      () => isLogicalManagedOperator(managedRow as StoredOperator),
    );
    expect(dataResult).toBe(true);

    let fired = 0;
    const getterResult = withTemporaryCompatibilityIssue(
      {
        configurable: true,
        enumerable: true,
        get() {
          fired += 1;
          return 'runtime-validation-required';
        },
      },
      () => isLogicalManagedOperator(managedRow as StoredOperator),
    );
    expect(fired).toBe(0);
    expect(getterResult).toBe(true);
  });
});
