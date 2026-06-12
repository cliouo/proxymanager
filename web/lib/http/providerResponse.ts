import { contentEtag, etagMatches } from '@/lib/http/etag';
import type { NodeExportResult } from '@/lib/services/nodeExportService';

/**
 * 把节点导出结果定型成对外 provider 响应:text/yaml、内容寻址 ETag(命中
 * If-None-Match 直接 304 省掉 body)、Subscription-Userinfo 透传(有流量信息
 * 时,客户端能显示用量)。stale / 被跳过成员经 X- 头如实暴露,绝不静默。
 */
export function nodeExportResponse(
  request: Request,
  result: NodeExportResult,
  filename: string,
): Response {
  const etag = contentEtag(result.yaml);
  const headers: Record<string, string> = {
    ETag: etag,
    'Cache-Control': 'no-store',
    'X-Proxy-Count': String(result.proxyCount),
  };
  if (result.stale) headers['X-Stale'] = '1';
  if (result.memberErrors.length > 0) {
    headers['X-Skipped-Members'] = String(result.memberErrors.length);
  }
  if (result.traffic) {
    const t = result.traffic;
    headers['Subscription-Userinfo'] =
      `upload=${t.upload}; download=${t.download}; total=${t.total}; expire=${t.expire}`;
  }

  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }

  // RFC 5987:filename 给 ASCII 兜底,filename* 携带可能含中文的真实名。
  const asciiSafe = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return new Response(result.yaml, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
