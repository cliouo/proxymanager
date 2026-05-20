import { timingSafeEqual } from 'node:crypto';
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

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
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

export function requireSubToken(suppliedToken: string): void {
  const expected = readSecret('SUB_TOKEN');
  if (!safeEqual(suppliedToken, expected)) {
    throw ProblemDetailsError.unauthorized('Invalid subscription token.');
  }
}
