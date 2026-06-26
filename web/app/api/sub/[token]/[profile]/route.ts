import { requireSubToken } from '@/lib/auth';
import { renderProfileConfig } from '@/lib/engine/renderCache';
import { attachmentDisposition } from '@/lib/http/contentDisposition';
import { etagMatches } from '@/lib/http/etag';
import { withProblemDetails } from '@/lib/http/handler';

export const dynamic = 'force-dynamic';

type Ctx = RouteContext<'/api/sub/[token]/[profile]'>;

export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, profile } = await ctx.params;
  requireSubToken(token);

  // Any profile is distributable by name — renderProfileConfig binds its
  // source and 404s an unknown name (see lib/engine/renderCache).
  const url = new URL(request.url);
  const noCache = url.searchParams.get('noCache') === '1';
  // Data loading + resolveConfig now live behind the render cache — when
  // nothing changed since the last render, this is a single Redis MGET.
  // `?noCache=1` keeps its old meaning (force-refresh upstream subs) and
  // additionally bypasses the render cache read (still rewrites it).
  const { resolved, displayName, cache } = await renderProfileConfig(profile, {
    providerUrlBase: `${url.origin}/api/rule-providers/${token}`,
    noCache,
  });

  // The filename is what proxy clients display as the subscription name. A
  // profile's custom display_name wins; otherwise fall back to the generated
  // `proxymanager-{name}` default. `.yaml` is kept so clients treat it as YAML.
  const filename = `${displayName?.trim() || `proxymanager-${profile}`}.yaml`;

  // buildId is content-addressed, so it doubles as a strong ETag — Mihomo /
  // clients polling on Profile-Update-Interval can skip the body transfer.
  const etag = `"${resolved.buildId}"`;
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

  return new Response(resolved.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
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
