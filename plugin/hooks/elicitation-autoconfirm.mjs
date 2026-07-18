#!/usr/bin/env node
/**
 * Elicitation hook (Claude Code): auto-accept the proxymanager write-confirm
 * form when BOTH hold —
 *   1. the user enabled the trust_full_access plugin option
 *      (arrives as CLAUDE_PLUGIN_OPTION_TRUST_FULL_ACCESS), and
 *   2. the session is in bypassPermissions mode.
 * Any other mode, or when permission_mode is absent from the hook input,
 * produces no output — the confirmation card shows as usual (fail-safe).
 *
 * The hook is scoped to the `proxymanager` MCP server by the matcher in
 * plugin.json; the accepted content mirrors the form schema in
 * servers/proxymanager-mcp.mjs (gatePendingWrite): { confirm: true }.
 */

const trustEnabled = /^(1|true)$/iu.test(
  process.env.CLAUDE_PLUGIN_OPTION_TRUST_FULL_ACCESS ?? "",
);

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0); // unparseable input → let the card show
}

if (trustEnabled && input?.permission_mode === "bypassPermissions") {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "Elicitation",
        action: "accept",
        content: { confirm: true },
      },
    }),
  );
}
process.exit(0);
