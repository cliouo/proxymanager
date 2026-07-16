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
 *      `confirm-write` envelope carrying the server token. The token stays
 *      inside this bridge and is never returned to the model.
 *      NOTHING is mutated yet.
 *   2. the bridge asks the MCP host for a form elicitation. Only an explicit
 *      human accept + checked confirmation posts the hidden token to /confirm;
 *      unsupported/declined/cancelled elicitation leaves storage unchanged.
 *
 * Env:
 *   PROXYMANAGER_BASE_URL   default http://localhost:3000
 *   PROXYMANAGER_ADMIN_KEY  required for any real call (Bearer)
 *   PROXYMANAGER_PROFILE    initial profile, default "default"; switch at runtime with select_profile
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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = (
  process.env.PROXYMANAGER_BASE_URL || "http://localhost:3000"
).replace(/\/+$/, "");
const ADMIN_KEY = process.env.PROXYMANAGER_ADMIN_KEY || "";
let activeProfile = process.env.PROXYMANAGER_PROFILE || "default";

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ADMIN_KEY}`,
  };
}

function url(path) {
  const u = new URL(BASE + path);
  if (activeProfile) u.searchParams.set("profile", activeProfile);
  return u.toString();
}

/** Synthetic profile navigation tools. They change only this bridge process. */
const LIST_PROFILES_TOOL = {
  name: "list_profiles",
  description:
    "列出 ProxyManager 中可选的配置文件名称，并标出当前 MCP 正在操作的 profile。只读。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const SELECT_PROFILE_TOOL = {
  name: "select_profile",
  description:
    "切换后续 MCP 工具调用所操作的 ProxyManager profile。只接受 list_profiles 返回的精确 name；已生成的确认 token 仍绑定原 profile。",
  inputSchema: {
    type: "object",
    properties: {
      profile: {
        type: "string",
        description: "list_profiles 返回的 profile name",
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-z0-9-]+$",
      },
    },
    required: ["profile"],
    additionalProperties: false,
  },
};

async function loadProfiles() {
  const res = await fetch(BASE + "/api/v1/profiles", { headers: headers() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Unable to list ProxyManager profiles.");
  const profiles = Array.isArray(json?.data) ? json.data : [];
  return profiles
    .filter((profile) => profile && typeof profile.name === "string")
    .map((profile) => ({
      name: profile.name,
      ...(typeof profile.display_name === "string"
        ? { displayName: profile.display_name }
        : {}),
      active: profile.name === activeProfile,
    }));
}

async function fetchTools() {
  const res = await fetch(url("/api/v1/assistant/bootstrap"), {
    headers: headers(),
  });
  if (!res.ok) {
    throw new Error(`Unable to load ProxyManager tools (${res.status}).`);
  }
  const { data } = await res.json();
  // data.tools: OpenAI-style [{ type:'function', function:{ name, description, parameters } }]
  const tools = (data?.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: t.function.parameters || { type: "object", properties: {} },
  }));
  tools.push(LIST_PROFILES_TOOL, SELECT_PROFILE_TOOL);
  return tools;
}

function okResult(envelope) {
  // Feed the model the same `modelContent` the browser agent loop feeds it.
  const text =
    typeof envelope?.modelContent === "string"
      ? envelope.modelContent
      : JSON.stringify(envelope ?? {});
  return { content: [{ type: "text", text }] };
}

function errResult(payload) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
  };
}

const CONFIRM_RESULT_UNKNOWN =
  "ProxyManager confirmation result is unknown. Do not retry automatically; re-read the target profile to verify the current state.";

const SENSITIVE_CONFIRMATION_KEY =
  /^(?:.*(?:password|passwd|secret|token|credential|authorization|private[-_]?key|api[-_]?key|cookie).*|uuid|psk|auth|code|signature|sig)$/iu;

function scrubInlineConfirmationText(value) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/https?:\/\/[^\s"'<>]+/giu, (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}//${parsed.host}/***`;
      } catch {
        return "***";
      }
    })
    .replace(
      /\b([A-Za-z0-9_-]+)\s*["']?\s*[:=]\s*["']?([^"'\s,;}\]]+)/giu,
      (match, key) =>
        SENSITIVE_CONFIRMATION_KEY.test(key) ? `${key}=***` : match,
    )
    .replace(/\bBearer\s+[^\s,"';}\]]+/giu, "Bearer ***")
    .replace(/[A-Za-z0-9]{24,}/gu, "***");
}

function scrubMultilineConfirmationText(value) {
  const lines = String(value ?? "").split(/\r?\n/u);
  let sensitiveBlockIndent = null;
  return lines
    .map((line) => {
      const indent = line.match(/^\s*/u)?.[0].length ?? 0;
      if (sensitiveBlockIndent !== null) {
        if (line.trim() === "" || indent > sensitiveBlockIndent) {
          return line.trim() === "" ? "" : `${" ".repeat(indent)}***`;
        }
        sensitiveBlockIndent = null;
      }

      const pair =
        /^(\s*(?:-\s*)?["']?)([A-Za-z0-9_-]+)(["']?\s*:\s*)(.*)$/u.exec(line);
      if (pair && SENSITIVE_CONFIRMATION_KEY.test(pair[2])) {
        if (/^[>|]/u.test(pair[4].trim())) sensitiveBlockIndent = indent;
        return `${pair[1]}${pair[2]}${pair[3]}***`;
      }
      return scrubInlineConfirmationText(line);
    })
    .join("\n");
}

function scrubConfirmationText(value, maxLength) {
  return scrubMultilineConfirmationText(value).slice(0, maxLength);
}

function scrubConfirmationValue(value, key = "", depth = 0) {
  if (SENSITIVE_CONFIRMATION_KEY.test(key)) return "***";
  if (depth > 12) return "[nested diff omitted]";
  if (typeof value === "string") return scrubMultilineConfirmationText(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((item) => scrubConfirmationValue(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([childKey, childValue]) => [
          childKey,
          scrubConfirmationValue(childValue, childKey, depth + 1),
        ]),
    );
  }
  return value;
}

function confirmationDetail(pending) {
  const action = scrubConfirmationText(
    pending?.action || "unknown-action",
    120,
  );
  let rawDiff = "";
  try {
    rawDiff = JSON.stringify(scrubConfirmationValue(pending?.diff ?? {}));
  } catch {
    rawDiff = "[diff unavailable]";
  }
  return `操作：${action}\n变更：${scrubConfirmationText(rawDiff, 2400)}`;
}

/** Confirm a hidden token without reflecting execution errors or claiming rollback. */
export async function confirmHiddenWrite(token, fetchImpl = fetch) {
  try {
    const confirmResponse = await fetchImpl(
      BASE + "/api/v1/assistant/confirm",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ token }),
      },
    );
    if (!confirmResponse.ok) return errResult(CONFIRM_RESULT_UNKNOWN);
    let confirmed;
    try {
      confirmed = await confirmResponse.json();
    } catch {
      return errResult(CONFIRM_RESULT_UNKNOWN);
    }
    if (confirmed?.data?.kind !== "write-result") {
      return errResult(CONFIRM_RESULT_UNKNOWN);
    }
    return okResult(confirmed.data);
  } catch {
    return errResult(CONFIRM_RESULT_UNKNOWN);
  }
}

/**
 * Human-gate a pending write without exposing its one-time server token to the
 * model. Exported for a small regression test; production passes Server.elicitInput.
 */
export async function gatePendingWrite(
  server,
  envelope,
  profile,
  confirmPending,
) {
  const pending = envelope?.data;
  const token = typeof pending?.token === "string" ? pending.token : "";
  const summary =
    typeof pending?.summary === "string"
      ? scrubConfirmationText(pending.summary.replace(/[\r\n]+/gu, " "), 300)
      : "修改 ProxyManager 配置";
  if (!/^[a-f0-9]{36}$/u.test(token)) {
    return errResult({
      error: "invalid confirmation envelope; no change was applied",
    });
  }
  if (!server.getClientCapabilities()?.elicitation?.form) {
    return errResult({
      error:
        "MCP client does not support confirmation forms; no change was applied",
      profile,
    });
  }

  const approval = await server.elicitInput({
    mode: "form",
    message: `确认修改 ProxyManager 配置「${scrubConfirmationText(profile, 128)}」：${summary}\n${confirmationDetail(pending)}`,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "确认执行",
          description: "勾选后才会执行；取消、拒绝或不勾选都不会写入。",
          default: false,
        },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
  });
  if (approval.action !== "accept" || approval.content?.confirm !== true) {
    return okResult({
      kind: "write-cancelled",
      profile,
      summary,
      applied: false,
    });
  }
  return confirmPending(token);
}

async function callTool(name, args, server) {
  if (name === "list_profiles") {
    const profiles = await loadProfiles();
    return okResult({ profiles, activeProfile });
  }
  if (name === "select_profile") {
    const requested =
      typeof args?.profile === "string" ? args.profile.trim() : "";
    if (!/^[a-z0-9-]{1,128}$/u.test(requested)) {
      return errResult({ error: "invalid profile name" });
    }
    const profiles = await loadProfiles();
    if (!profiles.some((profile) => profile.name === requested)) {
      return errResult({ error: "unknown profile" });
    }
    activeProfile = requested;
    return okResult({ activeProfile });
  }
  const targetProfile = activeProfile;
  const res = await fetch(url("/api/v1/assistant/tool"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ name, input: args ?? {} }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) return errResult(json);
  if (json.data?.kind !== "confirm-write") return okResult(json.data);

  return gatePendingWrite(server, json.data, targetProfile, confirmHiddenWrite);
}

let toolQueue = Promise.resolve();

/** Serialize mutable-profile navigation with every tool invocation. */
function enqueueToolCall(name, args, server) {
  const run = toolQueue.then(() => callTool(name, args, server));
  toolQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function main() {
  const tools = await fetchTools();
  const server = new Server(
    { name: "proxymanager", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await enqueueToolCall(name, args, server);
    } catch (e) {
      const errorType = e instanceof Error ? e.name : typeof e;
      console.error("[proxymanager-mcp] tool call failed", { name, errorType });
      return errResult(
        "ProxyManager tool call failed without applying a change.",
      );
    }
  });

  await server.connect(new StdioServerTransport());
  // eslint-disable-next-line no-console
  console.error(
    `[proxymanager-mcp] ready · ${tools.length} tools · ${BASE} · profile=${activeProfile}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((e) => {
    const errorType = e instanceof Error ? e.name : typeof e;
    // eslint-disable-next-line no-console
    console.error("[proxymanager-mcp] fatal", { errorType });
    process.exit(1);
  });
}
