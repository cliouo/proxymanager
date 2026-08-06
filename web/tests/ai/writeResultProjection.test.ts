import { describe, expect, it } from 'vitest';
import {
  projectWriteResult,
  UNKNOWN_OUTCOME_BODY,
  type WriteResultProjection,
} from '@/lib/ai/writeResultProjection';
import type { ActionEnvelope } from '@/lib/ai/actions/types';

/**
 * Round-2 Decision 3 — model-safe confirmed-write projection.
 *
 * The write action envelope is internal UI data; the model must never receive
 * the raw envelope (nested results, raw ids, auditId, stable keys, URLs,
 * credentials). projectWriteResult splits it into:
 *   - uiEnvelope — closed shape: kind 'write-result', data { op, summary,
 *     events[{id, op, undoable}] } — exactly what the undo UI consumes;
 *   - modelContent — JSON with EXACTLY { status: 'success', action, summary }.
 *
 * The hostile-envelope oracle recursively injects every forbidden category;
 * neither output may contain any of it.
 */

function hostileEnvelope(): ActionEnvelope {
  return {
    kind: 'write-result',
    data: {
      op: 'update',
      summary: '已修改算子 ' + 'https://evil.example/x?k=v',
      result: {
        ref: '11111111-1111-4111-8111-111111111111',
        operatorHandle: 'op-1234567890abcdef',
        auditId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        stableKey: 'airport-a',
        nested: { uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', token: 'sk-abcdef1234567890' },
      },
      events: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', op: 'update', undoable: true }],
    },
  };
}

// The undo EVENT ID is consumed by the UI (cards.tsx WriteResultCard) — it
// legitimately appears in the uiEnvelope; the MODEL content must never see
// any of it.
const UI_FORBIDDEN = [
  'https://evil.example',
  '11111111-1111-4111-8111-111111111111',
  'op-1234567890abcdef',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'airport-a',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'sk-abcdef1234567890',
];

const MODEL_FORBIDDEN = [...UI_FORBIDDEN, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'];

/** Recursive scan: every string of the serialized output must avoid the seeds. */
function assertNoForbidden(serialized: string, label: string, seeds: string[]): void {
  for (const seed of seeds) {
    expect(serialized, `${label} leaks ${seed}`).not.toContain(seed);
  }
}

describe('projectWriteResult', () => {
  it('uiEnvelope keeps ONLY the closed UI keys (kind/data.op/data.summary/data.events id+op+undoable)', () => {
    const projection = projectWriteResult(hostileEnvelope(), 'update_operator');
    expect(projection.outcome).toBe('ok');
    const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
    expect(uiEnvelope).toEqual({
      kind: 'write-result',
      data: {
        op: 'update',
        summary: expect.stringContaining('已修改算子'),
        events: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', op: 'update', undoable: true }],
      },
    });
    // the enriched non-undo event (naming-plan-saved) is dropped — the UI
    // consumes only id/op/undoable; the event carries no id → not undoable
    expect(uiEnvelope.data.events).toHaveLength(1);
    const serialized = JSON.stringify(uiEnvelope);
    assertNoForbidden(serialized, 'uiEnvelope', UI_FORBIDDEN);
    // the undo event id IS the UI's undo handle — it must be present
    expect(serialized).toContain('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    // no nested result, no extra keys anywhere
    expect(serialized).not.toContain('"result"');
    expect(serialized).not.toContain('"nested"');
    expect(serialized).not.toContain('auditId');
  });

  it('modelContent is EXACTLY {status, action, summary} — fixed success, registered action name, sanitized bounded summary', () => {
    const projection = projectWriteResult(hostileEnvelope(), 'update_operator');
    const modelContent = projection.modelContent as string;
    const parsed = JSON.parse(modelContent) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['action', 'status', 'summary']);
    expect(parsed.status).toBe('success');
    expect(parsed.action).toBe('update_operator');
    expect(typeof parsed.summary).toBe('string');
    expect((parsed.summary as string).length).toBeLessThanOrEqual(512);
    assertNoForbidden(modelContent, 'modelContent', MODEL_FORBIDDEN);
    expect(modelContent).toContain('已修改算子');
  });

  it('a malformed post-write envelope yields an unknown outcome marker, never a claimed success', () => {
    for (const bad of [
      null,
      undefined,
      'plain string',
      { kind: 'read-result', data: { x: 1 } },
      { kind: 'write-result' },
      { kind: 'write-result', data: null },
      { kind: 'write-result', data: {} }, // empty data — round-2 manufactured fallbacks are gone
      { kind: 'write-result', data: { op: 'update' } }, // missing summary
      { kind: 'write-result', data: { summary: 'ok' } }, // missing op
      { kind: 'write-result', data: { op: 42, summary: 'ok' } }, // wrong op type
      { kind: 'write-result', data: { op: 'update', summary: 42 } }, // wrong summary type
      { kind: 'write-result', data: { op: 'update', summary: 'ok', events: {} } }, // non-array events
      { kind: 'write-result', data: { op: 'update', summary: 'ok', events: 'x' } },
      { kind: 'write-result', data: { op: 'update', summary: 'ok', events: [1, 2] } }, // primitive events
      { kind: 'write-result', data: { op: 'update', summary: 'ok', events: [{}] } }, // blank event
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'ok', events: [{ id: '', op: 'x' }] },
      }, // blank id
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'ok', events: [{ id: 'i', op: '' }] },
      }, // blank op
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'ok', events: [{ id: 'i', op: 'x', undoable: 'yes' }] },
      }, // wrong-typed undoable
      { kind: 'write-result', data: { op: 'https://evil.example/x', summary: 'ok' } }, // credential-only op
      { kind: 'write-result', data: { op: 'update', summary: 'https://evil.example/x?k=v' } }, // credential-only summary
      { kind: 'write-result', data: { op: '00000000-0000-0000-0000-000000000000', summary: 'ok' } }, // UUID-only op
      { kind: 'write-result', data: { op: 'update', summary: 'sk-abcdef1234567890' } }, // token-only summary
      {
        kind: 'write-result',
        data: {
          op: 'update',
          summary: 'ok',
          events: Array.from({ length: 65 }, (_, i) => ({ id: 'id-' + i, op: 'x' })),
        },
      }, // over-cap events
    ]) {
      const result = projectWriteResult(bad as never, 'update_operator');
      expect(result.outcome, JSON.stringify(bad)).toBe('unknown');
      expect(result.uiEnvelope).toBeNull();
      expect(result.modelContent).toBeNull();
    }
  });

  it('invalid actionName fails closed', () => {
    const envelope = { kind: 'write-result', data: { op: 'update', summary: 'ok', events: [] } };
    for (const action of ['', ' ', 'Not-Snake', 'UPPER', 'has space', 'x'.repeat(129), 42, null]) {
      const result = projectWriteResult(envelope, action as never);
      expect(result.outcome, String(action)).toBe('unknown');
    }
  });

  it('round-3: safe op + partly hostile summary yield ONE sanitized summary byte-identical in UI and model; raw result dropped', () => {
    const envelope: ActionEnvelope = {
      kind: 'write-result',
      data: {
        op: 'update',
        summary: '已应用命名模板到 机场A https://evil.example/x?k=v',
        result: {
          auditId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          ref: '11111111-1111-4111-8111-111111111111',
        },
        events: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', op: 'update', undoable: true }],
      },
    };
    const projection = projectWriteResult(envelope, 'save_naming_plan');
    expect(projection.outcome).toBe('ok');
    const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
    const model = JSON.parse(projection.modelContent as string) as Record<string, unknown>;
    // the sanitized summary is byte-identical in UI and model
    expect(uiEnvelope.data.summary).toBe('已应用命名模板到 机场A');
    expect(model.summary).toBe(uiEnvelope.data.summary);
    expect(model).toEqual({
      status: 'success',
      action: 'save_naming_plan',
      summary: '已应用命名模板到 机场A',
    });
    expect(Object.keys(model).sort()).toEqual(['action', 'status', 'summary']);
    // raw result dropped entirely
    const serialized = JSON.stringify(uiEnvelope);
    expect(serialized).not.toContain('aaaaaaaa-aaaa');
    expect(serialized).not.toContain('11111111-1111');
    expect(serialized).not.toContain('"result"');
    expect(serialized).not.toContain('evil.example');
  });

  it('summary is redacted + bounded even when the action summary embeds hostile spans', () => {
    const envelope: ActionEnvelope = {
      kind: 'write-result',
      data: {
        op: 'add',
        summary: '新模板 ' + 'https://user:pass@1.2.3.4:443/x?k=v ' + 'x'.repeat(900),
        events: [],
      },
    };
    const projection = projectWriteResult(envelope, 'save_naming_plan');
    const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
    const modelContent = projection.modelContent as string;
    expect(JSON.stringify(uiEnvelope)).not.toContain('1.2.3.4');
    expect(JSON.stringify(uiEnvelope)).not.toContain('user:pass');
    const parsed = JSON.parse(modelContent) as { summary: string };
    expect(parsed.summary.length).toBeLessThanOrEqual(512);
    expect(parsed.summary).not.toContain('user:pass');
  });
});

describe('round-4 receipt-only canonicalization (credential-only must fail closed)', () => {
  const HOSTILE = [
    'Bearer FAKE_TOKEN_0001',
    'sk-FAKE_EXAMPLE_0001',
    'https://fixture:FAKE_PASSWORD@example.invalid/path?token=FAKE_TOKEN',
    '00000000-0000-4000-8000-000000000000',
    'token=FAKE_PLACEHOLDER',
    'Bearer',
    'sk-',
    '00000000-0000-4000-8000-000000000000',
    'redacted',
    '[REDACTED]',
    'masked',
    'https:',
    '://',
    'token FAKE_TOKEN_0001',
    'eyJFAKE.eyJFAKE.eyJFAKE',
  ];

  it('every credential-only op with valid events:[] yields unknown and never reflects the fixture', () => {
    for (const hostile of HOSTILE) {
      const envelope = {
        kind: 'write-result',
        data: { op: hostile, summary: 'Updated node', events: [] },
      };
      const projection = projectWriteResult(envelope, 'update_rule');
      expect(projection.outcome, `op ${hostile}`).toBe('unknown');
      expect(projection.uiEnvelope).toBeNull();
      expect(projection.modelContent).toBeNull();
    }
  });

  it('every credential-only summary with valid events:[] yields unknown and never reflects the fixture', () => {
    for (const hostile of HOSTILE) {
      const envelope = {
        kind: 'write-result',
        data: { op: 'update', summary: hostile, events: [] },
      };
      const projection = projectWriteResult(envelope, 'update_rule');
      expect(projection.outcome, `summary ${hostile}`).toBe('unknown');
      expect(projection.uiEnvelope).toBeNull();
      expect(projection.modelContent).toBeNull();
    }
    // and no hostile fixture string may ever appear in the unknown marker
  });

  it('safe mixed human text + hostile span succeeds ONLY with the exact predetermined residue in UI AND model', () => {
    const cases: Array<[string, string]> = [
      ['Updated node Bearer FAKE_TOKEN_0001', 'Updated node'],
      ['Updated node sk-FAKE_EXAMPLE_0001', 'Updated node'],
      [
        'Updated node https://fixture:FAKE_PASSWORD@example.invalid/path?token=FAKE_TOKEN',
        'Updated node',
      ],
      ['Updated node 00000000-0000-4000-8000-000000000000', 'Updated node'],
      ['Updated node token=FAKE_PLACEHOLDER', 'Updated node'],
      ['Updated node', 'Updated node'],
    ];
    for (const [input, expected] of cases) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op: 'update', summary: input, events: [] } },
        'update_rule',
      );
      expect(projection.outcome, input).toBe('ok');
      const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
      expect(uiEnvelope.data.summary, input).toBe(expected);
      const model = JSON.parse(projection.modelContent as string) as { summary: string };
      expect(model.summary, input).toBe(expected);
      expect(model).toEqual({ status: 'success', action: 'update_rule', summary: expected });
    }
  });

  it('op must be a production-compatible lower-kebab token beginning with a letter', () => {
    const valid = ['update', 'add', 'delete', 'rename-local-node', 'save-naming-plan'];
    for (const op of valid) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op, summary: 'Updated node', events: [] } },
        'update_rule',
      );
      expect(projection.outcome, op).toBe('ok');
    }
    for (const op of ['UPDATE', 'update_node', 'update.node', '1update', '-update', 'update_']) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op, summary: 'Updated node', events: [] } },
        'update_rule',
      );
      expect(projection.outcome, op).toBe('unknown');
    }
  });

  it('canonical bounds REJECT rather than truncate', () => {
    const longOp = 'update-' + 'a'.repeat(70);
    // canonical text that SURVIVES redaction (CJK tokens) and exceeds 512
    const longSummary = 'Updated node ' + '机场 '.repeat(300);
    expect(
      projectWriteResult(
        { kind: 'write-result', data: { op: longOp, summary: 'Updated node', events: [] } },
        'update_rule',
      ).outcome,
    ).toBe('unknown');
    expect(
      projectWriteResult(
        { kind: 'write-result', data: { op: 'update', summary: longSummary, events: [] } },
        'update_rule',
      ).outcome,
    ).toBe('unknown');
    // raw bounds: oversized raw input is bounded BEFORE work, then rejected
    expect(
      projectWriteResult(
        {
          kind: 'write-result',
          data: { op: 'update', summary: 'Updated node ' + '机场 '.repeat(900), events: [] },
        },
        'update_rule',
      ).outcome,
    ).toBe('unknown');
  });

  it('retains the exact canonical success oracle and malformed-envelope/events guards', () => {
    const ok = projectWriteResult(
      { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events: [] } },
      'update_rule',
    );
    expect(ok.outcome).toBe('ok');
    expect(ok.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
    // events remain strict and required
    for (const events of [
      undefined,
      {},
      'x',
      [{ id: '' }],
      Array.from({ length: 65 }, (_, i) => ({ id: 'i' + i, op: 'x' })),
    ]) {
      expect(
        projectWriteResult(
          { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events } },
          'update_rule',
        ).outcome,
      ).toBe('unknown');
    }
    expect(
      projectWriteResult(
        { kind: 'read-result', data: { op: 'update', summary: 'Updated node', events: [] } },
        'update_rule',
      ).outcome,
    ).toBe('unknown');
  });
});

describe('round-5 ordered atomic receipt grammar (short/Authorization/sk credentials must fail closed)', () => {
  const ROUND5_HOSTILE = [
    'Authorization: Bearer FAKE_TOKEN_0001',
    'Bearer a',
    'Bearer abc',
    'Basic a',
    'Basic abc',
    'Token a',
    'Token abc',
    'Bearer',
    'Basic',
    'Token',
    'sk-',
    'sk-a',
    'sk-abc',
    'sk-FAKE',
    'op: sk-fake',
  ];
  const SAFE_MIXED: Array<[string, string]> = [
    ['Updated node Authorization: Bearer FAKE_TOKEN_0001', 'Updated node'],
    ['Updated node Bearer a', 'Updated node'],
    ['Updated node Bearer abc', 'Updated node'],
    ['Updated node Basic a', 'Updated node'],
    ['Updated node Basic abc', 'Updated node'],
    ['Updated node Token a', 'Updated node'],
    ['Updated node Token abc', 'Updated node'],
    ['Updated node Bearer', 'Updated node'],
    ['Updated node Basic', 'Updated node'],
    ['Updated node Token', 'Updated node'],
    ['Updated node sk-', 'Updated node'],
    ['Updated node sk-a', 'Updated node'],
    ['Updated node sk-abc', 'Updated node'],
    ['Updated node sk-FAKE', 'Updated node'],
    ['Updated node op: sk-fake', 'Updated node'],
  ];

  it('every short/Authorization/sk credential-only SUMMARY with valid events:[] yields unknown, null UI/model, no reflection', () => {
    for (const hostile of ROUND5_HOSTILE) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op: 'update', summary: hostile, events: [] } },
        'update_rule',
      );
      expect(projection.outcome, `summary ${hostile}`).toBe('unknown');
      expect(projection.uiEnvelope).toBeNull();
      expect(projection.modelContent).toBeNull();
    }
  });

  it('every short/Authorization/sk credential-only OP with valid events:[] yields unknown, null UI/model', () => {
    for (const hostile of ROUND5_HOSTILE) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op: hostile, summary: 'Updated node', events: [] } },
        'update_rule',
      );
      expect(projection.outcome, `op ${hostile}`).toBe('unknown');
      expect(projection.uiEnvelope).toBeNull();
      expect(projection.modelContent).toBeNull();
    }
  });

  it('legitimate lower-kebab ops that merely contain unrelated sk/bearer/token letters stay positive', () => {
    const safeOps = [
      'ask-user',
      'mask-node',
      'risk-check',
      'token-refresh',
      'basic-check',
      'task-sk-fake',
    ];
    for (const op of safeOps) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op, summary: 'Updated node', events: [] } },
        'update_rule',
      );
      expect(projection.outcome, op).toBe('ok');
      const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
      expect(uiEnvelope.data.op).toBe(op);
      expect(uiEnvelope.data.summary).toBe('Updated node');
      const model = JSON.parse(projection.modelContent as string) as { summary: string };
      expect(model.summary).toBe('Updated node');
    }
  });

  it('safe mixed human text + hostile span succeeds ONLY with the exact predetermined residue in UI AND model', () => {
    for (const [input, expected] of SAFE_MIXED) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op: 'update', summary: input, events: [] } },
        'update_rule',
      );
      expect(projection.outcome, input).toBe('ok');
      const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
      expect(uiEnvelope.data.summary, input).toBe(expected);
      const model = JSON.parse(projection.modelContent as string) as { summary: string };
      expect(model.summary, input).toBe(expected);
      expect(model).toEqual({ status: 'success', action: 'update_rule', summary: expected });
    }
  });

  it('parity: case variants, URL/UUID/key-value/JWT/opaque/placeholders/controls/multiple spans', () => {
    const parity: Array<[string, string]> = [
      ['Updated node BEARER ABC', 'Updated node'],
      [
        'Updated node https://user:FAKE_PASSWORD@example.invalid/path?token=FAKE_TOKEN',
        'Updated node',
      ],
      ['Updated node 00000000-0000-0000-0000-000000000000', 'Updated node'],
      ['Updated node token=a', 'Updated node'],
      ['Updated node eyJFAKE.eyJFAKE.eyJFAKE', 'Updated node'],
      ['Updated node FAKETOKEN0123456789ABCDEF', 'Updated node'],
      ['Updated node [REDACTED]', 'Updated node'],
      ['Updated node\u0000Bearer abc', 'Updated node'],
      ['Updated node Bearer abc Token def', 'Updated node'],
      ['Updated node sk-a sk-b', 'Updated node'],
    ];
    for (const [input, expected] of parity) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op: 'update', summary: input, events: [] } },
        'update_rule',
      );
      expect(projection.outcome, input).toBe('ok');
      const uiEnvelope = projection.uiEnvelope as NonNullable<typeof projection.uiEnvelope>;
      expect(uiEnvelope.data.summary, input).toBe(expected);
      const model = JSON.parse(projection.modelContent as string) as { summary: string };
      expect(model.summary, input).toBe(expected);
    }
    // the same categories ALONE must fail closed
    for (const hostile of [
      'BEARER ABC',
      'token=a',
      'FAKETOKEN0123456789ABCDEF',
      'op:',
      '00000000-0000-0000-0000-000000000000',
    ]) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op: 'update', summary: hostile, events: [] } },
        'update_rule',
      );
      expect(projection.outcome, `parity hostile ${hostile}`).toBe('unknown');
      expect(projection.modelContent).toBeNull();
    }
  });

  it('raw bounds reject BEFORE normalization; exact 256/2048 may pass, 257/2049 and collapsible reproductions reject', () => {
    // exactly at the raw bound and collapsible → canonical is valid → may pass
    const atRawOpBound = 'update' + ' '.repeat(250); // 256 raw units → 'update'
    const atRawSummaryBound = 'Updated node' + ' '.repeat(2036); // 2048 → 'Updated node'
    expect(
      projectWriteResult(
        {
          kind: 'write-result',
          data: { op: atRawOpBound, summary: 'Updated node', events: [] },
        },
        'update_rule',
      ).outcome,
    ).toBe('ok');
    expect(
      projectWriteResult(
        {
          kind: 'write-result',
          data: { op: 'update', summary: atRawSummaryBound, events: [] },
        },
        'update_rule',
      ).outcome,
    ).toBe('ok');
    // over the raw bound → unknown BEFORE controls/regexes/slicing/redaction
    const overRaw: Array<[string, string]> = [
      ['update' + ' '.repeat(251), 'Updated node'], // raw op 257
      ['update', 'Updated node' + ' '.repeat(2037)], // raw summary 2049
      ['update' + ' '.repeat(294), 'Updated node'], // 300-unit collapsible op reproduction
      ['update', 'Updated node' + ' '.repeat(2050)], // 2062-unit collapsible summary reproduction
      ['update-' + 'a'.repeat(58), 'Updated node'], // canonical op 65 > 64 REJECTS
      ['update', 'Updated node ' + '机场 '.repeat(256)], // canonical summary 780 > 512 REJECTS
    ];
    for (const [op, summary] of overRaw) {
      const projection = projectWriteResult(
        { kind: 'write-result', data: { op, summary, events: [] } },
        'update_rule',
      );
      expect(projection.outcome, `op=${op.length} summary=${summary.length}`).toBe('unknown');
      expect(projection.uiEnvelope).toBeNull();
      expect(projection.modelContent).toBeNull();
    }
  });
});

describe('round-5 REAL producer-to-committed-bundle boundary', () => {
  interface BundleConfirmResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }
  interface McpBundle {
    confirmHiddenWrite: (
      token: string,
      fetchImpl?: (
        url: string,
        init?: unknown,
      ) => Promise<{
        ok: boolean;
        json: () => Promise<unknown>;
      }>,
      expectedAction?: string,
    ) => Promise<BundleConfirmResult>;
  }

  it('calls the ACTUAL projectWriteResult, passes its returned modelContent through the committed bundle, and asserts a literal oracle', async () => {
    // Dynamic import is REQUIRED here: the committed MCP bundle lives outside
    // the web root (sibling plugin/ dir), must be loaded natively at runtime
    // by file URL without Vite transform, and is a deliberately exercised
    // module-loading boundary — a static import cannot express a file-URL
    // specifier outside the project root.
    const committedBundleUrl = new URL(
      '../../../plugin/servers/dist/proxymanager-mcp.bundle.mjs',
      import.meta.url,
    ).href;
    const bundle = (await import(/* @vite-ignore */ committedBundleUrl)) as unknown as McpBundle;
    // a callable fetch stand-in: confirmHiddenWrite invokes fetchImpl(url, init)
    const fakeConfirmResponse = (modelContent: unknown) => async () => ({
      ok: true,
      json: async () => ({
        data: {
          kind: 'write-result',
          data: { op: 'update', summary: 'Updated node', events: [] },
          modelContent,
        },
      }),
    });

    // 1. REAL producer output for safe mixed input → committed bundle boundary
    const projection = projectWriteResult(
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node Bearer abc', events: [] },
      },
      'update_rule',
    );
    expect(projection.outcome).toBe('ok');
    const modelContent = projection.modelContent as string;
    const result = await bundle.confirmHiddenWrite(
      'a'.repeat(36),
      fakeConfirmResponse(modelContent),
      'update_rule',
    );
    expect(result.isError).toBeUndefined();
    // literal independent oracle — never computed with another sanitizer
    expect(result.content[0].text).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );

    // 2. null hostile producer output (unknown outcome ⇒ no modelContent) fails the bundle
    const hostile = projectWriteResult(
      { kind: 'write-result', data: { op: 'update', summary: 'Bearer abc', events: [] } },
      'update_rule',
    );
    expect(hostile.outcome).toBe('unknown');
    expect(hostile.modelContent).toBeNull();
    const nullResult = await bundle.confirmHiddenWrite(
      'a'.repeat(36),
      fakeConfirmResponse(hostile.modelContent),
      'update_rule',
    );
    expect(nullResult.isError).toBe(true);
    expect(nullResult.content[0].text).toContain('result is unknown');

    // 3. separately forged hostile canonical-shaped JSON must fail the bundle too
    const forged = JSON.stringify({
      status: 'success',
      action: 'update_rule',
      summary: 'Updated node Bearer abc',
    });
    const forgedResult = await bundle.confirmHiddenWrite(
      'a'.repeat(36),
      fakeConfirmResponse(forged),
      'update_rule',
    );
    expect(forgedResult.isError).toBe(true);
    expect(forgedResult.content[0].text).toContain('result is unknown');
    expect(forgedResult.content[0].text).not.toContain('Bearer');
    expect(forgedResult.content[0].text).not.toContain('update_rule');
  });
});

describe('round-6 hostile-record boundary: strict plain records only, zero throws, zero reflection', () => {
  const OK_ENVELOPE = () => ({
    kind: 'write-result',
    data: { op: 'update', summary: 'Updated node', events: [] },
  });

  it('class instances, inherited shapes and null-prototype lookalikes are fixed unknown', () => {
    class Envelope {
      kind = 'write-result';
      data = { op: 'update', summary: 'Updated node', events: [] };
    }
    class Data {
      op = 'update';
      summary = 'Updated node';
      events: unknown[] = [];
    }
    const hostile = [
      new Envelope(),
      { kind: 'write-result', data: new Data() },
      // inherited (non-own) data: prototype carries the fields
      Object.create({ kind: 'write-result', data: { op: 'update', summary: 'x', events: [] } }),
      Object.create(
        { data: { op: 'update', summary: 'x', events: [] } },
        {
          kind: { value: 'write-result', enumerable: true },
        },
      ),
      // null-prototype record with symbol keys
      Object.assign(Object.create(null), {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node', events: [] },
        [Symbol('x')]: 1,
      }),
    ];
    for (const envelope of hostile) {
      const result = projectWriteResult(envelope, 'update_rule');
      expect(result.outcome, JSON.stringify(envelope)).toBe('unknown');
      expect(result.uiEnvelope).toBeNull();
      expect(result.modelContent).toBeNull();
    }
  });

  it('accessors (getters) are never invoked — fixed unknown, zero side effects', () => {
    let fired = 0;
    const envelope = {
      kind: 'write-result',
      get data() {
        fired += 1;
        return { op: 'update', summary: 'Updated node', events: [] };
      },
    };
    const result = projectWriteResult(envelope, 'update_rule');
    expect(result.outcome).toBe('unknown');
    expect(fired).toBe(0); // the getter must never run
    expect(result.modelContent).toBeNull();
  });

  it('a Proxy with throwing traps yields fixed unknown — the projection never throws', () => {
    const boom = new Proxy(OK_ENVELOPE(), {
      getPrototypeOf() {
        throw new Error('trap');
      },
    });
    const boomKeys = new Proxy(OK_ENVELOPE(), {
      ownKeys() {
        throw new Error('trap');
      },
    });
    const boomDesc = new Proxy(OK_ENVELOPE(), {
      getOwnPropertyDescriptor() {
        throw new Error('trap');
      },
    });
    for (const envelope of [boom, boomKeys, boomDesc]) {
      let result: WriteResultProjection | undefined;
      expect(() => {
        result = projectWriteResult(envelope, 'update_rule');
      }).not.toThrow();
      expect(result?.outcome).toBe('unknown');
      expect(result?.uiEnvelope).toBeNull();
      expect(result?.modelContent).toBeNull();
    }
  });

  it('extra keys and symbol keys on the envelope/data/events are rejected', () => {
    const hostile = [
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node', events: [] },
        extra: 1,
      },
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node', events: [], extra: 1 },
      },
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node', events: [{ id: 'i', op: 'x', extra: 1 }] },
      },
      Object.assign(
        { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events: [] } },
        {
          [Symbol('x')]: 1,
        },
      ),
    ];
    for (const envelope of hostile) {
      const result = projectWriteResult(envelope, 'update_rule');
      expect(result.outcome, JSON.stringify(envelope)).toBe('unknown');
    }
  });

  it('a strict plain record with an own enumerable data payload still projects normally', () => {
    const envelope = Object.assign(Object.create(null), {
      kind: 'write-result',
      data: Object.assign(Object.create(null), {
        op: 'update',
        summary: 'Updated node',
        events: [],
      }),
    });
    const result = projectWriteResult(envelope, 'update_rule');
    expect(result.outcome).toBe('ok');
    expect(result.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
  });
});

describe('round-7 Proxy rejection: fixed unknown with ZERO trap/getter observation', () => {
  const OK_ENVELOPE = () => ({
    kind: 'write-result',
    data: { op: 'update', summary: 'Updated node', events: [] },
  });

  /** Transparent Proxy that counts EVERY trap (Reflect forwards to target). */
  function countingProxy<T extends object>(target: T): { proxy: T; traps: () => number } {
    let traps = 0;
    const proxy = new Proxy(target, {
      getPrototypeOf(t) {
        traps += 1;
        return Reflect.getPrototypeOf(t);
      },
      setPrototypeOf(t, v) {
        traps += 1;
        return Reflect.setPrototypeOf(t, v);
      },
      isExtensible(t) {
        traps += 1;
        return Reflect.isExtensible(t);
      },
      preventExtensions(t) {
        traps += 1;
        return Reflect.preventExtensions(t);
      },
      getOwnPropertyDescriptor(t, k) {
        traps += 1;
        return Reflect.getOwnPropertyDescriptor(t, k);
      },
      defineProperty(t, k, d) {
        traps += 1;
        return Reflect.defineProperty(t, k, d);
      },
      has(t, k) {
        traps += 1;
        return Reflect.has(t, k);
      },
      get(t, k, r) {
        traps += 1;
        return Reflect.get(t, k, r);
      },
      set(t, k, v, r) {
        traps += 1;
        return Reflect.set(t, k, v, r);
      },
      deleteProperty(t, k) {
        traps += 1;
        return Reflect.deleteProperty(t, k);
      },
      ownKeys(t) {
        traps += 1;
        return Reflect.ownKeys(t);
      },
    });
    return { proxy, traps: () => traps };
  }

  function assertUnknownZero(envelope: unknown, traps: () => number, label: string): void {
    let result: WriteResultProjection | undefined;
    expect(() => {
      result = projectWriteResult(envelope, 'update_rule');
    }, label).not.toThrow();
    expect(result?.outcome, label).toBe('unknown');
    expect(result?.uiEnvelope, label).toBeNull();
    expect(result?.modelContent, label).toBeNull();
    expect(traps(), label).toBe(0);
  }

  it('a transparent Proxy around a valid receipt is fixed unknown — the projection never inspects it', () => {
    const { proxy, traps } = countingProxy(OK_ENVELOPE());
    assertUnknownZero(proxy, traps, 'envelope proxy');
  });

  it('nested proxies at every record boundary — data, events array, single event — are fixed unknown with zero traps', () => {
    // envelope.data wrapped
    const data = countingProxy(OK_ENVELOPE().data as object);
    assertUnknownZero({ kind: 'write-result', data: data.proxy }, data.traps, 'data proxy');
    // events array wrapped (Array.isArray alone would not reveal a Proxy)
    const events = countingProxy([] as object);
    assertUnknownZero(
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node', events: events.proxy },
      },
      events.traps,
      'events-array proxy',
    );
    // single event wrapped inside an otherwise valid array
    const event = countingProxy({ id: 'i', op: 'x' } as object);
    assertUnknownZero(
      {
        kind: 'write-result',
        data: { op: 'update', summary: 'Updated node', events: [event.proxy] },
      },
      event.traps,
      'event proxy',
    );
  });

  it('a revoked Proxy is fixed unknown and never throws', () => {
    const { proxy, revoke } = Proxy.revocable(OK_ENVELOPE(), {});
    revoke();
    let result: WriteResultProjection | undefined;
    expect(() => {
      result = projectWriteResult(proxy, 'update_rule');
    }).not.toThrow();
    expect(result?.outcome).toBe('unknown');
    expect(result?.uiEnvelope).toBeNull();
    expect(result?.modelContent).toBeNull();
  });

  it('an events array with an indexed accessor fires ZERO getters — the descriptor walk rejects it first', () => {
    let fired = 0;
    const events: unknown[] = [];
    Object.defineProperty(events, 0, {
      enumerable: true,
      configurable: true,
      get() {
        fired += 1;
        return { id: 'i', op: 'x' };
      },
    });
    const result = projectWriteResult(
      { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events } },
      'update_rule',
    );
    expect(result.outcome).toBe('unknown');
    expect(fired).toBe(0);
    // a sparse events array (holes) is not a strict dense array either
    const sparse: unknown[] = [];
    sparse.length = 2;
    const sparseResult = projectWriteResult(
      { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events: sparse } },
      'update_rule',
    );
    expect(sparseResult.outcome).toBe('unknown');
  });

  it('an ordinary dense events array still projects normally', () => {
    const result = projectWriteResult(
      {
        kind: 'write-result',
        data: {
          op: 'update',
          summary: 'Updated node',
          events: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', op: 'update', undoable: true }],
        },
      },
      'update_rule',
    );
    expect(result.outcome).toBe('ok');
    const uiEnvelope = result.uiEnvelope as NonNullable<typeof result.uiEnvelope>;
    expect(uiEnvelope.data.events).toEqual([
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', op: 'update', undoable: true },
    ]);
    expect(result.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
  });

  it('an Array subclass with a hostile inherited iterator is fixed unknown with ZERO side effects', () => {
    class EvilArray extends Array {}
    let fired = 0;
    // @ts-expect-error - hostile test-only iterator on the subclass prototype
    EvilArray.prototype[Symbol.iterator] = function* hostileIterator() {
      fired += 1;
      yield { id: 'i', op: 'x' };
    };
    const events = new EvilArray();
    events.push({ id: 'i', op: 'x' });
    const result = projectWriteResult(
      { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events } },
      'update_rule',
    );
    expect(result.outcome).toBe('unknown');
    expect(fired).toBe(0);
    // a null-prototype array (no iterator at all) is rejected too
    const nullProto: unknown[] = [];
    Object.setPrototypeOf(nullProto, null);
    nullProto[0] = { id: 'i', op: 'x' };
    const nullProtoResult = projectWriteResult(
      { kind: 'write-result', data: { op: 'update', summary: 'Updated node', events: nullProto } },
      'update_rule',
    );
    expect(nullProtoResult.outcome).toBe('unknown');
  });
});

describe('round-7 HIGH-B: sparse event arrays never consume inherited values/getters', () => {
  const OK_EVENT = { id: 'e-1', op: 'update' };
  const envelopeWith = (events: unknown) => ({
    kind: 'write-result',
    data: { op: 'update', summary: 'Updated node', events },
  });

  /** Temporarily define an Array.prototype index property for a fixture.
   * The descriptor is ALWAYS configurable and the prior descriptor is
   * restored in `finally` BEFORE any assertion runs, so parallel tests are
   * never polluted. */
  function withArrayProtoIndex<T>(index: string, descriptor: PropertyDescriptor, fn: () => T): T {
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, index);
    Object.defineProperty(Array.prototype, index, { configurable: true, ...descriptor });
    try {
      return fn();
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(Array.prototype, index);
      } else {
        Object.defineProperty(Array.prototype, index, prior);
      }
    }
  }

  it('leading hole + inherited DATA event: unknown — the inherited event is never accepted', () => {
    // fixture built BEFORE any prototype pollution, per the fixture rule
    const events: unknown[] = [];
    events.length = 2; // hole at index 0
    events[1] = OK_EVENT;
    const envelope = envelopeWith(events);
    let result: WriteResultProjection | undefined;
    withArrayProtoIndex('0', { value: OK_EVENT, writable: true, enumerable: true }, () => {
      result = projectWriteResult(envelope, 'update_rule');
    });
    expect(result?.outcome).toBe('unknown');
    expect(result?.uiEnvelope).toBeNull();
    expect(result?.modelContent).toBeNull();
  });

  it('leading hole + inherited GETTER: unknown and the getter fires ZERO times', () => {
    const events: unknown[] = [];
    events.length = 2; // hole at index 0
    events[1] = OK_EVENT;
    const envelope = envelopeWith(events);
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withArrayProtoIndex(
      '0',
      {
        enumerable: true,
        get() {
          fired += 1;
          return OK_EVENT;
        },
      },
      () => {
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(result?.outcome).toBe('unknown');
    expect(fired).toBe(0);
  });

  it('middle hole + inherited DATA event: unknown — no inherited fill-in', () => {
    const events: unknown[] = [OK_EVENT];
    events.length = 3; // hole at index 1
    events[2] = OK_EVENT;
    const envelope = envelopeWith(events);
    let result: WriteResultProjection | undefined;
    withArrayProtoIndex('1', { value: OK_EVENT, writable: true, enumerable: true }, () => {
      result = projectWriteResult(envelope, 'update_rule');
    });
    expect(result?.outcome).toBe('unknown');
    expect(result?.uiEnvelope).toBeNull();
    expect(result?.modelContent).toBeNull();
  });

  it('middle hole + inherited GETTER: unknown and the getter fires ZERO times', () => {
    const events: unknown[] = [OK_EVENT];
    events.length = 3; // hole at index 1
    events[2] = OK_EVENT;
    const envelope = envelopeWith(events);
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withArrayProtoIndex(
      '1',
      {
        enumerable: true,
        get() {
          fired += 1;
          return OK_EVENT;
        },
      },
      () => {
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(result?.outcome).toBe('unknown');
    expect(fired).toBe(0);
  });

  it('trailing hole: unknown', () => {
    const events: unknown[] = [OK_EVENT];
    events.length = 2; // trailing hole at index 1
    const result = projectWriteResult(envelopeWith(events), 'update_rule');
    expect(result.outcome).toBe('unknown');
    expect(result.uiEnvelope).toBeNull();
    expect(result.modelContent).toBeNull();
  });

  it('dense valid events + inherited numeric SETTER at index 0: success with ZERO setter fires', () => {
    // fixture built BEFORE the pollution: a plain dense valid event array
    const events: unknown[] = [OK_EVENT];
    const envelope = envelopeWith(events);
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withArrayProtoIndex(
      '0',
      {
        enumerable: true,
        set(_value: unknown) {
          void _value;
          fired += 1;
        },
      },
      () => {
        // an index assignment (`snapshot[i] = v`, `out.push(...)`) would
        // walk the polluted prototype and fire this setter — the production
        // snapshot/output construction uses own-data defineProperty instead
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(fired).toBe(0);
    expect(result?.outcome).toBe('ok');
    // the FULL closed UI envelope is preserved exactly — never an empty or
    // setter-swallowed events array
    expect(result?.uiEnvelope).toEqual({
      kind: 'write-result',
      data: {
        op: 'update',
        summary: 'Updated node',
        events: [{ id: 'e-1', op: 'update' }],
      },
    });
    expect(result?.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
  });
});

describe('round-8 HIGH-1: required data fields must be OWN — inherited values/getters never consumed', () => {
  const FIXED_UNKNOWN: WriteResultProjection = {
    outcome: 'unknown',
    uiEnvelope: null,
    modelContent: null,
    responseContent: UNKNOWN_OUTCOME_BODY,
  };
  const VALID_EVENT = { id: 'e-1', op: 'update' };

  /** Temporarily define an Object.prototype property for a fixture. The
   * descriptor is ALWAYS configurable and the prior descriptor is restored
   * in `finally` BEFORE any assertion runs, so parallel tests are never
   * polluted. */
  function withObjectProto<T>(key: string, descriptor: PropertyDescriptor, fn: () => T): T {
    const prior = Object.getOwnPropertyDescriptor(Object.prototype, key);
    Object.defineProperty(Object.prototype, key, { configurable: true, ...descriptor });
    try {
      return fn();
    } finally {
      if (prior === undefined) {
        Reflect.deleteProperty(Object.prototype, key);
      } else {
        Object.defineProperty(Object.prototype, key, prior);
      }
    }
  }

  it('missing own op + inherited DATA on Object.prototype → fixed unknown', () => {
    // fixture built BEFORE pollution: data has no own `op`
    const envelope = {
      kind: 'write-result',
      data: { summary: 'Updated node', events: [] },
    };
    let result: WriteResultProjection | undefined;
    withObjectProto('op', { value: 'update', writable: true, enumerable: true }, () => {
      result = projectWriteResult(envelope, 'update_rule');
    });
    // assertions AFTER restoration
    expect(result).toEqual(FIXED_UNKNOWN);
  });

  it('missing own op + inherited GETTER on Object.prototype → fixed unknown, getter fires ZERO times', () => {
    const envelope = {
      kind: 'write-result',
      data: { summary: 'Updated node', events: [] },
    };
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withObjectProto(
      'op',
      {
        enumerable: true,
        get() {
          fired += 1;
          return 'update';
        },
      },
      () => {
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(fired).toBe(0);
    expect(result).toEqual(FIXED_UNKNOWN);
  });

  it('missing own summary + inherited DATA on Object.prototype → fixed unknown', () => {
    const envelope = {
      kind: 'write-result',
      data: { op: 'update', events: [] },
    };
    let result: WriteResultProjection | undefined;
    withObjectProto('summary', { value: 'Updated node', writable: true, enumerable: true }, () => {
      result = projectWriteResult(envelope, 'update_rule');
    });
    expect(result).toEqual(FIXED_UNKNOWN);
  });

  it('missing own summary + inherited GETTER on Object.prototype → fixed unknown, getter fires ZERO times', () => {
    const envelope = {
      kind: 'write-result',
      data: { op: 'update', events: [] },
    };
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withObjectProto(
      'summary',
      {
        enumerable: true,
        get() {
          fired += 1;
          return 'Updated node';
        },
      },
      () => {
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(fired).toBe(0);
    expect(result).toEqual(FIXED_UNKNOWN);
  });

  it('missing own events + inherited DATA on Object.prototype → fixed unknown', () => {
    const events: unknown[] = [];
    const envelope = {
      kind: 'write-result',
      data: { op: 'update', summary: 'Updated node' },
    };
    let result: WriteResultProjection | undefined;
    withObjectProto('events', { value: events, writable: true, enumerable: true }, () => {
      result = projectWriteResult(envelope, 'update_rule');
    });
    expect(result).toEqual(FIXED_UNKNOWN);
  });

  it('missing own events + inherited GETTER on Object.prototype → fixed unknown, getter fires ZERO times', () => {
    const events: unknown[] = [];
    const envelope = {
      kind: 'write-result',
      data: { op: 'update', summary: 'Updated node' },
    };
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withObjectProto(
      'events',
      {
        enumerable: true,
        get() {
          fired += 1;
          return events;
        },
      },
      () => {
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(fired).toBe(0);
    expect(result).toEqual(FIXED_UNKNOWN);
  });

  it('event with own exact {id, op} + inherited undoable DATA → undoable stays ABSENT, result normal', () => {
    const envelope = {
      kind: 'write-result',
      data: { op: 'update', summary: 'Updated node', events: [VALID_EVENT] },
    };
    let result: WriteResultProjection | undefined;
    withObjectProto('undoable', { value: true, writable: true, enumerable: true }, () => {
      result = projectWriteResult(envelope, 'update_rule');
    });
    expect(result?.outcome).toBe('ok');
    expect(result?.uiEnvelope).toEqual({
      kind: 'write-result',
      data: { op: 'update', summary: 'Updated node', events: [{ id: 'e-1', op: 'update' }] },
    });
    expect(result?.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
  });

  it('event with own exact {id, op} + inherited undoable GETTER → undoable stays ABSENT, getter fires ZERO times', () => {
    const envelope = {
      kind: 'write-result',
      data: { op: 'update', summary: 'Updated node', events: [VALID_EVENT] },
    };
    let fired = 0;
    let result: WriteResultProjection | undefined;
    withObjectProto(
      'undoable',
      {
        enumerable: true,
        get() {
          fired += 1;
          return true;
        },
      },
      () => {
        result = projectWriteResult(envelope, 'update_rule');
      },
    );
    expect(fired).toBe(0);
    expect(result?.outcome).toBe('ok');
    expect(result?.uiEnvelope).toEqual({
      kind: 'write-result',
      data: { op: 'update', summary: 'Updated node', events: [{ id: 'e-1', op: 'update' }] },
    });
  });

  it('own undoable true/false are preserved exactly', () => {
    const projectionTrue = projectWriteResult(
      {
        kind: 'write-result',
        data: {
          op: 'update',
          summary: 'Updated node',
          events: [{ id: 'e-1', op: 'update', undoable: true }],
        },
      },
      'update_rule',
    );
    expect(projectionTrue.outcome).toBe('ok');
    expect(projectionTrue.uiEnvelope?.data.events).toEqual([
      { id: 'e-1', op: 'update', undoable: true },
    ]);
    const projectionFalse = projectWriteResult(
      {
        kind: 'write-result',
        data: {
          op: 'update',
          summary: 'Updated node',
          events: [{ id: 'e-1', op: 'update', undoable: false }],
        },
      },
      'update_rule',
    );
    expect(projectionFalse.outcome).toBe('ok');
    expect(projectionFalse.uiEnvelope?.data.events).toEqual([
      { id: 'e-1', op: 'update', undoable: false },
    ]);
  });
});

describe('round-9: Object.prototype.toJSON and Array.prototype.toJSON shadowing', () => {
  /** Temporarily define a prototype property, restoring the exact prior descriptor. */
  function withProto<T>(
    target: object,
    key: string,
    descriptor: PropertyDescriptor,
    fn: () => T,
  ): T {
    const prior = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
    try {
      return fn();
    } finally {
      if (prior === undefined) {
        delete (target as Record<string, unknown>)[key];
      } else {
        Object.defineProperty(target, key, prior);
      }
    }
  }

  const ENVELOPE = {
    kind: 'write-result',
    data: { op: 'update', summary: 'Updated node', events: [] },
  };

  it('Object.prototype.toJSON DATA function: zero observation, modelContent unchanged', () => {
    let fired = 0;
    const result = withProto(
      Object.prototype,
      'toJSON',
      {
        value() {
          fired++;
          return { hijacked: true };
        },
        writable: true,
        enumerable: false,
        configurable: true,
      },
      () => projectWriteResult(ENVELOPE, 'update_rule'),
    );
    expect(fired).toBe(0);
    expect(result.outcome).toBe('ok');
    expect(result.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
  });

  it('Object.prototype.toJSON GETTER: zero fires, modelContent unchanged', () => {
    let fired = 0;
    const result = withProto(
      Object.prototype,
      'toJSON',
      {
        get() {
          fired++;
          return () => ({ hijacked: true });
        },
        enumerable: false,
        configurable: true,
      },
      () => projectWriteResult(ENVELOPE, 'update_rule'),
    );
    expect(fired).toBe(0);
    expect(result.outcome).toBe('ok');
    expect(result.modelContent).toBe(
      '{"status":"success","action":"update_rule","summary":"Updated node"}',
    );
  });

  it('Array.prototype.toJSON DATA function: zero fires and the projected events array shadows toJSON non-enumerably', () => {
    let fired = 0;
    const evEnvelope = {
      kind: 'write-result',
      data: {
        op: 'update',
        summary: 'Updated node',
        events: [{ id: 'e-1', op: 'update' }],
      },
    };
    const result = withProto(
      Array.prototype,
      'toJSON',
      {
        value() {
          fired++;
          return [];
        },
        writable: true,
        enumerable: false,
        configurable: true,
      },
      () => projectWriteResult(evEnvelope, 'update_rule'),
    );
    expect(fired).toBe(0);
    expect(result.outcome).toBe('ok');
    expect(result.uiEnvelope?.data.events).toEqual([{ id: 'e-1', op: 'update' }]);
    const events = result.uiEnvelope!.data.events;
    const descriptor = Object.getOwnPropertyDescriptor(events, 'toJSON');
    expect(descriptor).toBeDefined();
    expect(descriptor?.value).toBeUndefined();
    expect(descriptor?.enumerable).toBe(false);
    expect(Object.hasOwn(descriptor as object, 'get')).toBe(false);
    expect(Object.hasOwn(descriptor as object, 'set')).toBe(false);
    expect(Object.keys(events)).toEqual(['0']);
  });

  it('responseContent contains ui summary identical to modelContent summary', () => {
    const result = projectWriteResult(ENVELOPE, 'update_rule');
    expect(result.outcome).toBe('ok');
    const uiSummary = result.uiEnvelope?.data.summary;
    const modelParsed = JSON.parse(result.modelContent!);
    expect(uiSummary).toBe(modelParsed.summary);
    // responseContent parses correctly
    const respParsed = JSON.parse(result.responseContent!);
    expect(respParsed.data.kind).toBe('write-result');
    expect(respParsed.data.data.op).toBe('update');
    expect(respParsed.data.data.summary).toBe(uiSummary);
    expect(respParsed.data.modelContent).toBe(result.modelContent);
  });
});

describe('round-9: descriptor get/set zero-observation', () => {
  it('inherited Object.prototype.get descriptor metadata: zero observation, result ok', () => {
    let fired = 0;
    const result = (() => {
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'get');
      Object.defineProperty(Object.prototype, 'get', {
        configurable: true,
        get() {
          fired++;
          return () => 'hijacked';
        },
      });
      try {
        return projectWriteResult(
          { kind: 'write-result', data: { op: 'update', summary: 'ok', events: [] } },
          'update_rule',
        );
      } finally {
        if (prior === undefined) {
          delete (Object.prototype as Record<string, unknown>).get;
        } else {
          Object.defineProperty(Object.prototype, 'get', prior);
        }
      }
    })();
    expect(fired).toBe(0);
    expect(result.outcome).toBe('ok');
  });

  it('inherited Object.prototype.set descriptor metadata: zero observation', () => {
    let fired = 0;
    const result = (() => {
      const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'set');
      Object.defineProperty(Object.prototype, 'set', {
        configurable: true,
        get() {
          fired++;
          return () => {};
        },
      });
      try {
        return projectWriteResult(
          { kind: 'write-result', data: { op: 'update', summary: 'ok', events: [] } },
          'update_rule',
        );
      } finally {
        if (prior === undefined) {
          delete (Object.prototype as Record<string, unknown>).set;
        } else {
          Object.defineProperty(Object.prototype, 'set', prior);
        }
      }
    })();
    expect(fired).toBe(0);
    expect(result.outcome).toBe('ok');
  });
});
