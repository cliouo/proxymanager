import { generateOpenApiDocument } from '@/lib/openapi/document';

export const dynamic = 'force-dynamic';

let cached: ReturnType<typeof generateOpenApiDocument> | null = null;

export async function GET() {
  cached ??= generateOpenApiDocument();
  return Response.json(cached, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
