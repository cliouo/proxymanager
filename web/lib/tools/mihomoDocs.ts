/**
 * mihomo documentation lookup via the public DeepWiki MCP server.
 *
 * Uses the streamable-HTTP MCP flow (initialize -> notifications/initialized ->
 * tools/call) against MetaCubeX/Meta-Docs (official config docs) or
 * MetaCubeX/mihomo (Go core source). Failures degrade softly so callers never
 * hard-fail when DeepWiki is unreachable.
 */

const DEEPWIKI_MCP_URL = process.env.DEEPWIKI_MCP_URL ?? 'https://mcp.deepwiki.com/mcp';
const REQUEST_TIMEOUT_MS = 30_000;

export type MihomoDocsRepo = 'MetaCubeX/Meta-Docs' | 'MetaCubeX/mihomo';

export type MihomoDocsResult =
  | {
      question: string;
      repo: MihomoDocsRepo;
      answer: string;
      source: string;
      untrusted: true;
    }
  | {
      question: string;
      repo: MihomoDocsRepo;
      unavailable: true;
      error: string;
      hint: string;
      untrusted: true;
    };

type JsonRpcResult = { result?: unknown; error?: { code: number; message: string } };

async function readJsonRpc(res: Response): Promise<JsonRpcResult> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
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

async function askDeepwiki(repoName: MihomoDocsRepo, question: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
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
    await readJsonRpc(initRes);

    await mcpPost(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
      controller.signal,
    );

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

export async function queryMihomoDocs(
  repo: MihomoDocsRepo,
  question: string,
): Promise<MihomoDocsResult> {
  try {
    const answer = await askDeepwiki(repo, question);
    return {
      question,
      repo,
      answer,
      source: `https://deepwiki.com/${repo}`,
      untrusted: true,
    };
  } catch (err) {
    return {
      question,
      repo,
      unavailable: true,
      error: err instanceof Error ? err.message : String(err),
      hint: '官方文档：https://wiki.metacubex.one/config/',
      untrusted: true,
    };
  }
}
