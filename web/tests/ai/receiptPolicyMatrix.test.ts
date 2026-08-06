/**
 * Independent literal-oracle receipt matrix (19 categories, 588 cases).
 *
 * The cases + expected values come from
 * plugin/servers/testdata/receipt-security-matrix.json — a LITERAL oracle
 * authored from the receipt policy spec, never computed with a production
 * sanitizer. This suite asserts, for every case:
 *   - the Web producer (projectWriteResult) matches the literal oracle
 *     outcome and exact canonical op/summary bytes;
 *   - the committed MCP bundle verifier rejects every raw summary the Web
 *     would change or reject (mcpRawReject), and accepts the exact canonical
 *     Web receipt byte-for-byte;
 *   - the Web-change-or-reject ⇒ MCP-reject relation holds 588/588.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectWriteResult } from '@/lib/ai/writeResultProjection';

const MATRIX = JSON.parse(
  readFileSync(
    new URL('../../../plugin/servers/testdata/receipt-security-matrix.json', import.meta.url),
    'utf8',
  ),
) as {
  version: number;
  cases: Array<{
    id: string;
    category: string;
    op: string;
    summary: string;
    web: 'ok' | 'unknown';
    canonicalOp?: string;
    canonicalSummary?: string;
    mcpRawReject: boolean;
  }>;
};

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
    ) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
    expectedAction?: string,
  ) => Promise<BundleConfirmResult>;
}

const ACTION = 'update_rule';
const fakeConfirmResponse = (modelContent: unknown) => async () => ({
  ok: true,
  json: async () => ({
    data: {
      kind: 'write-result',
      data: { op: 'update', summary: 'ok', events: [] },
      modelContent,
    },
  }),
});

describe('588-case receipt matrix — Web literal oracle', () => {
  it('has the exact 19 categories and 588 cases', () => {
    const counts: Record<string, number> = {};
    for (const c of MATRIX.cases) counts[c.category] = (counts[c.category] ?? 0) + 1;
    expect(counts).toEqual({
      'auth-length': 81,
      'sk-length': 9,
      endpoint: 16,
      jwt: 4,
      'uuid-hex': 4,
      opaque: 4,
      placeholder: 8,
      'bare-key': 28,
      'key-value': 280,
      'scheme-delim': 26,
      'scheme-delim-mixed': 26,
      'key-prefix-delim': 26,
      'nfkc-zero-width': 8,
      composition: 27,
      multiple: 7,
      residue: 15,
      safe: 15,
      'raw-bound': 2,
      'canonical-bound': 2,
    });
    expect(MATRIX.cases).toHaveLength(588);
  });

  it('Web producer matches the literal oracle 588/588 (outcome + exact canonical bytes)', () => {
    for (const c of MATRIX.cases) {
      const result = projectWriteResult(
        { kind: 'write-result', data: { op: c.op, summary: c.summary, events: [] } },
        ACTION,
      );
      expect(
        result.outcome,
        `${c.id} ${c.category} op=${JSON.stringify(c.op)} summary=${JSON.stringify(c.summary)}`,
      ).toBe(c.web);
      if (c.web === 'ok') {
        expect(result.uiEnvelope?.data.op, `${c.id} canonicalOp`).toBe(c.canonicalOp);
        expect(result.uiEnvelope?.data.summary, `${c.id} canonicalSummary`).toBe(
          c.canonicalSummary,
        );
        const model = JSON.parse(result.modelContent as string) as { summary: string };
        expect(model.summary, `${c.id} modelSummary`).toBe(c.canonicalSummary);
      } else {
        expect(result.uiEnvelope).toBeNull();
        expect(result.modelContent).toBeNull();
      }
    }
  });

  it('the 15 safe controls survive byte-identically', () => {
    const safe = MATRIX.cases.filter((c) => c.category === 'safe');
    expect(safe).toHaveLength(15);
    for (const c of safe) {
      expect(c.web).toBe('ok');
      expect(c.canonicalSummary).toBe(c.summary);
      expect(c.canonicalOp).toBe('update');
      expect(c.mcpRawReject).toBe(false);
    }
  });
});

describe('588-case receipt matrix — committed MCP bundle verifier', () => {
  let bundle: McpBundle;
  it('loads the committed bundle', async () => {
    bundle = (await import(
      /* @vite-ignore */ new URL(
        '../../../plugin/servers/dist/proxymanager-mcp.bundle.mjs',
        import.meta.url,
      ).href
    )) as unknown as McpBundle;
    expect(typeof bundle.confirmHiddenWrite).toBe('function');
  });

  it('rejects every raw summary Web changes or rejects, and accepts the exact canonical Web receipt (588/588 relation)', async () => {
    for (const c of MATRIX.cases) {
      // relation invariant encoded in the literal oracle
      const relation = c.mcpRawReject === (c.web !== 'ok' || c.canonicalSummary !== c.summary);
      expect(relation, `${c.id} relation data inconsistency`).toBe(true);

      // raw forged form: must be rejected iff mcpRawReject
      const rawResult = await bundle.confirmHiddenWrite(
        'a'.repeat(36),
        fakeConfirmResponse(
          JSON.stringify({ status: 'success', action: ACTION, summary: c.summary }),
        ),
        ACTION,
      );
      expect(Boolean(rawResult.isError), `${c.id} raw mcpReject=${c.mcpRawReject}`).toBe(
        c.mcpRawReject,
      );

      // canonical Web receipt: every web-ok case must pass unchanged
      if (c.web === 'ok') {
        const canonical = JSON.stringify({
          status: 'success',
          action: ACTION,
          summary: c.canonicalSummary,
        });
        const okResult = await bundle.confirmHiddenWrite(
          'a'.repeat(36),
          fakeConfirmResponse(canonical),
          ACTION,
        );
        expect(okResult.isError, `${c.id} canonical accept`).toBeUndefined();
        expect(okResult.content[0].text, `${c.id} canonical echo`).toBe(canonical);
      }
    }
  });
});
