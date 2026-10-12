import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProblemDetailsError } from './http/problem';

function readSecret(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw ProblemDetailsError.internal(
      `Server misconfigured: missing ${name} environment variable.`,
    );
  }
  return value;
}

export function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Versioned capability identity. Names never confer authority. */
export interface SubTokenResource {
  type: 'profile' | 'subscription' | 'collection' | 'rule-set';
  id: string;
  tokenVersion?: number;
}

export function deriveSubToken(
  resource: SubTokenResource,
  master = readSecret('SUB_TOKEN'),
): string {
  const identity = JSON.stringify([
    'pm-sub',
    2,
    resource.type,
    resource.id,
    resource.tokenVersion ?? 1,
  ]);
  return createHmac('sha256', master).update(identity).digest('hex');
}

export function requireAdminBearer(request: Request): void {
  const adminKey = readSecret('ADMIN_KEY');
  const authHeader = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !safeEqual(match[1], adminKey)) {
    throw ProblemDetailsError.unauthorized(
      'Valid `Authorization: Bearer <ADMIN_KEY>` header is required.',
    );
  }
}

/**
 * Validate a subscription token. Accepts, in order of increasing scope:
 *   - the master `SUB_TOKEN` (works for every resource — legacy links);
 *   - a resource-derived token (only when `resource` is given), so a per-
 *     resource link can be handed out without exposing the rest (P1-3);
 *   - the previous master `SUB_TOKEN_PREV` (and its derived form), if set, to
 *     support zero-downtime token ROTATION: set PREV=old, SUB_TOKEN=new, deploy,
 *     let clients refresh, then drop PREV. This makes the token revocable — the
 *     gap the original single static token never had.
 */
export function requireSubToken(suppliedToken: string, resource?: SubTokenResource): void {
  const master = readSecret('SUB_TOKEN');
  const prev = process.env.SUB_TOKEN_PREV || null;

  const candidates = [master];
  if (resource) candidates.push(deriveSubToken(resource, master));
  if (prev) {
    candidates.push(prev);
    if (resource) candidates.push(deriveSubToken(resource, prev));
  }

  // Compare against every candidate (each comparison is constant-time).
  if (!candidates.some((c) => safeEqual(suppliedToken, c))) {
    throw ProblemDetailsError.unauthorized('Invalid subscription token.');
  }
}
