import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveSubToken, requireSubToken } from '@/lib/auth';

/**
 * P1-3: subscription tokens can now be master, resource-derived, or rotated.
 */

const MASTER = 'master-token-abcdefghijklmnop';
const A = { type: 'profile' as const, id: 'profile-a' };
const B = { type: 'profile' as const, id: 'profile-b' };
const PREV = 'previous-token-qrstuvwxyz0123';

let savedToken: string | undefined;
let savedPrev: string | undefined;

beforeEach(() => {
  savedToken = process.env.SUB_TOKEN;
  savedPrev = process.env.SUB_TOKEN_PREV;
  process.env.SUB_TOKEN = MASTER;
  delete process.env.SUB_TOKEN_PREV;
});

afterEach(() => {
  if (savedToken === undefined) delete process.env.SUB_TOKEN;
  else process.env.SUB_TOKEN = savedToken;
  if (savedPrev === undefined) delete process.env.SUB_TOKEN_PREV;
  else process.env.SUB_TOKEN_PREV = savedPrev;
});

describe('requireSubToken (P1-3)', () => {
  it('accepts the master token for any resource', () => {
    expect(() => requireSubToken(MASTER)).not.toThrow();
    expect(() => requireSubToken(MASTER, A)).not.toThrow();
  });

  it('accepts a resource-derived token only for its own resource', () => {
    const forA = deriveSubToken(A);
    expect(() => requireSubToken(forA, A)).not.toThrow();
    // The same derived token must NOT unlock a different resource.
    expect(() => requireSubToken(forA, B)).toThrow();
    // …and is not accepted where no resource scope is checked.
    expect(() => requireSubToken(forA)).toThrow();
  });

  it('deriveSubToken matches HMAC-SHA256(master, resource)', () => {
    const expected = createHmac('sha256', MASTER)
      .update(JSON.stringify(['pm-sub', 2, 'profile', A.id, 1]))
      .digest('hex');
    expect(deriveSubToken(A)).toBe(expected);
    expect(deriveSubToken(A)).not.toBe(deriveSubToken(B));
  });

  it('rejects an unrelated token', () => {
    expect(() => requireSubToken('nope', A)).toThrow();
  });

  it('supports rotation via SUB_TOKEN_PREV (old master + old derived still valid)', () => {
    process.env.SUB_TOKEN_PREV = PREV;
    expect(() => requireSubToken(PREV)).not.toThrow();
    const prevDerived = deriveSubToken(A, PREV);
    expect(() => requireSubToken(prevDerived, A)).not.toThrow();
    // New master still works during the overlap.
    expect(() => requireSubToken(MASTER)).not.toThrow();
  });

  it('stops accepting the previous token once SUB_TOKEN_PREV is removed', () => {
    // PREV not set in this test → old token rejected.
    expect(() => requireSubToken(PREV)).toThrow();
  });
});

it('separates resource kinds, incarnations and token revisions; rejects bare-name legacy tokens', () => {
  const token = deriveSubToken(A);
  expect(() => requireSubToken(token, { ...A, type: 'subscription' })).toThrow();
  expect(() => requireSubToken(token, { ...A, id: 'new-id' })).toThrow();
  expect(() => requireSubToken(token, { ...A, tokenVersion: 2 })).toThrow();
  const legacy = createHmac('sha256', MASTER).update(A.id).digest('hex');
  expect(() => requireSubToken(legacy, A)).toThrow();
});
