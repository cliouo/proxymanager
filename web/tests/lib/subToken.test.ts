import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveSubToken, requireSubToken } from '@/lib/auth';

/**
 * P1-3: subscription tokens can now be master, resource-derived, or rotated.
 */

const MASTER = 'master-token-abcdefghijklmnop';
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
    expect(() => requireSubToken(MASTER, 'profile-a')).not.toThrow();
  });

  it('accepts a resource-derived token only for its own resource', () => {
    const forA = deriveSubToken('profile-a');
    expect(() => requireSubToken(forA, 'profile-a')).not.toThrow();
    // The same derived token must NOT unlock a different resource.
    expect(() => requireSubToken(forA, 'profile-b')).toThrow();
    // …and is not accepted where no resource scope is checked.
    expect(() => requireSubToken(forA)).toThrow();
  });

  it('deriveSubToken matches HMAC-SHA256(master, resource)', () => {
    const expected = createHmac('sha256', MASTER).update('profile-a').digest('hex');
    expect(deriveSubToken('profile-a')).toBe(expected);
    expect(deriveSubToken('profile-a')).not.toBe(deriveSubToken('profile-b'));
  });

  it('rejects an unrelated token', () => {
    expect(() => requireSubToken('nope', 'profile-a')).toThrow();
  });

  it('supports rotation via SUB_TOKEN_PREV (old master + old derived still valid)', () => {
    process.env.SUB_TOKEN_PREV = PREV;
    expect(() => requireSubToken(PREV)).not.toThrow();
    const prevDerived = deriveSubToken('profile-a', PREV);
    expect(() => requireSubToken(prevDerived, 'profile-a')).not.toThrow();
    // New master still works during the overlap.
    expect(() => requireSubToken(MASTER)).not.toThrow();
  });

  it('stops accepting the previous token once SUB_TOKEN_PREV is removed', () => {
    // PREV not set in this test → old token rejected.
    expect(() => requireSubToken(PREV)).toThrow();
  });
});
