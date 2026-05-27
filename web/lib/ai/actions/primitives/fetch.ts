/**
 * fetch_url — a read action that lets the assistant pull the content of an
 * external http/https URL (SSRF-guarded, size-capped). Useful for inspecting
 * an external rule list or page. Content is untrusted (wrapped before it
 * reaches the model).
 *
 * To turn an external rule-set into platform-hosted content, prefer
 * localize_rule_provider — it fetches server-side and stores the result
 * directly, so large content never round-trips through the model.
 */

import { z } from 'zod';
import { safeFetchText } from '@/lib/net/safeFetch';
import { defineAction } from '../types';

/** Cap returned to the model — enough to inspect, small enough for context. */
const FETCH_URL_MAX_BYTES = 64_000;

const fetchUrl = defineAction({
  name: 'fetch_url',
  description:
    '抓取一个 http/https URL 的文本内容（只读；禁止内网/本机/云元数据地址，有大小与超时上限）。用于查看外部规则列表、页面内容等。reader=false(默认)返回原始文本(适合 yaml/规则文件)；reader=true 经 r.jina.ai 提取网页正文(适合 HTML 页面)。注意：要把某个外部规则集转成本平台托管，请直接用 localize_rule_provider，不要用本工具把内容经模型中转。',
  input: z.object({
    url: z.string().min(1).max(2000).describe('http/https 链接'),
    reader: z
      .boolean()
      .optional()
      .describe('true=经 r.jina.ai 提取网页可读正文；默认 false=原始内容'),
  }),
  risk: 'read',
  async run(_ctx, input) {
    const r = await safeFetchText(input.url, { reader: input.reader, maxBytes: FETCH_URL_MAX_BYTES });
    return {
      kind: 'fetched-url',
      data: {
        url: input.url,
        finalUrl: r.finalUrl,
        contentType: r.contentType,
        bytes: r.bytes,
        truncated: r.truncated,
        content: r.text,
      },
      untrusted: true,
    };
  },
});

export const FETCH_ACTIONS = [fetchUrl];
