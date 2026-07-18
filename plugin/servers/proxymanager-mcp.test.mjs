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
  );
  const unchecked = await gatePendingWrite(
    fakeServer({ action: "accept", content: { confirm: false } }),
    ENVELOPE,
    "default",
    confirm,
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
      async (token) => {
        seen.push(token);
        return { content: [{ type: "text", text: '{"applied":true}' }] };
      },
    );

    assert.deepEqual(seen, ["a".repeat(36)]);
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
    const result = await gatePendingWrite(server, ENVELOPE, "default", async () => {
      confirms += 1;
    });

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
    );

    assert.equal(elicited, 0);
    assert.equal(confirms, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /too large to display completely/u);
  }
});

test("unknown confirmation outcomes never claim no change or reflect server secrets", async () => {
  const network = await confirmHiddenWrite("a".repeat(36), async () => {
    throw new Error("socket closed after commit");
  });
  const rejected = await confirmHiddenWrite("a".repeat(36), async () => ({
    ok: false,
    json: async () => ({
      detail: "invalid https://secret.example/token=TOPSECRET123456789",
    }),
  }));
  const malformed = await confirmHiddenWrite("a".repeat(36), async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError("truncated json");
    },
  }));
  const missingData = await confirmHiddenWrite("a".repeat(36), async () => ({
    ok: true,
    json: async () => ({}),
  }));

  for (const result of [network, rejected, malformed, missingData]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /result is unknown/u);
    assert.match(result.content[0].text, /Do not retry automatically/u);
    assert.doesNotMatch(result.content[0].text, /without applying|no change/u);
    assert.doesNotMatch(result.content[0].text, /TOPSECRET|secret\.example/u);
  }
});

test("a well-formed write-result is the only confirmed success shape", async () => {
  const result = await confirmHiddenWrite("a".repeat(36), async () => ({
    ok: true,
    json: async () => ({
      data: { kind: "write-result", data: { applied: true } },
    }),
  }));

  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /write-result/u);
});
