import { parse } from 'yaml';
import { buildBase64Subscription } from '@/lib/proxies/clashToUri';
import { cachedProfileEtag, renderProfileConfig } from '@/lib/engine/renderCache';
import { attachmentDisposition } from '@/lib/http/contentDisposition';
import { etagMatches } from '@/lib/http/etag';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { guardSubToken } from '@/lib/http/subGuard';
import { TEMPLATE_NOT_DISTRIBUTABLE, isTemplateProfile } from '@/lib/profiles/kind';
import { getProfileByName } from '@/lib/repos/profilesRepo';

export const dynamic = 'force-dynamic';
// P3-18: a cold render (8 concurrent upstream fetches + full YAML build) can run
// long; give it an explicit ceiling instead of the platform's 10s default.
export const maxDuration = 60;

type Ctx = RouteContext<'/api/sub/[token]/[profile]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, profile } = await ctx.params;
  // Accept the master token, a token derived for THIS profile, or a rotated
  // one; rate-limit failed attempts by IP (P1-2/P1-3).

  // 模版不对外分发 —— 在**渲染之前**拦掉,别为一份注定 404 的请求付渲染成本
  // (renderProfileConfig 自己只 404 未知名字,不认识 kind)。措辞与未知名字的
  // 404 同一套 Problem Details,不额外暴露「这个名字存在」以外的信息。
  const record = await getProfileByName(profile);
  await guardSubToken(
    request,
    token,
    record ? { type: 'profile', id: record.id, tokenVersion: record.token_version } : undefined,
  );
  if (!record) throw ProblemDetailsError.notFound(`Profile "${profile}" 不存在。`);
  if (isTemplateProfile(record)) {
    throw ProblemDetailsError.notFound(
      `Profile "${profile}" 是模版,${TEMPLATE_NOT_DISTRIBUTABLE} —— 请从它新建一份配置文件再分发。`,
    );
  }

  // 其余配置文件都可按名字分发 —— renderProfileConfig 绑定其来源,
  // 未知名字由它 404(见 lib/engine/renderCache)。
  const url = new URL(request.url);
  const noCache = url.searchParams.get('noCache') === '1';
  const format = url.searchParams.get('format');
  if (format && !['clash', 'yaml', 'base64', 'v2ray'].includes(format))
    throw ProblemDetailsError.badRequest('Unsupported config format.');
  const asBase64 = format === 'base64' || format === 'v2ray';
  const providerUrlBase = `${url.origin}/api/rule-providers/${token}`;
  const conditional = request.headers.get('if-none-match');
  if (!noCache && !asBase64 && conditional) {
    const etag = await cachedProfileEtag(profile, providerUrlBase, conditional, record.id);
    if (etag)
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, 'X-Render-Cache': 'hit', 'Cache-Control': 'no-store' },
      });
  }
  // Data loading + resolveConfig now live behind the render cache — when
  // nothing changed since the last render, this is a single Redis MGET.
  // `?noCache=1` keeps its old meaning (force-refresh upstream subs) and
  // additionally bypasses the render cache read (still rewrites it).
  const { resolved, displayName, cache } = await renderProfileConfig(profile, {
    expectedProfileId: record.id,
    providerUrlBase,
    noCache,
  });

  // The filename is what proxy clients display as the subscription name. When a
  // profile sets a custom display_name we use it VERBATIM — no `.yaml` suffix,
  // since the user named it deliberately and clients show the name as-is. Only
  // the generated fallback keeps `.yaml` (it's a bare slug, not a chosen name).
  const custom = displayName?.trim();
  const filename = custom || `proxymanager-${profile}.yaml`;

  // buildId is content-addressed, so it doubles as a strong ETag — Mihomo /
  // clients polling on Profile-Update-Interval can skip the body transfer.
  const doc = asBase64 ? parse(resolved.content) : null;
  const proxies = Array.isArray(doc?.proxies) ? doc.proxies : [];
  const encoded = asBase64 ? buildBase64Subscription(proxies) : null;
  if (encoded && !encoded.lineCount && proxies.length)
    throw ProblemDetailsError.unprocessable('没有可导出为通用订阅的节点。');
  const etag = `"${resolved.buildId}${asBase64 ? '-b64' : ''}"`;
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        ETag: etag,
        'X-Render-Cache': cache,
      },
    });
  }

  return new Response(encoded?.content ?? resolved.content, {
    status: 200,
    headers: {
      'Content-Type': asBase64 ? 'text/plain; charset=utf-8' : 'text/yaml; charset=utf-8',
      ...(encoded
        ? {
            'X-Proxy-Count': String(encoded.lineCount),
            'X-Skipped-Nodes': String(encoded.skipped.length),
          }
        : {}),
      'Content-Disposition': attachmentDisposition(filename),
      'Cache-Control': 'no-store',
      'Profile-Update-Interval': '24',
      ETag: etag,
      'X-Build-Id': resolved.buildId,
      'X-Inlined-Proxy-Count': String(resolved.inlinedProxyCount),
      'X-Render-Cache': cache,
    },
  });
});
