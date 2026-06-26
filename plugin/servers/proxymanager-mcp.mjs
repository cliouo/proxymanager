#!/usr/bin/env node
/**
 * ProxyManager MCP bridge (stdio).
 *
 * Exposes ProxyManager's in-app action registry as MCP tools by proxying to the
 * existing HTTP API — so any skill-aware client (Claude Code, Codex, …) drives
 * the SAME backend the browser assistant uses, with the SAME server-side write
 * gate. This is a BRIDGE, not a reimplementation: the 30-ish action schemas come
 * live from /api/v1/assistant/bootstrap and calls proxy to /api/v1/assistant/tool.
 *
 * Auth: `Authorization: Bearer ${PROXYMANAGER_ADMIN_KEY}` (see web/lib/auth.ts
 * requireAdminBearer). Profile: appended as `?profile=` (see web/lib/profileScope.ts
 * precedence query > cookie > default), so the confirm-token's profile binding
 * is preserved and the bridge can never retarget another profile mid-handshake.
 *
 * Two-step write handshake, preserved for non-browser clients:
 *   1. model calls a write tool (e.g. add_rule) -> POST /tool -> returns a
 *      `confirm-write` envelope carrying { summary, diff, confirmation_token }.
 *      NOTHING is mutated yet.
 *   2. the model shows summary/diff to the user; once the user authorises, the
 *      model calls the synthetic `confirm_write` tool with that token ->
 *      POST /confirm -> the write executes (audited + undoable).
 *
 * Env:
 *   PROXYMANAGER_BASE_URL   default http://localhost:3000
 *   PROXYMANAGER_ADMIN_KEY  required for any real call (Bearer)
 *   PROXYMANAGER_PROFILE    default "default"
 *
 * Run: `node proxymanager-mcp.mjs` (needs `npm install` in this dir for the SDK).
 *
 * NOTES (see ./README.md):
 *   - `preview_proxy_group_members` IS a registered server action
 *     (web/lib/ai/actions/primitives/proxyGroupWrites.ts), so it shows up here
 *     normally; the browser additionally has a zero-round-trip local copy.
 *   - /bootstrap's systemPrompt is now assembled from the plugin skills
 *     (web/lib/ai/systemPrompt.ts); the bridge IGNORES it (skill-aware clients
 *     read the SKILL.md files natively) and uses only its `tools` list.
 *   - Not for the claude.ai/API surface (no network in code-exec → docs/fetch
 *     fail there); expose a remote connector + `compatibility` if needed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.PROXYMANAGER_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_KEY = process.env.PROXYMANAGER_ADMIN_KEY || '';
const PROFILE = process.env.PROXYMANAGER_PROFILE || 'default';

function headers() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_KEY}` };
}

function url(path) {
  const u = new URL(BASE + path);
  if (PROFILE) u.searchParams.set('profile', PROFILE);
  return u.toString();
}

/** Synthetic tool: step 2 of the write handshake. Not in the registry. */
const CONFIRM_TOOL = {
  name: 'confirm_write',
  description:
    '执行此前某个写操作返回的待确认改动。仅当用户明确授权了那张 confirm-write 卡后才调用，传入其中的 confirmation_token。' +
    'Executes a previously-previewed write ONLY after the user authorises it; pass the confirmation_token from the confirm-write result. One-time, expires in ~5 min.',
  inputSchema: {
    type: 'object',
    properties: { token: { type: 'string', description: 'confirmation_token from a confirm-write envelope' } },
    required: ['token'],
    additionalProperties: false,
  },
};

async function fetchTools() {
  const res = await fetch(url('/api/v1/assistant/bootstrap'), { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`bootstrap ${res.status}: ${body.slice(0, 300)}`);
  }
  const { data } = await res.json();
  // data.tools: OpenAI-style [{ type:'function', function:{ name, description, parameters } }]
  const tools = (data?.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters || { type: 'object', properties: {} },
  }));
  tools.push(CONFIRM_TOOL);
  return tools;
}

function okResult(envelope) {
  // Feed the model the same `modelContent` the browser agent loop feeds it.
  const text =
    typeof envelope?.modelContent === 'string' ? envelope.modelContent : JSON.stringify(envelope ?? {});
  return { content: [{ type: 'text', text }] };
}

function errResult(payload) {
  return { isError: true, content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

async function callTool(name, args) {
  if (name === 'confirm_write') {
    const res = await fetch(url('/api/v1/assistant/confirm'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ token: args?.token }),
    });
    const json = await res.json().catch(() => ({}));
    return res.ok ? okResult(json.data) : errResult(json);
  }
  const res = await fetch(url('/api/v1/assistant/tool'), {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ name, input: args ?? {} }),
  });
  const json = await res.json().catch(() => ({}));
  return res.ok ? okResult(json.data) : errResult(json);
}

async function main() {
  const tools = await fetchTools();
  const server = new Server({ name: 'proxymanager', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await callTool(name, args);
    } catch (e) {
      return errResult(String(e?.message || e));
    }
  });

  await server.connect(new StdioServerTransport());
  // eslint-disable-next-line no-console
  console.error(`[proxymanager-mcp] ready · ${tools.length} tools · ${BASE} · profile=${PROFILE}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[proxymanager-mcp] fatal:', e);
  process.exit(1);
});
