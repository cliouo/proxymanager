import { parse } from 'yaml';
import { renderDeviceConfig } from '@/lib/engine/renderCache';
import { attachmentDisposition } from '@/lib/http/contentDisposition';
import { etagMatches } from '@/lib/http/etag';
import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { guardSubToken } from '@/lib/http/subGuard';
import { TEMPLATE_NOT_DISTRIBUTABLE, isTemplateProfile } from '@/lib/profiles/kind';
import { buildBase64Subscription } from '@/lib/proxies/clashToUri';
import { getProfileByName } from '@/lib/repos/profilesRepo';

export const dynamic = 'force-dynamic';
// 与 [profile] 路由同档:冷渲染(并发上游 fetch + 整份 YAML 构建)可能很久。
export const maxDuration = 60;

type Ctx = RouteContext<'/api/sub/[token]/[profile]/[device]'>;

/**
 * 某台设备的订阅链接 = 该配置文件的共享渲染 + 这台设备的 base_patch。
 *
 * 与 `/api/sub/{token}/{profile}` 语义完全对齐,唯一的差别是多叠一层补丁:
 *   - **令牌作用域仍是 profile** —— 设备是子资源,不引入第三种令牌,
 *     `deriveSubToken` 不动、rotate 机制自然生效;
 *   - `?noCache=1` 强刷上游并绕过缓存读、`?format=base64` 通用订阅;
 *   - buildId 作强 ETag(按设备产物重算,两台设备不会串 304);
 *   - 模版不分发(Phase T 的闸门对设备链接同样有效 —— 否则从模版的设备链接
 *     就能绕过 §8.1 的 404)。
 *
 * `/api/sub/{token}/{profile}` 保持等于共享渲染,现有链接一根不断。
 */
export const GET = withProblemDetails(async (request: Request, ctx: Ctx) => {
  const { token, profile, device } = await ctx.params;
  await guardSubToken(request, token, profile);

  const record = await getProfileByName(profile);
  if (isTemplateProfile(record)) {
    throw ProblemDetailsError.notFound(
      `Profile "${profile}" 是模版,${TEMPLATE_NOT_DISTRIBUTABLE} —— 请从它新建一份配置文件再分发。`,
    );
  }

  const url = new URL(request.url);
  const noCache = url.searchParams.get('noCache') === '1';
  const format = url.searchParams.get('format');
  if (format !== null && format !== '' && !['clash', 'yaml', 'base64', 'v2ray'].includes(format)) {
    throw ProblemDetailsError.badRequest(
      `未知的导出格式 "${format}" —— 支持 clash(默认,完整配置 YAML)与 base64(通用分享链接订阅)。`,
    );
  }
  const asBase64 = format === 'base64' || format === 'v2ray';

  const { resolved, displayName, deviceDisplayName, cache } = await renderDeviceConfig(
    profile,
    device,
    {
      providerUrlBase: `${url.origin}/api/rule-providers/${token}`,
      noCache,
    },
  );

  // 文件名 = 设备自己的显示名优先,否则 `{profile 显示名 | proxymanager-{profile}}-{device}`。
  // 客户端把它当订阅名展示,同一份配置的多台设备必须一眼能分辨。
  const custom = deviceDisplayName?.trim();
  const profilePart = displayName?.trim() || `proxymanager-${profile}`;
  const stem = custom || `${profilePart}-${device}`;

  if (asBase64) {
    // 完整配置里的 `proxies:` 转分享链接。个别无法表达为链接的节点会被跳过,
    // 经 X-Skipped-Nodes 如实标注 —— 与资源分发链接同一套约定。
    const doc = parse(resolved.content) as { proxies?: unknown } | null;
    const proxies = Array.isArray(doc?.proxies) ? (doc.proxies as Record<string, unknown>[]) : [];
    const sub = buildBase64Subscription(proxies);
    if (sub.lineCount === 0 && proxies.length > 0) {
      throw ProblemDetailsError.unprocessable(
        `共 ${proxies.length} 个节点,但没有一个能表达为通用分享链接。`,
      );
    }
    const etag = `"${resolved.buildId}-b64"`;
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'X-Render-Cache': cache } });
    }
    return new Response(sub.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': attachmentDisposition(`${stem}.txt`),
        'Cache-Control': 'no-store',
        ETag: etag,
        'X-Build-Id': resolved.buildId,
        'X-Proxy-Count': String(sub.lineCount),
        ...(sub.skipped.length > 0 ? { 'X-Skipped-Nodes': String(sub.skipped.length) } : {}),
        'X-Render-Cache': cache,
      },
    });
  }

  const filename = custom || `${profilePart}-${device}.yaml`;
  const etag = `"${resolved.buildId}"`;
  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'X-Render-Cache': cache },
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
