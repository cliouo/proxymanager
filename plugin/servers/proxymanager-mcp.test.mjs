import assert from "node:assert/strict";
import test from "node:test";
import { confirmHiddenWrite, gatePendingWrite } from "./proxymanager-mcp.mjs";

const ENVELOPE = {
  kind: "confirm-write",
  data: {
    action: "update_rule",
    summary: "把冗余直连迁移为 DIRECT",
    diff: {
      op: "update",
      before: { policy: "直连" },
      after: { policy: "DIRECT" },
      afterYaml:
        "name: safe-change\nheaders:\n  Authorization: Bearer shortsecret\nprivate-key: |\n  shortline-secret\n  second-secret-line\napi-key: shortsecret\nurl: https://secret.example/private?code=shortsecret",
    },
    token: "a".repeat(36),
  },
};

function fakeServer(result, supportsForm = true) {
  return {
    getClientCapabilities: () =>
      supportsForm ? { elicitation: { form: {} } } : {},
    elicitInput: async () => result,
  };
}

test("decline/cancel never calls the hidden confirm endpoint", async () => {
  let confirms = 0;
  const confirm = async () => {
    confirms += 1;
    return { applied: true };
  };

  const declined = await gatePendingWrite(
    fakeServer({ action: "decline" }),
    ENVELOPE,
    "default",
    confirm,
    "update_rule",
  );
  const unchecked = await gatePendingWrite(
    fakeServer({ action: "accept", content: { confirm: false } }),
    ENVELOPE,
    "default",
    confirm,
    "update_rule",
  );

  assert.equal(confirms, 0);
  assert.match(declined.content[0].text, /"applied":false/u);
  assert.match(unchecked.content[0].text, /"applied":false/u);
  assert.doesNotMatch(declined.content[0].text, /a{36}/u);
});

test("explicit host-form acceptance confirms exactly once without returning the token", async () => {
  const seen = [];
  let formMessage = "";
  const server = fakeServer({ action: "accept", content: { confirm: true } });
  server.elicitInput = async (request) => {
    formMessage = request.message;
    return { action: "accept", content: { confirm: true } };
  };
  const result = await gatePendingWrite(
    server,
    ENVELOPE,
    "default",
    async (token) => {
      seen.push(token);
      return { content: [{ type: "text", text: '{"applied":true}' }] };
    },
    "update_rule",
  );

  assert.deepEqual(seen, ["a".repeat(36)]);
  assert.equal(result.content[0].text, '{"applied":true}');
  assert.match(formMessage, /update_rule/u);
  assert.match(formMessage, /DIRECT/u);
  assert.match(formMessage, /直连/u);
  assert.doesNotMatch(formMessage, /a{36}/u);
  assert.match(formMessage, /safe-change/u);
  assert.doesNotMatch(
    formMessage,
    /shortsecret|shortline-secret|second-secret-line|\/private/u,
  );
  assert.doesNotMatch(result.content[0].text, /a{36}/u);
});

test("clients without form elicitation cannot execute writes", async () => {
  let confirms = 0;
  const result = await gatePendingWrite(
    fakeServer({ action: "accept", content: { confirm: true } }, false),
    ENVELOPE,
    "default",
    async () => {
      confirms += 1;
    },
    "update_rule",
  );

  assert.equal(confirms, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no change was applied/u);
});

test("trust_full_access lets form-less clients consume the token directly", async () => {
  process.env.PROXYMANAGER_TRUST_FULL_ACCESS = "true";
  try {
    const seen = [];
    const result = await gatePendingWrite(
      fakeServer(null, false),
      ENVELOPE,
      "default",
      async (token, expectedAction) => {
        seen.push([token, expectedAction]);
        return { content: [{ type: "text", text: '{"applied":true}' }] };
      },
      "update_rule",
    );

    assert.deepEqual(seen, [["a".repeat(36), "update_rule"]]);
    assert.equal(result.content[0].text, '{"applied":true}');
  } finally {
    delete process.env.PROXYMANAGER_TRUST_FULL_ACCESS;
  }
});

test("trust_full_access still shows the form when the client supports it", async () => {
  process.env.PROXYMANAGER_TRUST_FULL_ACCESS = "true";
  try {
    let elicited = 0;
    let confirms = 0;
    const server = fakeServer(null, true);
    server.elicitInput = async () => {
      elicited += 1;
      return { action: "decline" };
    };
    const result = await gatePendingWrite(
      server,
      ENVELOPE,
      "default",
      async () => {
        confirms += 1;
      },
      "update_rule",
    );

    assert.equal(elicited, 1);
    assert.equal(confirms, 0);
    assert.match(result.content[0].text, /"applied":false/u);
  } finally {
    delete process.env.PROXYMANAGER_TRUST_FULL_ACCESS;
  }
});

test("trust_full_access never bypasses an invalid confirmation token", async () => {
  process.env.PROXYMANAGER_TRUST_FULL_ACCESS = "true";
  try {
    let confirms = 0;
    const result = await gatePendingWrite(
      fakeServer(null, false),
      { ...ENVELOPE, data: { ...ENVELOPE.data, token: "nope" } },
      "default",
      async () => {
        confirms += 1;
      },
      "update_rule",
    );

    assert.equal(confirms, 0);
    assert.equal(result.isError, true);
  } finally {
    delete process.env.PROXYMANAGER_TRUST_FULL_ACCESS;
  }
});

test("oversized confirmation diffs fail closed before elicitation", async () => {
  let elicited = 0;
  let confirms = 0;
  const server = fakeServer({ action: "accept", content: { confirm: true } });
  server.elicitInput = async () => {
    elicited += 1;
    return { action: "accept", content: { confirm: true } };
  };
  const result = await gatePendingWrite(
    server,
    {
      ...ENVELOPE,
      data: { ...ENVELOPE.data, diff: { afterYaml: "- ".repeat(1300) } },
    },
    "default",
    async () => {
      confirms += 1;
    },
    "update_rule",
  );

  assert.equal(elicited, 0);
  assert.equal(confirms, 0);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /too large to display completely/u);
  assert.match(result.content[0].text, /no change was applied/u);
});

test("structurally omitted confirmation diffs fail closed before elicitation", async () => {
  const deep = {};
  let cursor = deep;
  for (let depth = 0; depth < 14; depth += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }
  const cases = [
    Array.from({ length: 201 }, (_, index) => index),
    Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`key-${index}`, index]),
    ),
    deep,
  ];

  for (const diff of cases) {
    let elicited = 0;
    let confirms = 0;
    const server = fakeServer({ action: "accept", content: { confirm: true } });
    server.elicitInput = async () => {
      elicited += 1;
      return { action: "accept", content: { confirm: true } };
    };
    const result = await gatePendingWrite(
      server,
      { ...ENVELOPE, data: { ...ENVELOPE.data, diff } },
      "default",
      async () => {
        confirms += 1;
      },
      "update_rule",
    );

    assert.equal(elicited, 0);
    assert.equal(confirms, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /too large to display completely/u);
  }
});

test("unknown confirmation outcomes never claim no change or reflect server secrets", async () => {
  const network = await confirmHiddenWrite(
    "a".repeat(36),
    async () => {
      throw new Error("socket closed after commit");
    },
    "update_rule",
  );
  const rejected = await confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: false,
      json: async () => ({
        detail: "invalid https://secret.example/token=TOPSECRET123456789",
      }),
    }),
    "update_rule",
  );
  const malformed = await confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("truncated json");
      },
    }),
    "update_rule",
  );
  const missingData = await confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: true,
      json: async () => ({}),
    }),
    "update_rule",
  );

  for (const result of [network, rejected, malformed, missingData]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /result is unknown/u);
    assert.match(result.content[0].text, /Do not retry automatically/u);
    assert.doesNotMatch(result.content[0].text, /without applying|no change/u);
    assert.doesNotMatch(result.content[0].text, /TOPSECRET|secret\.example/u);
  }
});

test("a well-formed write-result forwards ONLY modelContent — hostile confirmed data never reaches the model", async () => {
  // round-2 (Decision 3): the confirm response carries modelContent plus a
  // hostile UI envelope (raw ids, audit storage key, nested results,
  // credentials). The bridge forwards ONLY modelContent.
  const hostile = {
    kind: "write-result",
    data: {
      op: "update",
      summary: "ok",
      events: [
        {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          op: "update",
          undoable: true,
        },
      ],
      result: {
        ref: "11111111-1111-4111-8111-111111111111",
        auditId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        stableKey: "airport-a",
        nested: {
          uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          token: "sk-abcdef1234567890",
        },
      },
    },
    modelContent:
      '{"status":"success","action":"save_naming_plan","summary":"已应用命名模板"}',
  };
  const result = await confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: true,
      json: async () => ({ data: hostile }),
    }),
    "save_naming_plan",
  );

  assert.equal(result.isError, undefined);
  assert.equal(
    result.content[0].text,
    '{"status":"success","action":"save_naming_plan","summary":"已应用命名模板"}',
  );
  const text = result.content[0].text;
  assert.doesNotMatch(text, /11111111-1111/u);
  assert.doesNotMatch(text, /aaaaaaaa-aaaa/u);
  assert.doesNotMatch(text, /airport-a/u);
  assert.doesNotMatch(text, /bbbbbbbb-bbbb/u);
  assert.doesNotMatch(text, /sk-abcdef/u);
  assert.doesNotMatch(text, /cccccccc-cccc/u);
});

test("missing/invalid modelContent, wrong kind and malformed JSON return the fixed unknown result", async () => {
  const cases = [
    { kind: "write-result", data: { op: "update", summary: "x" } }, // no modelContent
    {
      kind: "write-result",
      data: { op: "update", summary: "x" },
      modelContent: 42,
    }, // not a string
    {
      kind: "write-result",
      data: { op: "update", summary: "x" },
      modelContent: "",
    }, // empty
    { kind: "read-result", data: { x: 1 }, modelContent: "fine" }, // wrong kind
    "plain string", // not an object
  ];
  for (const data of cases) {
    const result = await confirmHiddenWrite(
      "a".repeat(36),
      async () => ({
        ok: true,
        json: async () => ({ data }),
      }),
      "update_rule",
    );
    assert.equal(result.isError, true, JSON.stringify(data));
    assert.match(result.content[0].text, /result is unknown/u);
    assert.doesNotMatch(
      result.content[0].text,
      /no change was applied|without applying/u,
    );
  }
  // hostile data must never be reflected in the error either
  const hostileData = {
    kind: "write-result",
    data: { auditId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  };
  const hostile = await confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: true,
      json: async () => ({ data: hostileData }),
    }),
    "update_rule",
  );
  assert.doesNotMatch(hostile.content[0].text, /aaaaaaaa-aaaa/u);
});

test("round-3: non-canonical modelContent JSON never succeeds — garbage/null/array/wrong keys/status/action/nested/unsafe summary", async () => {
  const wrap = (modelContent) =>
    confirmHiddenWrite(
      "a".repeat(36),
      async () => ({
        ok: true,
        json: async () => ({
          data: { kind: "write-result", data: {}, modelContent },
        }),
      }),
      "update_rule",
    );
  const bad = [
    "nonempty garbage",
    "null",
    "[1,2,3]",
    '{"status":"failure","action":"update_rule","summary":"x"}',
    '{"status":"success","action":"other_action","summary":"x"}',
    '{"status":"success","action":"update_rule"}',
    '{"status":"success","action":"update_rule","summary":"x","extra":1}',
    '{"status":"success","action":"update_rule","summary":{"nested":1}}',
    '{"status":"success","action":"update_rule","summary":""}',
    '{"status":"success","action":"update_rule","summary":"https://evil.example/x?k=v"}',
    '{"status":"success","action":"update_rule","summary":"' +
      "x".repeat(600) +
      '"}',
  ];
  for (const mc of bad) {
    const result = await wrap(mc);
    assert.equal(result.isError, true, mc);
    assert.match(result.content[0].text, /result is unknown/u);
    assert.doesNotMatch(result.content[0].text, /update_rule/u);
  }
  const ok = await wrap(
    '{"status":"success","action":"update_rule","summary":"x"}',
  );
  assert.equal(ok.isError, undefined);
  assert.equal(
    ok.content[0].text,
    '{"status":"success","action":"update_rule","summary":"x"}',
  );
  // round-6 exact wire: whitespace forms are NOT canonical — the only
  // accepted byte string is JSON.stringify({status,action,summary})
  const spaced = await wrap(
    '{ "status": "success", "action": "update_rule", "summary": "x" }',
  );
  assert.equal(spaced.isError, true);
  assert.match(spaced.content[0].text, /result is unknown/u);
});

test("round-3: gatePendingWrite requires pending action === originating tool; a mismatch is unknown, never a forwarded success", async () => {
  let confirms = 0;
  const gate = (originatingTool) =>
    gatePendingWrite(
      fakeServer({ action: "accept", content: { confirm: true } }),
      { ...ENVELOPE, data: { ...ENVELOPE.data, action: "update_rule" } },
      "default",
      async (token, expectedAction) => {
        confirms += 1;
        assert.equal(expectedAction, "update_rule");
        return {
          content: [
            {
              type: "text",
              text: '{"status":"success","action":"update_rule","summary":"x"}',
            },
          ],
        };
      },
      originatingTool,
    );
  const mismatch = await gate("other_tool");
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content[0].text, /result is unknown/u);
  assert.equal(confirms, 0);
  const ok = await gate("update_rule");
  assert.equal(ok.isError, undefined);
  assert.equal(confirms, 1);
});

test("round-4: credential-only and residue-only summaries never succeed, never reflect", async () => {
  const wrap = (summary) =>
    confirmHiddenWrite(
      "a".repeat(36),
      async () => ({
        ok: true,
        json: async () => ({
          data: {
            kind: "write-result",
            data: { op: "update", summary: "ok", events: [] },
            modelContent: JSON.stringify({
              status: "success",
              action: "update_rule",
              summary,
            }),
          },
        }),
      }),
      "update_rule",
    );
  const hostile = [
    "Bearer FAKE_TOKEN_0001",
    "sk-FAKE_EXAMPLE_0001",
    "https://fixture:FAKE_PASSWORD@example.invalid/path?token=FAKE_TOKEN",
    "00000000-0000-4000-8000-000000000000",
    "token=FAKE_PLACEHOLDER",
    "Bearer",
    "sk-",
    "redacted",
    "[REDACTED]",
    "https:",
    "://",
    "eyJFAKE.eyJFAKE.eyJFAKE",
  ];
  for (const summary of hostile) {
    const result = await wrap(summary);
    assert.equal(result.isError, true, summary);
    assert.match(result.content[0].text, /result is unknown/u);
    assert.doesNotMatch(
      result.content[0].text,
      /FAKE_TOKEN|FAKE_PASSWORD|FAKE_EXAMPLE|FAKE_PLACEHOLDER|00000000-0000/u,
    );
    assert.doesNotMatch(result.content[0].text, /update_rule/u);
  }
  // unsanitized MIXED injection must also fail (the summary is not canonical)
  const mixed = await wrap("Updated node Bearer FAKE_TOKEN_0001");
  assert.equal(mixed.isError, true);
  assert.match(mixed.content[0].text, /result is unknown/u);
  // the Web-produced ALREADY-SANITIZED mixed result passes unchanged
  const safe = await wrap("Updated node");
  assert.equal(safe.isError, undefined);
  assert.equal(
    safe.content[0].text,
    '{"status":"success","action":"update_rule","summary":"Updated node"}',
  );
});

test("round-5: committed-bundle boundary — already-canonical safe-mixed modelContent passes unchanged; hostile canonical-shaped JSON fails", async () => {
  // The committed bundle is self-contained (SDK inlined) — import it and
  // drive confirmHiddenWrite exactly like the bridge does at runtime.
  // NOTE: this plugin-staging test does NOT claim the JSON came from the Web
  // producer; the real producer-to-bundle flow is covered by the Web Vitest
  // (web/tests/ai/writeResultProjection.test.ts) which calls the ACTUAL
  // projectWriteResult and feeds its returned modelContent through this
  // same committed bundle by file URL.
  const bundle = await import("./dist/proxymanager-mcp.bundle.mjs");
  // an already-canonical safe-mixed summary produced by the Web receipt
  // canonicalization ('Updated node <hostile span>' → 'Updated node')
  const webModelContent = JSON.stringify({
    status: "success",
    action: "save_naming_plan",
    summary: "Updated node",
  });
  const result = await bundle.confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: true,
      json: async () => ({
        data: {
          kind: "write-result",
          data: { op: "update", summary: "Updated node", events: [] },
          modelContent: webModelContent,
        },
      }),
    }),
    "save_naming_plan",
  );
  assert.equal(result.isError, undefined);
  assert.equal(
    result.content[0].text,
    '{"status":"success","action":"save_naming_plan","summary":"Updated node"}',
  );
  // hostile injection through the bundle boundary fails with no reflection —
  // both the long form and the round-5 short/Authorization/sk forms
  for (const summary of [
    "Updated node Bearer FAKE_TOKEN_0001",
    "Updated node Bearer abc",
    "Updated node Basic a",
    "Updated node Token abc",
    "Updated node sk-FAKE",
    "Updated node sk-a",
    "Updated node op: sk-fake",
    "Updated node Authorization: Bearer FAKE_TOKEN_0001",
  ]) {
    const hostile = await bundle.confirmHiddenWrite(
      "a".repeat(36),
      async () => ({
        ok: true,
        json: async () => ({
          data: {
            kind: "write-result",
            data: { op: "update", summary: "ok", events: [] },
            modelContent: JSON.stringify({
              status: "success",
              action: "save_naming_plan",
              summary,
            }),
          },
        }),
      }),
      "save_naming_plan",
    );
    assert.equal(hostile.isError, true, summary);
    assert.match(hostile.content[0].text, /result is unknown/u);
    assert.doesNotMatch(
      hostile.content[0].text,
      /FAKE_TOKEN|Bearer|Basic|Token|sk-|update_rule|save_naming_plan/u,
    );
  }
});

test("round-5: MCP source mirror rejects every short/Authorization/sk credential summary with fixed unknown, no reflection", async () => {
  const wrap = (summary) =>
    confirmHiddenWrite(
      "a".repeat(36),
      async () => ({
        ok: true,
        json: async () => ({
          data: {
            kind: "write-result",
            data: { op: "update", summary: "ok", events: [] },
            modelContent: JSON.stringify({
              status: "success",
              action: "update_rule",
              summary,
            }),
          },
        }),
      }),
      "update_rule",
    );
  const hostile = [
    "Authorization: Bearer FAKE_TOKEN_0001",
    "Bearer a",
    "Bearer abc",
    "Basic a",
    "Basic abc",
    "Token a",
    "Token abc",
    "Bearer",
    "Basic",
    "Token",
    "sk-",
    "sk-a",
    "sk-abc",
    "sk-FAKE",
    "op: sk-fake",
    "op:",
  ];
  for (const summary of hostile) {
    const result = await wrap(summary);
    assert.equal(result.isError, true, summary);
    assert.match(result.content[0].text, /result is unknown/u);
    assert.doesNotMatch(
      result.content[0].text,
      /FAKE_TOKEN|Bearer|Basic|Token|sk-|update_rule/u,
    );
  }
  // unsanitized MIXED injection with a SHORT payload must also fail
  const mixed = await wrap("Updated node Bearer abc");
  assert.equal(mixed.isError, true);
  assert.match(mixed.content[0].text, /result is unknown/u);
  assert.doesNotMatch(mixed.content[0].text, /Bearer/u);
  // the exact already-canonical safe producer JSON passes unchanged
  const safe = await wrap("Updated node");
  assert.equal(safe.isError, undefined);
  assert.equal(
    safe.content[0].text,
    '{"status":"success","action":"update_rule","summary":"Updated node"}',
  );
  // overlong raw modelContent is rejected before JSON parsing
  const overlong = await confirmHiddenWrite(
    "a".repeat(36),
    async () => ({
      ok: true,
      json: async () => ({
        data: {
          kind: "write-result",
          data: { op: "update", summary: "ok", events: [] },
          modelContent:
            '{"status":"success","action":"update_rule","summary":"' +
            "x".repeat(2100) +
            '"}',
        },
      }),
    }),
    "update_rule",
  );
  assert.equal(overlong.isError, true);
  assert.match(overlong.content[0].text, /result is unknown/u);
});

/* ─── independent 588-case receipt matrix (literal oracle) ────────────
 * The cases and expectations live in testdata/receipt-security-matrix.json
 * and are AUTHORED from the receipt policy spec — never computed with a
 * production sanitizer. This block proves:
 *   - MCP source verifier matches the literal oracle 588/588;
 *   - source and committed bundle are byte-behavior identical 588/588;
 *   - every raw summary Web changes/rejects is rejected;
 *   - every Web canonical receipt is accepted unchanged.              */

import { readFileSync } from "node:fs";

const MATRIX = JSON.parse(
  readFileSync(
    new URL("./testdata/receipt-security-matrix.json", import.meta.url),
    "utf8",
  ),
);
const ACTION = "update_rule";
const matrixFetch = (modelContent) => async () => ({
  ok: true,
  json: async () => ({
    data: {
      kind: "write-result",
      data: { op: "update", summary: "ok", events: [] },
      modelContent,
    },
  }),
});

test("588-case matrix: source verifier matches the literal oracle and the Web-change-or-reject relation", async () => {
  assert.equal(MATRIX.cases.length, 588);
  for (const c of MATRIX.cases) {
    const raw = JSON.stringify({
      status: "success",
      action: ACTION,
      summary: c.summary,
    });
    const rawResult = await confirmHiddenWrite(
      "a".repeat(36),
      matrixFetch(raw),
      ACTION,
    );
    assert.equal(
      Boolean(rawResult.isError),
      c.mcpRawReject,
      `${c.id} ${c.category} raw mcpReject=${c.mcpRawReject} summary=${JSON.stringify(c.summary)}`,
    );
    // the relation invariant encoded in the literal oracle
    assert.equal(
      c.mcpRawReject === (c.web !== "ok" || c.canonicalSummary !== c.summary),
      true,
      `${c.id} relation data inconsistency`,
    );
    if (c.web === "ok") {
      const canonical = JSON.stringify({
        status: "success",
        action: ACTION,
        summary: c.canonicalSummary,
      });
      const okResult = await confirmHiddenWrite(
        "a".repeat(36),
        matrixFetch(canonical),
        ACTION,
      );
      assert.equal(okResult.isError, undefined, `${c.id} canonical accept`);
      assert.equal(
        okResult.content[0].text,
        canonical,
        `${c.id} canonical echo`,
      );
    }
  }
});

test("588-case matrix: source and committed bundle are byte-behavior identical", async () => {
  const bundle = await import("./dist/proxymanager-mcp.bundle.mjs");
  for (const c of MATRIX.cases) {
    const raw = JSON.stringify({
      status: "success",
      action: ACTION,
      summary: c.summary,
    });
    const [src, bundled] = await Promise.all([
      confirmHiddenWrite("a".repeat(36), matrixFetch(raw), ACTION),
      bundle.confirmHiddenWrite("a".repeat(36), matrixFetch(raw), ACTION),
    ]);
    assert.deepEqual(bundled, src, `${c.id} source/bundle raw divergence`);
    if (c.web === "ok") {
      const canonical = JSON.stringify({
        status: "success",
        action: ACTION,
        summary: c.canonicalSummary,
      });
      const [srcOk, bundledOk] = await Promise.all([
        confirmHiddenWrite("a".repeat(36), matrixFetch(canonical), ACTION),
        bundle.confirmHiddenWrite(
          "a".repeat(36),
          matrixFetch(canonical),
          ACTION,
        ),
      ]);
      assert.deepEqual(
        bundledOk,
        srcOk,
        `${c.id} source/bundle canonical divergence`,
      );
    }
  }
});

test("exact canonical wire: exactly one byte string is accepted; whitespace/reorder/duplicate/escape/extra/missing/wrong-action all fail", async () => {
  const exact =
    '{"status":"success","action":"update_rule","summary":"Updated node"}';
  const ok = await confirmHiddenWrite(
    "a".repeat(36),
    matrixFetch(exact),
    "update_rule",
  );
  assert.equal(ok.isError, undefined);
  assert.equal(ok.content[0].text, exact);
  const bad = [
    '{ "status": "success", "action": "update_rule", "summary": "Updated node" }', // whitespace
    '{"status":"success","action":"update_rule","summary":"Updated node"}\n', // trailing newline
    '{"action":"update_rule","status":"success","summary":"Updated node"}', // reordered keys
    '{"status":"success","action":"update_rule","summary":"Updated node","summary":"Updated node"}', // duplicate key
    '{"status":"success","action":"update_rule","summary":"Updated \\u006Eode"}', // escaped text
    '{"status":"success","action":"update_rule","summary":"Updated node","extra":1}', // extra key
    '{"status":"success","action":"update_rule"}', // missing summary
    '{"status":"success","action":"other","summary":"Updated node"}', // wrong action
    '{"status":"failure","action":"update_rule","summary":"Updated node"}', // wrong status
    '{"status":"success","action":"update_rule","summary":"Updated node","summary":"other"}', // duplicate with different value
    ' \t{"status":"success","action":"update_rule","summary":"Updated node"}', // leading whitespace
  ];
  for (const mc of bad) {
    const result = await confirmHiddenWrite(
      "a".repeat(36),
      matrixFetch(mc),
      "update_rule",
    );
    assert.equal(result.isError, true, mc);
    assert.match(result.content[0].text, /result is unknown/u);
  }
});
