/**
 * mihomo documentation grounding via the public DeepWiki MCP server.
 *
 * The Next backend acts as a minimal MCP *client* over the streamable-HTTP
 * transport (initialize → notifications/initialized → tools/call). DeepWiki
 * is public — no auth. Two repos matter:
 *   - MetaCubeX/Meta-Docs : official config docs (default; answers "how do I
 *     configure X")
 *   - MetaCubeX/mihomo    : the Go core source (answers behaviour the docs
 *     don't spell out)
 *
 * Every failure degrades softly: the action returns an `unavailable` envelope
 * so the model still answers from general knowledge with a caveat, and the
 * platform is never blocked on DeepWiki being up.
 */

import { z } from 'zod';
import { defineAction } from './actions/types';

const DEEPWIKI_MCP_URL = process.env.DEEPWIKI_MCP_URL ?? 'https://mcp.deepwiki.com/mcp';
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRpcResult = { result?: unknown; error?: { code: number; message: string } };

/** Parse a streamable-HTTP MCP response that may be plain JSON or SSE-framed. */
async function readJsonRpc(res: Response): Promise<JsonRpcResult> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    // Collect `data:` payloads; return the last one carrying a result/error.
    let last: JsonRpcResult | null = null;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload) as JsonRpcResult;
        if ('result' in obj || 'error' in obj) last = obj;
      } catch {
        /* skip non-JSON keepalive frames */
      }
    }
    if (last) return last;
    throw new Error('No JSON-RPC payload in SSE stream');
  }
  return JSON.parse(text) as JsonRpcResult;
}

async function mcpPost(
  body: unknown,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return fetch(DEEPWIKI_MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
}

/** Ask DeepWiki a question about a repo. Returns the answer text or throws. */
async function askDeepwiki(repoName: string, question: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // 1) initialize — capture the session id the server hands back.
    const initRes = await mcpPost(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'proxymanager', version: '0.1.0' },
        },
      },
      undefined,
      controller.signal,
    );
    if (!initRes.ok) throw new Error(`initialize HTTP ${initRes.status}`);
    const sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
    await readJsonRpc(initRes); // drain/validate

    // 2) initialized notification (required before tools/call).
    await mcpPost(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
      controller.signal,
    );

    // 3) call ask_question.
    const callRes = await mcpPost(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ask_question', arguments: { repoName, question } },
      },
      sessionId,
      controller.signal,
    );
    if (!callRes.ok) throw new Error(`tools/call HTTP ${callRes.status}`);
    const rpc = await readJsonRpc(callRes);
    if (rpc.error) throw new Error(rpc.error.message);

    const content = (rpc.result as { content?: Array<{ type: string; text?: string }> })?.content;
    const answer = (content ?? [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (!answer) throw new Error('Empty answer from DeepWiki');
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

export const searchMihomoDocs = defineAction({
  name: 'search_mihomo_docs',
  description:
    '查询 mihomo/clash.meta 官方知识。配置怎么写、字段含义、规则/策略组/DNS/嗅探用法 → repo 用 Meta-Docs(默认)；文档没写清的内部行为(如 fallback/负载均衡细节) → repo 用 mihomo(源码)。回答任何 mihomo 配置问题前都应先调用以确保准确。',
  input: z.object({
    question: z.string().min(3).max(500).describe('自然语言问题，尽量具体'),
    repo: z
      .enum(['MetaCubeX/Meta-Docs', 'MetaCubeX/mihomo'])
      .default('MetaCubeX/Meta-Docs')
      .describe('Meta-Docs=官方配置文档；mihomo=Go 内核源码'),
  }),
  risk: 'read',
  async run(_ctx, input) {
    try {
      const answer = await askDeepwiki(input.repo, input.question);
      return {
        kind: 'doc-citation',
        data: {
          question: input.question,
          repo: input.repo,
          answer,
          source: `https://deepwiki.com/${input.repo}`,
        },
        untrusted: true,
      };
    } catch (err) {
      return {
        kind: 'doc-citation',
        data: {
          question: input.question,
          repo: input.repo,
          unavailable: true,
          error: err instanceof Error ? err.message : String(err),
          hint: '官方文档：https://wiki.metacubex.one/config/',
        },
        untrusted: true,
      };
    }
  },
});
