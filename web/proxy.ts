import { NextResponse, type NextRequest } from 'next/server';
import { safeEqual } from '@/lib/auth';
import { problemResponse } from '@/lib/http/problem';
import { clientIp, registerAuthFailure } from '@/lib/rateLimit';

const PUBLIC_API_PATHS: Record<string, true> = {
  '/api/v1/health': true,
  '/api/v1/openapi.json': true,
};
const NO_STORE_API_PATH = /^\/api\/v1\/subscriptions\/[^/]+\/(?:local-fetch-spec|manual-refresh)$/;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, If-Match, X-Fetch-Identity-Revision, X-Source',
  'Access-Control-Expose-Headers': 'ETag, X-Build-Id, Location',
  'Access-Control-Max-Age': '86400',
};

function applyCors(response: NextResponse, request: NextRequest): NextResponse {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  if (NO_STORE_API_PATH.test(request.nextUrl.pathname)) {
    response.headers.set('Cache-Control', 'no-store');
  }
  return response;
}

function corsPreflight(request: NextRequest): NextResponse {
  return applyCors(new NextResponse(null, { status: 204 }), request);
}

function unauthorized(detail: string, request: NextRequest): NextResponse {
  const response = problemResponse({
    type: 'https://proxymanager.dev/errors/unauthorized',
    title: 'Unauthorized',
    status: 401,
    detail,
  });
  return applyCors(
    new NextResponse(response.body, {
      status: response.status,
      headers: response.headers,
    }),
    request,
  );
}

function tooManyRequests(request: NextRequest): NextResponse {
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
  return applyCors(nextResponse, request);
}

function misconfigured(request: NextRequest): NextResponse {
  const response = problemResponse({
    type: 'https://proxymanager.dev/errors/internal',
    title: 'Internal Server Error',
    status: 500,
    detail: 'Server misconfigured: ADMIN_KEY environment variable is not set.',
  });
  return applyCors(
    new NextResponse(response.body, {
      status: response.status,
      headers: response.headers,
    }),
    request,
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (request.method === 'OPTIONS') {
    return corsPreflight(request);
  }

  const { pathname } = request.nextUrl;
  if (PUBLIC_API_PATHS[pathname]) {
    return applyCors(NextResponse.next(), request);
  }

  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return misconfigured(request);
  }

  const authHeader = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !safeEqual(match[1], adminKey)) {
    const blocked = await registerAuthFailure('admin', clientIp(request));
    if (blocked) return tooManyRequests(request);
    return unauthorized('Valid `Authorization: Bearer <ADMIN_KEY>` header is required.', request);
  }

  return applyCors(NextResponse.next(), request);
}

export const config = {
  matcher: ['/api/v1/:path*'],
};
