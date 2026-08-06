/**
 * Keyed opaque-handle MAC primitives (round-3 Decision 4).
 *
 * This module owns ONLY the low-level cryptographic lifecycle:
 *   - the server handle MAC secret (env, minimum length, fail-closed
 *     HandleSecretError);
 *   - the HandleSigner interface and `handleSigner()` — the SINGLE funnel
 *     through which the secret enters key material;
 *   - the test DI seams (injectHandleSecret / injectHandleSignerForTests /
 *     resetHandleSecret).
 *
 * It does NOT export any prefixed semantic token constructor (no
 * HANDLE_DOMAINS, no domainHandle): the typed scope builders in
 * `handleScopes.ts` are the SOLE semantic token constructors — they compose
 * the compatibility prefix with `signer.mac` while building complete
 * collision-checked identity maps. No production module may mint a semantic
 * ref/op/src/nd token without a complete scope.
 *
 * The secret is NEVER serialized, logged, persisted or returned — it only
 * ever enters HMAC key material.
 */

import { createHmac } from 'node:crypto';

/** Env var holding the server-side handle MAC secret. */
export const HANDLE_SECRET_ENV = 'NODE_HANDLE_SECRET';

/** Minimum production secret length (bytes, not chars) — a weaker value is
 * a configuration error, never a silently weak MAC (pass-5 blocker). */
export const MIN_HANDLE_SECRET_BYTES = 32;

/**
 * Typed configuration failure with a STABLE internal code and a GENERIC
 * bounded external message — no env name, no stack, no key material can
 * ever surface to clients through this error.
 */
export class HandleSecretError extends Error {
  constructor(public code: 'HANDLE_SECRET_MISSING' | 'HANDLE_SECRET_WEAK') {
    super('Handle secret is not configured.');
    this.name = 'HandleSecretError';
  }
}

export interface HandleSigner {
  /** Domain-separated 16-hex MAC of `text` (bounded, deterministic). */
  mac(domain: string, text: string): string;
}

export function createHandleSigner(secret: string): HandleSigner {
  return {
    mac(domain, text) {
      return createHmac('sha256', secret).update(`${domain}\x00${text}`).digest('hex').slice(0, 16);
    },
  };
}

/** Test-only DI seam: pin a stable explicit key (never a real secret). */
let injectedSecret: string | null = null;
/** Test-only signer override — lets tests force deterministic MAC collisions
 * (e.g. two targets sharing one ref) without weakening the production MAC. */
let injectedSigner: HandleSigner | null = null;

export function injectHandleSecret(secret: string): void {
  injectedSecret = secret;
  injectedSigner = null;
}

export function injectHandleSignerForTests(signer: HandleSigner | null): void {
  injectedSigner = signer;
}

export function resetHandleSecret(): void {
  injectedSecret = null;
  injectedSigner = null;
}

/**
 * The signer every handle-producing call uses: the injected test key when
 * present, else the server secret read lazily (fail closed). All reads of
 * the secret funnel through here — no pure function touches process.env.
 */
export function handleSigner(): HandleSigner {
  if (injectedSigner !== null) return injectedSigner;
  if (injectedSecret !== null) return createHandleSigner(injectedSecret);
  const value = process.env[HANDLE_SECRET_ENV];
  if (!value) {
    throw new HandleSecretError('HANDLE_SECRET_MISSING');
  }
  if (Buffer.byteLength(value, 'utf8') < MIN_HANDLE_SECRET_BYTES) {
    throw new HandleSecretError('HANDLE_SECRET_WEAK');
  }
  return createHandleSigner(value);
}
