import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import {
  ConfigMissingError,
  ConfigPreflightUnavailableError,
  ConfigValidationError,
} from '@/lib/config/errors';
import { importManualSubscriptionContent } from '@/lib/services/subscriptionService';
import { MAX_SUBSCRIPTION_CONTENT, type SubscriptionManualUpdateOrigin } from '@/schemas';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/v1/subscriptions/[id]/manual-refresh'>;

function parseRequiredRevision(raw: string | null, header: string): number {
  if (raw === null) {
    throw ProblemDetailsError.badRequest(`${header} 请求头是必需的。`);
  }
  const match = /^(?:W\/)?"(0|[1-9][0-9]*)"$|^(0|[1-9][0-9]*)$/.exec(raw.trim());
  const parsed = Number(match?.[1] ?? match?.[2] ?? Number.NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw ProblemDetailsError.badRequest(`${header} 请求头格式无效。`);
  }
  return parsed;
}

function parseOrigin(raw: string | null): SubscriptionManualUpdateOrigin {
  if (raw === null || raw === 'web' || raw === 'web-ui') return 'web';
  if (raw === 'extension') return 'extension';
  throw ProblemDetailsError.badRequest('X-Source 请求头格式无效。');
}

function assertTextPlain(request: Request): void {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'text/plain') {
    throw ProblemDetailsError.unsupportedMediaType('请求 Content-Type 必须是 text/plain。');
  }
}

function declaredBodySize(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw ProblemDetailsError.badRequest('Content-Length 请求头格式无效。');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw ProblemDetailsError.badRequest('Content-Length 请求头格式无效。');
  }
  return parsed;
}

async function readCappedUtf8Body(request: Request): Promise<string> {
  assertTextPlain(request);
  const declaredLength = declaredBodySize(request);
  if (declaredLength !== null && declaredLength > MAX_SUBSCRIPTION_CONTENT) {
    await request.body?.cancel().catch(() => undefined);
    throw ProblemDetailsError.payloadTooLarge('订阅内容过大，最大支持 4 MiB。');
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts: string[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SUBSCRIPTION_CONTENT) {
        await reader.cancel().catch(() => undefined);
        throw ProblemDetailsError.payloadTooLarge('订阅内容过大，最大支持 4 MiB。');
      }
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch (error) {
    if (error instanceof ProblemDetailsError) throw error;
    throw ProblemDetailsError.unprocessable('订阅内容必须是有效的 UTF-8 文本。');
  } finally {
    reader.releaseLock();
  }
  return parts.join('');
}

const postWithProblemDetails = withProblemDetails(async (request: Request, ctx: Ctx) => {
  try {
    const expectedUpdatedAt = parseRequiredRevision(request.headers.get('if-match'), 'If-Match');
    const expectedFetchIdentityRevision = parseRequiredRevision(
      request.headers.get('x-fetch-identity-revision'),
      'X-Fetch-Identity-Revision',
    );
    const origin = parseOrigin(request.headers.get('x-source'));
    const content = await readCappedUtf8Body(request);
    const { id } = await ctx.params;
    const imported = await importManualSubscriptionContent(
      id,
      content,
      origin,
      expectedUpdatedAt,
      expectedFetchIdentityRevision,
    );
    return Response.json({
      data: { proxyCount: imported.proxyCount, updatedAt: imported.updatedAt },
    });
  } catch (error) {
    if (
      error instanceof ProblemDetailsError ||
      error instanceof ConfigMissingError ||
      error instanceof ConfigPreflightUnavailableError ||
      error instanceof ConfigValidationError
    ) {
      throw error;
    }
    console.error('[subscription-manual-refresh] unexpected failure');
    throw ProblemDetailsError.internal();
  }
});

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const response = await postWithProblemDetails(request, ctx);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
