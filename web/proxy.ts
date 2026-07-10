import { NextResponse, type NextRequest } from 'next/server';
import { safeEqual } from '@/lib/auth';
import { problemResponse } from '@/lib/http/problem';
import { clientIp, registerAuthFailure } from '@/lib/rateLimit';

const PUBLIC_API_PATHS = new Set(['/api/v1/health', '/api/v1/openapi.json']);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
  'Access-Control-Expose-Headers': 'ETag, X-Build-Id, Location',
  'Access-Control-Max-Age': '86400',
};

function applyCors(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function corsPreflight(): NextResponse {
  const response = new NextResponse(null, { status: 204 });
  return applyCors(response);
}

function unauthorized(detail: string): NextResponse {
  const response = problemResponse({
    type: 'https://proxymanager.dev/errors/unauthorized',
    title: 'Unauthorized',
    status: 401,
    detail,
  });
  const nextResponse = new NextResponse(response.body, {
    status: response.status,
    headers: response.headers,
  });
  return applyCors(nextResponse);
}

function tooManyRequests(): NextResponse {
  const response = problemResponse({
    type: 'https://proxymanager.dev/errors/rate-limited',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Too many failed authentication attempts. Try again later.',
  });
  const nextResponse = new NextResponse(response.body, {
    status: response.status,
    headers: response.headers,
  });
  nextResponse.headers.set('Retry-After', '300');
  return applyCors(nextResponse);
}

function misconfigured(): NextResponse {
  const response = problemResponse({
    type: 'https://proxymanager.dev/errors/internal',
    title: 'Internal Server Error',
    status: 500,
    detail: 'Server misconfigured: ADMIN_KEY environment variable is not set.',
  });
  const nextResponse = new NextResponse(response.body, {
    status: response.status,
    headers: response.headers,
  });
  return applyCors(nextResponse);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.method === 'OPTIONS') {
    return corsPreflight();
  }

  const { pathname } = request.nextUrl;

  if (PUBLIC_API_PATHS.has(pathname)) {
    return applyCors(NextResponse.next());
  }

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return misconfigured();
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !safeEqual(match[1], adminKey)) {
    // P1-2: throttle brute-force. Only failed attempts touch Redis; a valid key
    // never pays the round-trip. Fail-open on limiter error (returns 401).
    const blocked = await registerAuthFailure('admin', clientIp(request));
    if (blocked) return tooManyRequests();
    return unauthorized('Valid `Authorization: Bearer <ADMIN_KEY>` header is required.');
  }

  return applyCors(NextResponse.next());
}

export const config = {
  matcher: ['/api/v1/:path*'],
};
