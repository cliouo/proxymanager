import { describe, expect, it, vi } from 'vitest';
import {
  DNR_USER_AGENT_RULE_ID,
  buildUserAgentSessionRule,
  escapeDnrRegex,
  fetchHopWithRedirectObserver,
  refreshSubscriptionLocally,
  registerSubscriptionRefreshLifecycleCleanup,
  SubscriptionRefreshPhaseError,
  type SubscriptionRefreshDependencies,
} from '../../../extension/lib/subscription-refresh';
import {
  BridgeSafeError,
  LocalRefreshActivationGate,
  assertBridgeSenderOrigin,
  projectBridgeResult,
  sendBridgeBackgroundRequest,
  shouldSilenceBridgeReply,
  type BridgeSender,
} from '../../../extension/lib/subscription-bridge';
import type { Settings } from '../../../extension/lib/settings';
import { BackendError } from '../../../extension/lib/backend';

const ID = '11111111-1111-4111-8111-111111111111';
const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const SETTINGS = {
  backendUrl: 'https://pm.example/app',
  adminKey: 'sentinel-admin',
  clashUrl: '',
  clashSecret: '',
  candidateGroups: [],
  defaultAnchor: 'manual',
  defaultRuleType: 'DOMAIN-SUFFIX',
  speedtestTimeoutMs: 5000,
  autoReloadClash: true,
} as Settings;
const SPEC = {
  subscriptionId: ID,
  url: 'https://upstream.example/sub?x=1.2',
  userAgent: 'Custom UA',
  customHeaders: { 'X-Secret': 'sentinel-header' },
  updatedAt: 7,
  fetchIdentityRevision: 3,
};

function dependencies(
  over: Partial<SubscriptionRefreshDependencies> = {},
): SubscriptionRefreshDependencies {
  return {
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    getSpec: vi.fn(async () => SPEC),
    upload: vi.fn(async () => ({ proxyCount: 1, updatedAt: 8 })),
    fetchImpl: vi.fn(async () => new Response('proxies: []\n', { status: 200 })),
    updateSessionRules: vi.fn(async () => undefined),
    ...over,
  };
}

describe('trusted subscription bridge', () => {
  it('requires a trusted, fresh, id-matched, single-use activation', () => {
    let now = 100;
    const gate = new LocalRefreshActivationGate(() => now);
    gate.arm(ID, false);
    expect(gate.consume(ID)).toBe(false);
    gate.arm(ID, true);
    expect(gate.consume('22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(gate.consume(ID)).toBe(false);
    gate.arm(ID, true);
    expect(gate.consume(ID)).toBe(true);
    expect(gate.consume(ID)).toBe(false);
    gate.arm(ID, true);
    now += 10_001;
    expect(gate.consume(ID)).toBe(false);
  });

  it('requires sender tab, extension id and the exact configured/page/sender origin triple', () => {
    const sender: BridgeSender = {
      id: 'abcdefghijklmnopabcdefghijklmnop',
      url: 'https://pm.example/subscriptions',
      origin: 'https://pm.example',
      tab: { id: 4 },
    };
    expect(() =>
      assertBridgeSenderOrigin(
        SETTINGS,
        'https://pm.example',
        sender,
        'abcdefghijklmnopabcdefghijklmnop',
      ),
    ).not.toThrow();
    for (const hostile of [
      { ...sender, id: 'other' },
      { ...sender, url: 'https://evil.example/' },
      { ...sender, tab: undefined },
      { ...sender, origin: undefined },
    ]) {
      expect(() =>
        assertBridgeSenderOrigin(
          SETTINGS,
          'https://pm.example',
          hostile,
          'abcdefghijklmnopabcdefghijklmnop',
        ),
      ).toThrow();
    }
  });

  it('projects exfiltration-shaped background data to the exact safe receipt', () => {
    expect(
      projectBridgeResult('refresh', {
        proxyCount: 2,
        updatedAt: 9,
        raw: 'sentinel-raw',
        url: 'https://sentinel.example',
        customHeaders: { Authorization: 'sentinel-header' },
        adminKey: 'sentinel-admin',
      }),
    ).toEqual({ proxyCount: 2, updatedAt: 9 });
  });

  it('silences origin mismatch replies so unrelated pages cannot detect the extension', () => {
    expect(shouldSilenceBridgeReply(new BridgeSafeError('origin-mismatch'))).toBe(true);
    expect(shouldSilenceBridgeReply(new BridgeSafeError('extension-not-configured'))).toBe(false);
    expect(shouldSilenceBridgeReply(new Error('origin-mismatch'))).toBe(false);
  });
});

it('preserves only explicit safe background failures and makes transport loss ambiguous', async () => {
  const explicit = await sendBridgeBackgroundRequest(
    { type: 'subscriptionBridgeStatus', pageOrigin: 'https://pm.example' },
    vi.fn(async () => ({ ok: false, error: 'fetch-failed' })),
  ).catch((caught) => caught);
  expect(explicit).toMatchObject({ code: 'fetch-failed' });

  const rejected = await sendBridgeBackgroundRequest(
    { type: 'subscriptionBridgeStatus', pageOrigin: 'https://pm.example' },
    vi.fn(async () => {
      throw new Error('sentinel-message-port');
    }),
  ).catch((caught) => caught);
  expect(rejected).toBeInstanceOf(BridgeSafeError);
  expect(rejected).toMatchObject({ code: 'outcome-ambiguous' });
  expect(String(rejected)).not.toContain('sentinel');
});

it.each([
  null,
  { ok: false, error: 'sentinel-unknown' },
  { ok: true },
  { ok: 'yes', data: { ready: true } },
])('maps malformed background envelope %# to fixed ambiguity', async (response) => {
  const error = await sendBridgeBackgroundRequest(
    { type: 'subscriptionBridgeStatus', pageOrigin: 'https://pm.example' },
    vi.fn(async () => response),
  ).catch((caught) => caught);
  expect(error).toMatchObject({ code: 'outcome-ambiguous' });
  expect(String(error)).not.toContain('sentinel');
});

describe('Chromium subscription refresh core', () => {
  it('builds one deterministic exact-URL UA session rule', () => {
    expect(DNR_USER_AGENT_RULE_ID).toBe(19120417);
    expect(escapeDnrRegex(SPEC.url)).toBe('https://upstream\\.example/sub\\?x=1\\.2');
    expect(
      buildUserAgentSessionRule(SPEC.url, SPEC.userAgent, 'abcdefghijklmnopabcdefghijklmnop'),
    ).toEqual({
      id: DNR_USER_AGENT_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'User-Agent', operation: 'set', value: 'Custom UA' }],
      },
      condition: {
        regexFilter: '^https://upstream\\.example/sub\\?x=1\\.2$',
        resourceTypes: ['xmlhttprequest'],
        initiatorDomains: ['abcdefghijklmnopabcdefghijklmnop'],
      },
    });
  });

  it.each(['User-Agent', 'user-agent', 'uSeR-aGeNt'])(
    'removes custom %s before fetch while DNR owns the dedicated UA',
    async (headerName) => {
      let requestHeaders: Headers | undefined;
      const updateSessionRules = vi.fn(async () => undefined);
      const deps = dependencies({
        getSpec: vi.fn(async () => ({
          ...SPEC,
          customHeaders: {
            [headerName]: 'sentinel-ignored-ua',
            'X-Test': 'retained',
          },
        })),
        updateSessionRules,
        fetchImpl: vi.fn(async (_input, init) => {
          requestHeaders = new Headers(init?.headers);
          return new Response('proxies: []\n', { status: 200 });
        }),
      });

      await refreshSubscriptionLocally(SETTINGS, ID, deps);
      expect(requestHeaders?.has('user-agent')).toBe(false);
      expect(requestHeaders?.get('x-test')).toBe('retained');
      expect(updateSessionRules).toHaveBeenCalledWith(
        expect.objectContaining({
          addRules: [
            expect.objectContaining({
              action: expect.objectContaining({
                requestHeaders: [{ header: 'User-Agent', operation: 'set', value: SPEC.userAgent }],
              }),
            }),
          ],
        }),
      );
    },
  );

  it('serializes refreshes globally and cleans the DNR rule before, after and between redirects', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstFetch = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const deps = dependencies({
      fetchImpl: vi.fn(async (input) => {
        calls += 1;
        events.push(`fetch:${String(input)}`);
        if (calls === 1) await firstFetch;
        return new Response('proxies: []\n', { status: 200 });
      }),
      updateSessionRules: vi.fn(async ({ removeRuleIds, addRules }) => {
        events.push(`dnr:${removeRuleIds.join(',')}:${addRules?.length ?? 0}`);
      }),
    });
    const first = refreshSubscriptionLocally(SETTINGS, ID, deps);
    const second = refreshSubscriptionLocally(SETTINGS, ID, deps);
    await vi.waitFor(() =>
      expect(events.filter((event) => event.startsWith('fetch:'))).toHaveLength(1),
    );
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events.filter((event) => event.startsWith('fetch:'))).toHaveLength(2);
    expect(events.at(0)).toBe(`dnr:${DNR_USER_AGENT_RULE_ID}:0`);
    expect(events.at(-1)).toBe(`dnr:${DNR_USER_AGENT_RULE_ID}:0`);
  });

  it('rejects an origin-changing redirect before a second request and always cleans up', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const updateSessionRules = vi.fn(async () => undefined);
    const deps = dependencies({
      updateSessionRules,
      fetchImpl: vi.fn(async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        if (seen.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://other.example/next' },
          });
        }
        return new Response('proxies: []\n', { status: 200 });
      }),
    });
    const error = await refreshSubscriptionLocally(SETTINGS, ID, deps).catch((caught) => caught);
    expect(error).toMatchObject({ phase: 'definite-pre-upload' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get('X-Secret')).toBe('sentinel-header');
    expect(updateSessionRules).toHaveBeenLastCalledWith({
      removeRuleIds: [DNR_USER_AGENT_RULE_ID],
    });
  });

  it('follows bounded same-origin redirects and retains configured headers', async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const deps = dependencies({
      fetchImpl: vi.fn(async (input, init) => {
        seen.push({ url: String(input), headers: new Headers(init?.headers) });
        if (seen.length === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: '/next' },
          });
        }
        return new Response('proxies: []\n', { status: 200 });
      }),
    });
    await expect(refreshSubscriptionLocally(SETTINGS, ID, deps)).resolves.toMatchObject({
      proxyCount: 1,
    });
    expect(seen.map(({ url }) => url)).toEqual([
      SPEC.url,
      'https://upstream.example/next',
    ]);
    expect(seen[1]?.headers.get('X-Secret')).toBe('sentinel-header');
  });

  it('correlates Chromium opaque redirects through the exact extension request id', async () => {
    type Details = {
      requestId: string;
      url: string;
      type: string;
      initiator?: string;
      statusCode?: number;
      responseHeaders?: Array<{ name: string; value?: string }>;
    };
    function event() {
      const listeners = new Set<(details: Details) => void>();
      return {
        addListener(listener: (details: Details) => void) {
          listeners.add(listener);
        },
        removeListener(listener: (details: Details) => void) {
          listeners.delete(listener);
        },
        emit(details: Details) {
          for (const listener of listeners) listener(details);
        },
        size() {
          return listeners.size;
        },
      };
    }
    const onBeforeRequest = event();
    const onHeadersReceived = event();
    const fetchImpl = vi.fn(async (url: string) => {
      onBeforeRequest.emit({
        requestId: 'request-1',
        url,
        type: 'xmlhttprequest',
        initiator: `chrome-extension://${EXTENSION_ID}`,
      });
      onHeadersReceived.emit({
        requestId: 'hostile-request',
        url,
        type: 'xmlhttprequest',
        statusCode: 302,
        responseHeaders: [{ name: 'Location', value: 'https://evil.example/sub' }],
      });
      onHeadersReceived.emit({
        requestId: 'request-1',
        url,
        type: 'xmlhttprequest',
        statusCode: 302,
        responseHeaders: [{ name: 'location', value: 'https://next.example/sub' }],
      });
      return { type: 'opaqueredirect', status: 0 } as Response;
    }) as unknown as typeof fetch;

    await expect(
      fetchHopWithRedirectObserver(SPEC.url, { redirect: 'manual' }, EXTENSION_ID, fetchImpl, {
        onBeforeRequest,
        onHeadersReceived,
      }),
    ).resolves.toMatchObject({ redirectUrl: 'https://next.example/sub' });
    expect(onBeforeRequest.size()).toBe(0);
    expect(onHeadersReceived.size()).toBe(0);
  });

  it.each(['fetch', 'oversize', 'upload'] as const)(
    'cleans the DNR rule on %s failure without leaking secrets',
    async (stage) => {
      const updateSessionRules = vi.fn(async () => undefined);
      const deps = dependencies({
        updateSessionRules,
        fetchImpl: vi.fn(async () => {
          if (stage === 'fetch') throw new TypeError('sentinel-upstream');
          const body = stage === 'oversize' ? new Uint8Array(4 * 1024 * 1024 + 1) : 'proxies: []\n';
          return new Response(body, { status: 200 });
        }),
        upload: vi.fn(async () => {
          if (stage === 'upload') throw new Error('sentinel-backend');
          return { proxyCount: 1, updatedAt: 8 };
        }),
      });
      const error = await refreshSubscriptionLocally(SETTINGS, ID, deps).catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(updateSessionRules).toHaveBeenLastCalledWith({
        removeRuleIds: [DNR_USER_AGENT_RULE_ID],
      });
    },
  );
});

describe('extension refresh failure phases', () => {
  it.each([
    {
      stage: 'fetch',
      dependencies: () =>
        dependencies({
          fetchImpl: vi.fn(async () => {
            throw new TypeError('sentinel-fetch-detail');
          }),
        }),
      phase: 'definite-pre-upload',
      code: 'fetch-failed',
    },
    {
      stage: 'upload',
      dependencies: () =>
        dependencies({
          upload: vi.fn(async () => {
            throw new Error('sentinel-upload-detail');
          }),
        }),
      phase: 'ambiguous-or-post-upload',
      code: 'upload-failed',
    },
    {
      stage: 'invalid receipt',
      dependencies: () =>
        dependencies({
          upload: vi.fn(async () => ({ proxyCount: 0, updatedAt: 8 })),
        }),
      phase: 'ambiguous-or-post-upload',
      code: 'upload-failed',
    },
  ] as const)('classifies $stage failures without exposing their cause', async (candidate) => {
    const error = await refreshSubscriptionLocally(SETTINGS, ID, candidate.dependencies()).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(SubscriptionRefreshPhaseError);
    expect(error).toMatchObject({ phase: candidate.phase, message: candidate.code });
    expect(String(error)).not.toContain('sentinel');
  });

  it('classifies cleanup failure after upload as ambiguous and never as fetch-failed', async () => {
    let updateCalls = 0;
    const deps = dependencies({
      updateSessionRules: vi.fn(async () => {
        updateCalls += 1;
        if (updateCalls === 3) throw new Error('sentinel-cleanup-detail');
      }),
    });

    const error = await refreshSubscriptionLocally(SETTINGS, ID, deps).catch((caught) => caught);
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(SubscriptionRefreshPhaseError);
    expect(error).toMatchObject({
      phase: 'ambiguous-or-post-upload',
      message: 'upload-failed',
    });
    expect(String(error)).not.toContain('sentinel');
  });
});

it('preserves a structured backend 412 for concurrent-update mapping', async () => {
  const error = await refreshSubscriptionLocally(
    SETTINGS,
    ID,
    dependencies({
      upload: vi.fn(async () => {
        throw new BackendError('sentinel-conflict-detail', 412);
      }),
    }),
  ).catch((caught) => caught);

  expect(error).toBeInstanceOf(BackendError);
  expect(error).toMatchObject({ status: 412 });
});

describe('subscription refresh lifecycle cleanup', () => {
  it('cleans the reserved DNR rule on startup and install while clearing transient state', async () => {
    let startupListener: (() => void) | undefined;
    let installedListener: (() => void) | undefined;
    const clearTransientState = vi.fn();
    const cleanup = vi.fn(async () => undefined);

    registerSubscriptionRefreshLifecycleCleanup(
      (listener) => {
        startupListener = listener;
      },
      (listener) => {
        installedListener = listener;
      },
      clearTransientState,
      cleanup,
    );

    startupListener?.();
    installedListener?.();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(2));
    expect(clearTransientState).toHaveBeenCalledTimes(2);
  });

  it('contains startup cleanup rejection', async () => {
    let startupListener: (() => void) | undefined;
    const cleanup = vi.fn(async () => {
      throw new Error('sentinel-cleanup-detail');
    });

    registerSubscriptionRefreshLifecycleCleanup(
      (listener) => {
        startupListener = listener;
      },
      () => undefined,
      () => undefined,
      cleanup,
    );

    expect(() => startupListener?.()).not.toThrow();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
});
