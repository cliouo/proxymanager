import { NextResponse, type NextRequest } from 'next/server';
import { safeEqual } from '@/lib/auth';
import { problemResponse } from '@/lib/http/problem';

const PUBLIC_API_PATHS = new Set(['/api/v1/health', '/api/v1/openapi.json']);

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, Idempotency-Key',
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

export function proxy(request: NextRequest): NextResponse {
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
    return unauthorized('Valid `Authorization: Bearer <ADMIN_KEY>` header is required.');
  }

  return applyCors(NextResponse.next());
}

export const config = {
  matcher: ['/api/v1/:path*'],
};
