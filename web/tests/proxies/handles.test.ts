/**
 * Keyed opaque-handle service tests (pass-3 finding, round-3 Decision 4):
 * the tokens are HMAC-SHA256 MACs under an injected server secret —
 * deterministic under the same key, domain-separated per PURPOSE, bounded,
 * and NOT reproducible from raw unsalted SHA-1 or a candidate dictionary.
 *
 * Round-3: handles.ts exports ONLY the low-level secret lifecycle and
 * HandleSigner; the typed scope builders in handleScopes.ts are the SOLE
 * semantic token constructors. These tests therefore project every token
 * through a complete one-identity scope and keep the low-level determinism /
 * secret-lifecycle coverage on the signer itself.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  HandleSecretError,
  createHandleSigner,
  handleSigner,
  injectHandleSecret,
  resetHandleSecret,
} from '@/lib/proxies/handles';
import {
  buildNodeScope,
  buildOperatorScope,
  buildSourceAliasScope,
  buildTargetRefScope,
} from '@/lib/proxies/handleScopes';
import { installTestHandleSecret } from '../helpers/handleSecret';

beforeAll(() => {
  installTestHandleSecret();
});

afterEach(() => {
  resetHandleSecret();
  installTestHandleSecret();
});

describe('keyed handle service (pass-3 finding)', () => {
  it('deterministic under the same injected key; different across keys', () => {
    const scope = () => buildSourceAliasScope(['airport-a']);
    const a = scope().project('airport-a');
    const b = scope().project('airport-a');
    expect(a).toBe(b);
    // a different signer yields a different token under the same scope
    const otherSigner = createHandleSigner('a-different-key');
    expect(buildSourceAliasScope(['airport-a'], otherSigner).project('airport-a')).not.toBe(a);
  });

  it('purpose-separated: identical text under different semantic scopes yields different tokens', () => {
    const text = '香港 01';
    const nodeToken = buildNodeScope('', [text]).project(text);
    const sourceToken = buildSourceAliasScope([text]).project(text);
    const opToken = buildOperatorScope([text]).project(text);
    expect(nodeToken).toMatch(/^nd-[0-9a-f]{16}$/);
    expect(sourceToken).toMatch(/^src-[0-9a-f]{16}$/);
    expect(opToken).toMatch(/^op-[0-9a-f]{16}$/);
    expect(new Set([nodeToken, sourceToken, opToken]).size).toBe(3);
    // the ref purpose composes the same prefix shape with its own MAC domain
    const refToken = buildTargetRefScope('p', [{ type: 'subscription', id: text }]).project(
      `subscription:${text}`,
    );
    expect(refToken).toMatch(/^ref-[0-9a-f]{16}$/);
    expect(refToken).not.toBe(nodeToken);
  });

  it('bounded 16-hex tokens, never the raw text, never raw SHA-1', () => {
    const text = 'airport-a';
    const token = buildSourceAliasScope(['airport-a']).project('airport-a');
    expect(token).toMatch(/^src-[0-9a-f]{16}$/);
    expect(token).not.toContain(text);
    // the pass-3 vulnerability: raw unsalted SHA-1 could reproduce the old
    // token from a guessed slug — the MAC must not equal any public digest
    const sha1 = createHash('sha1').update(text).digest('hex').slice(0, 16);
    const sha256 = createHash('sha256').update(text).digest('hex').slice(0, 16);
    expect(token).not.toBe(`src-${sha1}`);
    expect(token).not.toBe(`src-${sha256}`);
    // and a candidate dictionary of common slugs cannot match either
    for (const candidate of ['airport-a', 'member-0', '香港 01', 'BenignUniqueNodeName']) {
      expect(buildSourceAliasScope([candidate]).project(candidate)).not.toBe(
        'src-f86fee1ca565c090',
      );
    }
  });

  it('round-trips through a complete node scope under the SAME injected key', () => {
    // namingActions node projections and inspect_node_parse resolve through
    // the same scope construction — the injected test key keeps them
    // consistent
    const nodeScope = () => buildNodeScope('', ['香港 01\x00fp-1\x000']);
    const h1 = nodeScope().project('香港 01\x00fp-1\x000');
    const h2 = nodeScope().project('香港 01\x00fp-1\x000');
    expect(h1).toMatch(/^nd-[0-9a-f]{16}$/);
    expect(h1).toBe(h2); // exact round-trip determinism
    // fingerprint separates; occurrence separates
    expect(buildNodeScope('', ['香港 01\x00fp-2\x000']).project('香港 01\x00fp-2\x000')).not.toBe(
      h1,
    );
    expect(buildNodeScope('', ['香港 01\x00fp-1\x001']).project('香港 01\x00fp-1\x001')).not.toBe(
      h1,
    );
    // a DIFFERENT key yields a different handle — no cross-deployment reuse
    const other = createHandleSigner('another-key');
    expect(
      buildNodeScope('', ['香港 01\x00fp-1\x000'], other).project('香港 01\x00fp-1\x000'),
    ).not.toBe(h1);
  });

  it('low-level signer MAC stays deterministic and domain-separated', () => {
    const signer = handleSigner();
    expect(signer.mac('node', 'x')).toBe(signer.mac('node', 'x'));
    expect(signer.mac('node', 'x')).not.toBe(signer.mac('source', 'x'));
    expect(signer.mac('node', 'x').length).toBe(16);
  });

  it('fail-closed production behavior: missing secret throws the typed HandleSecretError (no env name in the message)', () => {
    resetHandleSecret();
    const previous = process.env.NODE_HANDLE_SECRET;
    delete process.env.NODE_HANDLE_SECRET;
    try {
      try {
        buildSourceAliasScope(['x']).project('x');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HandleSecretError);
        expect((error as HandleSecretError).code).toBe('HANDLE_SECRET_MISSING');
        expect((error as Error).message).not.toContain('NODE_HANDLE_SECRET');
      }
    } finally {
      if (previous !== undefined) process.env.NODE_HANDLE_SECRET = previous;
      installTestHandleSecret();
    }
  });

  it('pass-5: a WEAK production secret (fewer than 32 bytes) fails closed with HANDLE_SECRET_WEAK', () => {
    resetHandleSecret();
    const previous = process.env.NODE_HANDLE_SECRET;
    process.env.NODE_HANDLE_SECRET = 'x';
    try {
      try {
        buildSourceAliasScope(['x']).project('x');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(HandleSecretError);
        expect((error as HandleSecretError).code).toBe('HANDLE_SECRET_WEAK');
        expect((error as Error).message).not.toContain('NODE_HANDLE_SECRET');
      }
    } finally {
      if (previous !== undefined) process.env.NODE_HANDLE_SECRET = previous;
      installTestHandleSecret();
    }
  });

  it('injectHandleSecret pins the same deterministic key as installTestHandleSecret', () => {
    resetHandleSecret();
    injectHandleSecret('test-only-handle-secret-0000000000000000');
    const viaInject = buildSourceAliasScope(['airport-a']).project('airport-a');
    resetHandleSecret();
    installTestHandleSecret();
    const viaInstall = buildSourceAliasScope(['airport-a']).project('airport-a');
    expect(viaInject).toBe(viaInstall);
  });
});
