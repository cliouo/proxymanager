import { attachmentDisposition } from '@/lib/http/contentDisposition';
import { contentEtag, etagMatches } from '@/lib/http/etag';
import { ProblemDetailsError } from '@/lib/http/problem';
import { buildBase64Subscription } from '@/lib/proxies/clashToUri';
import type { NodeExportResult } from '@/lib/services/nodeExportService';

/**
 * 把节点导出结果定型成对外分发响应。两种格式:
 *   - `clash`(默认):`proxies:` provider YAML,mihomo / Clash 客户端直接用;
 *   - `base64`:每行一条分享链接、整体 base64 的通用订阅正文(俗称 v2ray
 *     订阅格式),Shadowrocket / v2rayN 这类只吃纯节点协议的客户端能导入。
 * 共同语义:内容寻址 ETag(命中 If-None-Match 直接 304 省掉 body)、
 * Subscription-Userinfo 透传(有流量信息时,客户端能显示用量)。stale /
 * 被跳过成员 / 序列化不了的节点经 X- 头如实暴露,绝不静默。
 */

export type NodeExportFormat = 'clash' | 'base64';

/** 读 `?format=`;缺省 clash。未知值 400,而不是悄悄回退成别的格式。 */
export function parseNodeExportFormat(request: Request): NodeExportFormat {
  const raw = new URL(request.url).searchParams.get('format');
  if (raw === null || raw === '' || raw === 'clash' || raw === 'yaml') return 'clash';
  if (raw === 'base64' || raw === 'v2ray') return 'base64';
  throw ProblemDetailsError.badRequest(
    `未知的导出格式 "${raw}" —— 支持 clash(默认,provider YAML)与 base64(通用分享链接订阅)。`,
  );
}

export function nodeExportResponse(
  request: Request,
  result: NodeExportResult,
  /** 文件名主干(不带扩展名),按格式补 .yaml / .txt。 */
  baseFilename: string,
  format: NodeExportFormat = 'clash',
): Response {
  let body: string;
  let contentType: string;
  let filename: string;
  let exportedCount: number;
  let serializeSkipped = 0;

  if (format === 'base64') {
    const sub = buildBase64Subscription(result.proxies);
    if (sub.lineCount === 0 && result.proxyCount > 0) {
      const sample = sub.skipped
        .slice(0, 3)
        .map((s) => `${s.name} → ${s.reason}`)
        .join('; ');
      throw ProblemDetailsError.unprocessable(
        `共 ${result.proxyCount} 个节点,但没有一个能表达为通用分享链接:${sample}`,
      );
    }
    body = sub.content;
    contentType = 'text/plain; charset=utf-8';
    filename = `${baseFilename}.txt`;
    exportedCount = sub.lineCount;
    serializeSkipped = sub.skipped.length;
  } else {
    body = result.yaml;
    contentType = 'text/yaml; charset=utf-8';
    filename = `${baseFilename}.yaml`;
    exportedCount = result.proxyCount;
  }

  const etag = contentEtag(body);
  const headers: Record<string, string> = {
    ETag: etag,
    'Cache-Control': 'no-store',
    'X-Proxy-Count': String(exportedCount),
  };
  if (result.stale) headers['X-Stale'] = '1';
  if (result.memberErrors.length > 0) {
    headers['X-Skipped-Members'] = String(result.memberErrors.length);
  }
  if (serializeSkipped > 0) {
    headers['X-Skipped-Nodes'] = String(serializeSkipped);
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

  return new Response(body, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type': contentType,
      // RFC 5987:filename 给 ASCII 兜底,filename* 携带可能含中文的真实名。
      'Content-Disposition': attachmentDisposition(filename),
    },
  });
}
