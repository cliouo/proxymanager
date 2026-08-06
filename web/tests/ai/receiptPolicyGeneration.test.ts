/**
 * Receipt policy generation contract:
 *   - the two generated modules (web TS + plugin MJS) are byte-identical to
 *     a fresh in-memory regeneration from the manual spec — `--check` must
 *     exit 0 WITHOUT writing;
 *   - both embed the same policy version and hash;
 *   - the Web and MCP scanners expose the shared canonicalization API and
 *     behave identically on the safe controls + a hostile sample.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RECEIPT_OP_RAW_MAX,
  RECEIPT_POLICY_HASH,
  RECEIPT_POLICY_VERSION,
  RECEIPT_SUMMARY_RAW_MAX,
  canonicalizeReceiptText,
  isCanonicalReceiptSummary,
} from '@/lib/ai/receiptPolicy.generated';

const GEN = new URL('../../scripts/generate-receipt-policy.mjs', import.meta.url);
const SPEC = new URL('../../scripts/receipt-policy-spec.mjs', import.meta.url);
const WEB_GENERATED = new URL('../../lib/ai/receiptPolicy.generated.ts', import.meta.url);
const MCP_GENERATED = new URL(
  '../../../plugin/servers/receipt-policy.generated.mjs',
  import.meta.url,
);

/** The manual spec's declared version, read from its source (no .mjs type
 * declaration exists for the spec module). */
const SPEC_VERSION = Number(/RECEIPT_POLICY_VERSION = (\d+)/.exec(readFileSync(SPEC, 'utf8'))?.[1]);

describe('receipt policy generation', () => {
  it('--check regenerates both outputs in memory, compares bytes, and exits 0 without writing', () => {
    const beforeWeb = readFileSync(WEB_GENERATED, 'utf8');
    const beforeMcp = readFileSync(MCP_GENERATED, 'utf8');
    const out = execFileSync(process.execPath, [fileURLToPath(GEN), '--check'], {
      encoding: 'utf8',
    });
    expect(out).toMatch(/receipt policy fresh/);
    // --check must not write: both files byte-identical after the run
    expect(readFileSync(WEB_GENERATED, 'utf8')).toBe(beforeWeb);
    expect(readFileSync(MCP_GENERATED, 'utf8')).toBe(beforeMcp);
  });

  it('both generated modules embed the same spec version and the exact policy hash (format-agnostic)', () => {
    expect(RECEIPT_POLICY_VERSION).toBe(SPEC_VERSION);
    expect(RECEIPT_POLICY_HASH).toMatch(/^[0-9a-f]{64}$/);
    // The emitted literal is per-language formatted (web/.prettierrc single
    // quotes vs default-config double quotes, line wrapping by printWidth),
    // so the assertion checks the embedded VALUES in both modules — never
    // the byte layout of the declaration.
    const mcpSource = readFileSync(MCP_GENERATED, 'utf8');
    const webSource = readFileSync(WEB_GENERATED, 'utf8');
    for (const source of [webSource, mcpSource]) {
      expect(source).toContain(`RECEIPT_POLICY_VERSION = ${RECEIPT_POLICY_VERSION}`);
      expect(source).toContain(`RECEIPT_POLICY_HASH`);
      expect(source).toContain(RECEIPT_POLICY_HASH);
    }
    // the Web module carries the same bounds the MCP verifier enforces
    expect(RECEIPT_OP_RAW_MAX).toBe(256);
    expect(RECEIPT_SUMMARY_RAW_MAX).toBe(2048);
  });

  it('the generated scanner preserves the safe controls and redacts hostile spans (same semantics as the MCP module)', async () => {
    const mcp = (await import(/* @vite-ignore */ MCP_GENERATED.href)) as unknown as {
      canonicalizeReceiptText: (
        raw: unknown,
        rawBound: number,
        opContext?: boolean,
      ) => string | null;
      isCanonicalReceiptSummary: (summary: unknown) => boolean;
    };
    const safe = [
      'Updated node',
      'Updated token refresh',
      'Basic plan enabled',
      'Bearer service updated',
      'Version 1:2 unchanged',
    ];
    for (const s of safe) {
      expect(canonicalizeReceiptText(s, 2048), `web ${s}`).toBe(s);
      expect(mcp.canonicalizeReceiptText(s, 2048), `mcp ${s}`).toBe(s);
      expect(isCanonicalReceiptSummary(s)).toBe(true);
      expect(mcp.isCanonicalReceiptSummary(s)).toBe(true);
    }
    const hostile = [
      'Bearer abc',
      'sk-FAKE',
      'token=FAKE_PLACEHOLDER',
      'Updated node Bearer abc',
      'Ｂｅａｒｅｒ abc',
    ];
    for (const h of hostile) {
      expect(canonicalizeReceiptText(h, 2048), `web ${h}`).toBe(
        mcp.canonicalizeReceiptText(h, 2048),
      );
      expect(isCanonicalReceiptSummary(h)).toBe(false);
      expect(mcp.isCanonicalReceiptSummary(h)).toBe(false);
    }
  });
});
