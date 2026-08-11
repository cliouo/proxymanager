import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientApi = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/client/api', () => ({ api: clientApi.api }));

import {
  createAddFormMutationController,
  LocalSubscriptionRefreshError,
  ExtensionSubscriptionRefreshError,
  callSubscriptionBridge,
  checkNativeFetchCompatibility,
  createManualRefreshOperationController,
  fetchSubscriptionNatively,
  refreshSubscriptionFromLocalNetwork,
  uploadManualSubscription,
  type AddFormMutationLease,
  type ManualRefreshOperationKind,
  type ManualRefreshOperationLease,
  type SubscriptionBridgeWindow,
  type SubscriptionLocalFetchSpec,
} from '@/lib/client/subscriptionLocalRefresh';

const ID = '11111111-1111-4111-8111-111111111111';
const UA = 'Browser UA';

function spec(over: Partial<SubscriptionLocalFetchSpec> = {}): SubscriptionLocalFetchSpec {
  return {
    subscriptionId: ID,
    url: 'https://upstream.example/sub',
    userAgent: UA,
    customHeaders: {},
    updatedAt: 7,
    fetchIdentityRevision: 3,
    ...over,
  };
}

function bridgeTarget(
  reply?: (request: Record<string, unknown>) => Record<string, unknown>,
  eventMode: 'exact' | 'wrong-origin' | 'wrong-source' = 'exact',
): SubscriptionBridgeWindow {
  let listener: ((event: MessageEvent<unknown>) => void) | undefined;
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  const target: SubscriptionBridgeWindow = {
    location: { origin: 'https://pm.example' },
    addEventListener: (_type, next) => {
      listener = next;
    },
    removeEventListener: (_type, next) => {
      if (listener === next) listener = undefined;
    },
    postMessage: (request) => {
      if (!reply) return;
      queueMicrotask(() => {
        listener?.({
          source: eventMode === 'wrong-source' ? ({} as Window) : target,
          origin: eventMode === 'wrong-origin' ? 'https://evil.example' : target.location.origin,
          data: reply(request as Record<string, unknown>),
        } as unknown as MessageEvent<unknown>);
      });
    },
    setTimeout: (handler) => {
      const timer = ++nextTimer;
      timers.set(timer, handler);
      queueMicrotask(() => {
        queueMicrotask(() => {
          const pending = timers.get(timer);
          if (!pending) return;
          timers.delete(timer);
          pending();
        });
      });
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
    },
  };
  return target;
}

describe('strict page subscription bridge', () => {
  it('accepts only the exact correlated success receipt', async () => {
    const target = bridgeTarget((request) => ({
      channel: 'proxymanager-subscription-bridge-v1',
      source: 'proxymanager-extension',
      requestId: request.requestId,
      ok: true,
      data: { proxyCount: 2, updatedAt: 8 },
    }));

    await expect(
      callSubscriptionBridge('refresh', ID, 60_000, {
        target,
        randomUUID: () => 'request-1',
      }),
    ).resolves.toEqual({ proxyCount: 2, updatedAt: 8 });
  });

  it.each([
    {
      name: 'unknown error',
      reply: (request: Record<string, unknown>) => ({
        channel: 'proxymanager-subscription-bridge-v1',
        source: 'proxymanager-extension',
        requestId: request.requestId,
        ok: false,
        error: 'sentinel-unknown',
      }),
    },
    {
      name: 'malformed receipt',
      reply: (request: Record<string, unknown>) => ({
        channel: 'proxymanager-subscription-bridge-v1',
        source: 'proxymanager-extension',
        requestId: request.requestId,
        ok: true,
        data: { proxyCount: 2, updatedAt: 8, secret: 'sentinel-receipt' },
      }),
    },
  ])('maps a matching $name to a terminal fixed ambiguity', async ({ reply }) => {
    const error = await callSubscriptionBridge('refresh', ID, 60_000, {
      target: bridgeTarget(reply),
      randomUUID: () => 'request-1',
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(ExtensionSubscriptionRefreshError);
    expect(error).toMatchObject({ code: 'outcome-ambiguous' });
    expect(String(error)).not.toContain('sentinel');
  });

  it('classifies a refresh timeout as terminal ambiguity without real time', async () => {
    const error = await callSubscriptionBridge('refresh', ID, 60_000, {
      target: bridgeTarget(),
      randomUUID: () => 'request-1',
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'outcome-ambiguous' });
  });
  it.each(['wrong-origin', 'wrong-source'] as const)(
    'ignores an otherwise matching %s response',
    async (eventMode) => {
      const error = await callSubscriptionBridge('refresh', ID, 60_000, {
        target: bridgeTarget(
          (request) => ({
            channel: 'proxymanager-subscription-bridge-v1',
            source: 'proxymanager-extension',
            requestId: request.requestId,
            ok: true,
            data: { proxyCount: 2, updatedAt: 8 },
          }),
          eventMode,
        ),
        randomUUID: () => 'request-1',
      }).catch((caught) => caught);

      expect(error).toMatchObject({ code: 'outcome-ambiguous' });
    },
  );
});

describe('native subscription fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [spec({ url: 'ftp://upstream.example/sub' }), 'unsupported-url'],
    [spec({ url: 'http://upstream.example/sub' }), 'mixed-content'],
    [spec({ userAgent: 'different' }), 'user-agent-mismatch'],
    [spec({ customHeaders: { Cookie: 'secret' } }), 'forbidden-header'],
    [spec({ customHeaders: { 'Sec-Token': 'secret' } }), 'forbidden-header'],
  ])('rejects incompatible native fetch before network', (candidate, code) => {
    expect(
      checkNativeFetchCompatibility(candidate, {
        pageProtocol: 'https:',
        navigatorUserAgent: UA,
      }),
    ).toBe(code);
  });

  it('rejects Permissions-Policy before native fetch reaches the network', async () => {
    const fetchImpl = vi.fn(async () => new Response('must-not-fetch'));

    await expect(
      fetchSubscriptionNatively(
        spec({ customHeaders: { 'Permissions-Policy': 'geolocation=()' } }),
        {
          fetchImpl,
          pageProtocol: 'https:',
          navigatorUserAgent: UA,
        },
      ),
    ).rejects.toMatchObject({ code: 'forbidden-header' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts browser-settable custom headers and exact UA', () => {
    expect(
      checkNativeFetchCompatibility(spec({ customHeaders: { 'X-Subscription-Token': 'opaque' } }), {
        pageProtocol: 'https:',
        navigatorUserAgent: UA,
      }),
    ).toBeNull();
  });

  it('accepts exactly 4 MiB and fatally decodes UTF-8', async () => {
    const bytes = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { 'Content-Length': String(bytes.byteLength) },
        }),
    );
    await expect(
      fetchSubscriptionNatively(spec(), {
        fetchImpl,
        pageProtocol: 'https:',
        navigatorUserAgent: UA,
      }),
    ).resolves.toHaveLength(bytes.byteLength);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('cancels a chunked 4 MiB plus one response and reports a fixed oversize code', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        controller.enqueue(new Uint8Array([0x61]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await fetchSubscriptionNatively(spec(), {
      fetchImpl: vi.fn(async () => new Response(stream, { status: 200 })),
      pageProtocol: 'https:',
      navigatorUserAgent: UA,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(LocalSubscriptionRefreshError);
    expect(error).toMatchObject({ code: 'response-too-large' });
    expect(cancelled).toBe(true);
  });

  it('maps CORS/network failure and invalid UTF-8 to fixed non-secret codes', async () => {
    const cors = await fetchSubscriptionNatively(spec(), {
      fetchImpl: vi.fn(async () => {
        throw new TypeError('Failed to fetch https://secret.example/?token=sentinel');
      }),
      pageProtocol: 'https:',
      navigatorUserAgent: UA,
    }).catch((caught) => caught);
    expect(cors).toMatchObject({ code: 'native-fetch-failed' });
    expect(String(cors)).not.toContain('sentinel');

    const invalid = await fetchSubscriptionNatively(spec(), {
      fetchImpl: vi.fn(async () => new Response(new Uint8Array([0xc3, 0x28]))),
      pageProtocol: 'https:',
      navigatorUserAgent: UA,
    }).catch((caught) => caught);
    expect(invalid).toMatchObject({ code: 'response-invalid-utf8' });
  });

  it('uploads with both optimistic preconditions and returns only the narrow receipt', async () => {
    clientApi.api.mockResolvedValue({ data: { proxyCount: 2, updatedAt: 8 } });
    await expect(uploadManualSubscription(spec(), 'proxies: []\n')).resolves.toEqual({
      proxyCount: 2,
      updatedAt: 8,
    });
    expect(clientApi.api).toHaveBeenCalledWith(
      `/api/v1/subscriptions/${ID}/manual-refresh`,
      expect.objectContaining({
        method: 'POST',
        body: 'proxies: []\n',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'If-Match': '7',
          'X-Fetch-Identity-Revision': '3',
        },
      }),
    );
  });
});

describe('extension-preferred local refresh fallback', () => {
  function localDependencies(over: Record<string, unknown> = {}) {
    return {
      getSpec: vi.fn(async () => spec()),
      checkCompatibility: vi.fn(() => null),
      fetchNatively: vi.fn(async () => 'proxies: []\n'),
      upload: vi.fn(async () => ({ proxyCount: 2, updatedAt: 8 })),
      ...over,
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it('uses a loaded extension once and does not touch the native path after success', async () => {
    const refreshWithExtension = vi.fn(async () => ({ proxyCount: 3, updatedAt: 9 }));
    const deps = localDependencies();

    await expect(
      refreshSubscriptionFromLocalNetwork(ID, 7, refreshWithExtension, deps),
    ).resolves.toEqual({ proxyCount: 3, updatedAt: 9 });
    expect(refreshWithExtension).toHaveBeenCalledOnce();
    expect(deps.getSpec).not.toHaveBeenCalled();
    expect(deps.fetchNatively).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('falls back once after an explicit pre-upload fetch failure', async () => {
    const refreshWithExtension = vi.fn(async () => {
      throw new ExtensionSubscriptionRefreshError('fetch-failed');
    });
    const deps = localDependencies();

    await expect(
      refreshSubscriptionFromLocalNetwork(ID, 7, refreshWithExtension, deps),
    ).resolves.toEqual({ proxyCount: 2, updatedAt: 8 });
    expect(refreshWithExtension).toHaveBeenCalledOnce();
    expect(deps.getSpec).toHaveBeenCalledOnce();
    expect(deps.fetchNatively).toHaveBeenCalledOnce();
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(deps.upload).toHaveBeenCalledWith(
      expect.objectContaining({ updatedAt: 7 }),
      'proxies: []\n',
    );
  });

  it('uses the native path once when the extension is absent', async () => {
    const deps = localDependencies();

    await expect(refreshSubscriptionFromLocalNetwork(ID, 7, null, deps)).resolves.toEqual({
      proxyCount: 2,
      updatedAt: 8,
    });
    expect(deps.getSpec).toHaveBeenCalledOnce();
    expect(deps.fetchNatively).toHaveBeenCalledOnce();
    expect(deps.upload).toHaveBeenCalledOnce();
  });

  it.each([
    new ExtensionSubscriptionRefreshError('upload-failed'),
    new ExtensionSubscriptionRefreshError('concurrent-update'),
    new ExtensionSubscriptionRefreshError('outcome-ambiguous'),
  ])('does not retry an ambiguous or post-upload extension failure', async (failure) => {
    const refreshWithExtension = vi.fn(async () => {
      throw failure;
    });
    const deps = localDependencies();

    await expect(
      refreshSubscriptionFromLocalNetwork(ID, 7, refreshWithExtension, deps),
    ).rejects.toBe(failure);
    expect(refreshWithExtension).toHaveBeenCalledOnce();
    expect(deps.getSpec).not.toHaveBeenCalled();
    expect(deps.fetchNatively).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('maps an untyped extension rejection to fixed ambiguity and never retries', async () => {
    const deps = localDependencies();
    const error = await refreshSubscriptionFromLocalNetwork(
      ID,
      7,
      vi.fn(async () => {
        throw new Error('sentinel-transport');
      }),
      deps,
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: 'outcome-ambiguous' });
    expect(String(error)).not.toContain('sentinel');
    expect(deps.getSpec).not.toHaveBeenCalled();
    expect(deps.fetchNatively).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('re-reads the spec after extension failure and stops before native fetch when the row changed', async () => {
    const refreshWithExtension = vi.fn(async () => {
      throw new ExtensionSubscriptionRefreshError('extension-not-configured');
    });
    const deps = localDependencies({ getSpec: vi.fn(async () => spec({ updatedAt: 8 })) });

    await expect(
      refreshSubscriptionFromLocalNetwork(ID, 7, refreshWithExtension, deps),
    ).rejects.toThrow('订阅已被修改，请刷新页面后再更新。');
    expect(refreshWithExtension).toHaveBeenCalledOnce();
    expect(deps.getSpec).toHaveBeenCalledOnce();
    expect(deps.fetchNatively).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it('checks native compatibility before network and reports fixed combined guidance', async () => {
    const deps = localDependencies({
      checkCompatibility: vi.fn(() => 'user-agent-mismatch'),
    });
    const error = await refreshSubscriptionFromLocalNetwork(
      ID,
      7,
      vi.fn(async () => {
        throw new ExtensionSubscriptionRefreshError('fetch-failed');
      }),
      deps,
    ).catch((caught) => caught);

    expect(String(error)).toContain('粘贴订阅内容或选择文件');
    expect(deps.checkCompatibility).toHaveBeenCalledOnce();
    expect(deps.fetchNatively).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it.each([
    {
      stage: 'fetch',
      over: { fetchNatively: vi.fn(async () => Promise.reject(new Error('sentinel-native'))) },
      expectedFetches: 1,
      expectedUploads: 0,
    },
    {
      stage: 'upload',
      over: { upload: vi.fn(async () => Promise.reject(new Error('sentinel-upload'))) },
      expectedFetches: 1,
      expectedUploads: 1,
    },
  ])('contains extension plus native $stage details', async (candidate) => {
    const deps = localDependencies(candidate.over);
    const error = await refreshSubscriptionFromLocalNetwork(
      ID,
      7,
      vi.fn(async () => {
        throw new ExtensionSubscriptionRefreshError('fetch-failed');
      }),
      deps,
    ).catch((caught) => caught);

    expect(String(error)).not.toContain('sentinel');
    expect(deps.fetchNatively).toHaveBeenCalledTimes(candidate.expectedFetches);
    expect(deps.upload).toHaveBeenCalledTimes(candidate.expectedUploads);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('manual refresh operation controller', () => {
  it.each(['file-import', 'paste-submit', 'local-refresh'] as const)(
    'publishes %s synchronously and blocks every competing caller until exact finish',
    async (kind: ManualRefreshOperationKind) => {
      const events: string[] = [];
      const listener = vi.fn((lease) => {
        events.push(lease ? `busy:${lease[2]}` : 'idle');
      });
      const controller = createManualRefreshOperationController(listener);
      const completion = deferred<void>();
      const guardedHandlers = Object.fromEntries(
        [
          'tab',
          'keyboard',
          'topbar-button',
          'editor',
          'file-input',
          'file-button',
          'paste-submit',
          'close',
          'edit',
          'refresh',
          'server-auto',
          'toggle',
          'delete',
          'distribution',
          'pipeline',
          'naming',
        ].map((name) => [name, vi.fn()]),
      );
      let operationCalls = 0;
      let finishResult = false;

      const lease = controller.start(ID, kind);
      expect(lease).not.toBeNull();
      expect(lease).toEqual([ID, 1, kind]);
      expect(Object.isFrozen(lease)).toBe(true);
      expect(events).toEqual([`busy:${kind}`]);
      expect(controller.current()).toBe(lease);
      expect(controller.owns(lease!)).toBe(true);
      expect(Object.keys(controller).sort()).toEqual(
        ['current', 'dispose', 'finish', 'owns', 'start'].sort(),
      );

      const operation = (async () => {
        operationCalls += 1;
        await completion.promise;
        finishResult = controller.finish(lease!);
      })();
      expect(operationCalls).toBe(1);
      expect(controller.start('22222222-2222-4222-8222-222222222222', kind)).toBeNull();
      for (const handler of Object.values(guardedHandlers)) {
        if (!controller.current()) handler();
      }
      for (const handler of Object.values(guardedHandlers)) {
        expect(handler).not.toHaveBeenCalled();
      }

      completion.resolve();
      await operation;
      expect(finishResult).toBe(true);
      expect(events).toEqual([`busy:${kind}`, 'idle']);
      expect(listener.mock.calls.filter(([next]) => next === null)).toHaveLength(1);
      expect(controller.current()).toBeNull();
      for (const handler of Object.values(guardedHandlers)) {
        if (!controller.current()) handler();
        expect(handler).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('keeps a later lease owned when stale or repeated tokens finish and detaches on dispose', () => {
    const listener = vi.fn();
    const controller = createManualRefreshOperationController(listener);

    const first = controller.start(ID, 'paste-submit');
    expect(first).not.toBeNull();
    expect(first).toEqual([ID, 1, 'paste-submit']);
    expect(controller.finish(first!)).toBe(true);
    expect(controller.finish(first!)).toBe(false);

    const second = controller.start(ID, 'local-refresh');
    expect(second).not.toBeNull();
    expect(second).toEqual([ID, 2, 'local-refresh']);
    expect(controller.finish(first!)).toBe(false);
    expect(controller.current()).toBe(second);
    expect(controller.owns(second!)).toBe(true);

    const notificationsBeforeDispose = listener.mock.calls.length;
    controller.dispose();
    expect(controller.finish(second!)).toBe(false);
    expect(controller.current()).toBeNull();
    expect(controller.owns(second!)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(notificationsBeforeDispose);
  });

  it.each(['file-import', 'paste-submit', 'local-refresh'] as const)(
    'keeps a pre-opened AddForm blocked through %s ownership and allows one submit after exact release',
    async (kind: ManualRefreshOperationKind) => {
      const effects = {
        validation: vi.fn(),
        pending: vi.fn(),
        create: vi.fn(),
        onAdded: vi.fn(),
        reload: vi.fn(),
      };
      let controllerRef: ReturnType<typeof createManualRefreshOperationController> | null = null;
      const isOperationActive = () => controllerRef?.current() !== null;
      const submit = async () => {
        if (isOperationActive()) return;
        effects.validation();
        effects.pending();
        effects.create();
        effects.onAdded();
        effects.reload();
      };
      const expectEffects = (count: number) => {
        for (const effect of Object.values(effects)) {
          expect(effect).toHaveBeenCalledTimes(count);
        }
      };

      const staleSubmit = submit;
      await staleSubmit();
      expectEffects(0);

      const controller = createManualRefreshOperationController(vi.fn());
      controllerRef = controller;
      const staleKind: ManualRefreshOperationKind =
        kind === 'file-import' ? 'paste-submit' : 'file-import';
      const staleLease = controller.start(ID, staleKind);
      expect(staleLease).not.toBeNull();
      expect(controller.finish(staleLease!)).toBe(true);

      const lease = controller.start(ID, kind);
      expect(lease).not.toBeNull();
      expect(controller.current()).toBe(lease);
      const liveSubmit = submit;
      await liveSubmit();
      await staleSubmit();
      expectEffects(0);

      const forged = Object.freeze([ID, lease![1], kind]) as ManualRefreshOperationLease;
      const wrongKind = Object.freeze([ID, lease![1], staleKind]) as ManualRefreshOperationLease;
      expect(controller.finish(forged)).toBe(false);
      expect(controller.finish(staleLease!)).toBe(false);
      expect(controller.finish(staleLease!)).toBe(false);
      expect(controller.finish(wrongKind)).toBe(false);
      expect(controller.current()).toBe(lease);
      expect(controller.owns(lease!)).toBe(true);
      await liveSubmit();
      await staleSubmit();
      expectEffects(0);

      expect(controller.finish(lease!)).toBe(true);
      expect(controller.finish(lease!)).toBe(false);
      await staleSubmit();
      expectEffects(1);
    },
  );
});

describe('AddForm mutation barrier', () => {
  function controllers() {
    let manualRef: ReturnType<typeof createManualRefreshOperationController> | null =
      createManualRefreshOperationController(vi.fn());
    let addRef: ReturnType<typeof createAddFormMutationController> | null =
      createAddFormMutationController(vi.fn());
    const active = () => manualRef?.current() !== null || addRef?.current() !== null;
    const startManual = (kind: ManualRefreshOperationKind) => {
      if (!manualRef || !addRef || manualRef.current() || addRef.current()) return null;
      return manualRef.start(ID, kind);
    };
    const startAdd = () => {
      if (!manualRef || !addRef || manualRef.current() || addRef.current()) return null;
      return addRef.start();
    };
    const dispose = () => {
      manualRef?.dispose();
      addRef?.dispose();
      manualRef = null;
      addRef = null;
    };
    return {
      active,
      startManual,
      startAdd,
      dispose,
      manual: () => manualRef,
      add: () => addRef,
    };
  }

  it('uses reference-exact AddForm leases and detaches without notification on dispose', () => {
    const listener = vi.fn();
    const controller = createAddFormMutationController(listener);
    const first = controller.start();
    expect(first).toEqual({ sequence: 1 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(controller.start()).toBeNull();
    const forged = Object.freeze({ sequence: 1 }) as AddFormMutationLease;
    expect(controller.finish(forged)).toBe(false);
    expect(controller.owns(first!)).toBe(true);
    expect(controller.finish(first!)).toBe(true);
    expect(controller.finish(first!)).toBe(false);

    const second = controller.start();
    expect(second).toEqual({ sequence: 2 });
    expect(controller.finish(first!)).toBe(false);
    const notifications = listener.mock.calls.length;
    controller.dispose();
    expect(controller.current()).toBeNull();
    expect(controller.finish(second!)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(notifications);
  });

  it.each(['file-import', 'paste-submit', 'local-refresh'] as const)(
    'makes forward and reverse %s ordering mutually exclusive through exact settlement',
    async (kind: ManualRefreshOperationKind) => {
      const forward = controllers();
      const forwardEffects = {
        validation: vi.fn(),
        pending: vi.fn(),
        create: vi.fn(),
        onAdded: vi.fn(),
        close: vi.fn(),
        reload: vi.fn(),
        error: vi.fn(),
        alert: vi.fn(),
      };
      const submitForward = async () => {
        const lease = forward.startAdd();
        if (!lease) return;
        forwardEffects.validation();
        forwardEffects.pending();
        forwardEffects.create();
        forwardEffects.onAdded();
        forwardEffects.close();
        forwardEffects.reload();
        forward.add()!.finish(lease);
      };
      const staleForwardSubmit = submitForward;
      const manualLease = forward.startManual(kind);
      expect(manualLease).not.toBeNull();
      await submitForward();
      await staleForwardSubmit();
      for (const effect of Object.values(forwardEffects)) expect(effect).not.toHaveBeenCalled();
      expect(forward.manual()!.finish(manualLease!)).toBe(true);
      expect(forward.manual()!.finish(manualLease!)).toBe(false);
      await staleForwardSubmit();
      for (const name of [
        'validation',
        'pending',
        'create',
        'onAdded',
        'close',
        'reload',
      ] as const) {
        expect(forwardEffects[name]).toHaveBeenCalledOnce();
      }
      expect(forwardEffects.error).not.toHaveBeenCalled();
      expect(forwardEffects.alert).not.toHaveBeenCalled();
      const nextManual = forward.startManual(kind);
      expect(nextManual).not.toBeNull();
      expect(forward.manual()!.finish(nextManual!)).toBe(true);

      const reverse = controllers();
      const createGate = deferred<void>();
      const reverseEffects = {
        validation: vi.fn(),
        pending: vi.fn(),
        create: vi.fn(),
        onAdded: vi.fn(),
        close: vi.fn(),
        reload: vi.fn(),
        manualOpen: vi.fn(),
        manualStart: vi.fn(),
        manualError: vi.fn(),
        manualAlert: vi.fn(),
      };
      const openManualPanel = () => {
        if (!reverse.active()) reverseEffects.manualOpen();
      };
      const startManualAction = () => {
        if (reverse.active()) return null;
        const lease = reverse.startManual(kind);
        if (lease) reverseEffects.manualStart();
        return lease;
      };
      const submitReverse = async () => {
        const lease = reverse.startAdd();
        if (!lease) return;
        reverseEffects.validation();
        reverseEffects.pending();
        reverseEffects.create();
        await createGate.promise;
        reverseEffects.onAdded();
        reverseEffects.close();
        reverseEffects.reload();
        reverse.add()!.finish(lease);
      };
      const staleOpen = openManualPanel;
      const staleManualStart = startManualAction;
      const pendingCreate = submitReverse();
      expect(reverseEffects.create).toHaveBeenCalledOnce();
      openManualPanel();
      staleOpen();
      expect(startManualAction()).toBeNull();
      expect(staleManualStart()).toBeNull();
      expect(reverseEffects.manualOpen).not.toHaveBeenCalled();
      expect(reverseEffects.manualStart).not.toHaveBeenCalled();
      expect(reverseEffects.manualError).not.toHaveBeenCalled();
      expect(reverseEffects.manualAlert).not.toHaveBeenCalled();
      const activeAdd = reverse.add()!.current()!;
      const forged = Object.freeze({ sequence: activeAdd.sequence }) as AddFormMutationLease;
      expect(reverse.add()!.finish(forged)).toBe(false);
      expect(reverse.add()!.owns(activeAdd)).toBe(true);
      createGate.resolve();
      await pendingCreate;
      expect(reverse.add()!.current()).toBeNull();
      expect(reverseEffects.onAdded).toHaveBeenCalledOnce();
      expect(reverseEffects.close).toHaveBeenCalledOnce();
      expect(reverseEffects.reload).toHaveBeenCalledOnce();
      const releasedManual = startManualAction();
      expect(releasedManual).not.toBeNull();
      expect(reverseEffects.manualStart).toHaveBeenCalledOnce();
      expect(reverse.manual()!.finish(releasedManual!)).toBe(true);
      await submitReverse();
      expect(reverseEffects.create).toHaveBeenCalledTimes(2);
      expect(reverseEffects.onAdded).toHaveBeenCalledTimes(2);
      expect(reverseEffects.close).toHaveBeenCalledTimes(2);
      expect(reverseEffects.reload).toHaveBeenCalledTimes(2);
    },
  );

  it('fails closed on null refs and disposes a pending create without late UI effects', async () => {
    const state = controllers();
    const gate = deferred<void>();
    const effects = { close: vi.fn(), reload: vi.fn(), lateState: vi.fn() };
    const pending = (async () => {
      const lease = state.startAdd();
      expect(lease).not.toBeNull();
      await gate.promise;
      if (!state.add()?.owns(lease!)) return;
      effects.close();
      effects.reload();
      effects.lateState();
    })();
    state.dispose();
    expect(state.active()).toBe(true);
    expect(state.startAdd()).toBeNull();
    expect(state.startManual('local-refresh')).toBeNull();
    gate.resolve();
    await pending;
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('projects one create failure and releases its exact owner once', async () => {
    const state = controllers();
    const effects = { create: vi.fn(), error: vi.fn(), close: vi.fn(), reload: vi.fn() };
    const lease = state.startAdd();
    expect(lease).not.toBeNull();
    try {
      effects.create();
      throw new Error('fixed create failure');
    } catch {
      effects.error();
    } finally {
      expect(state.add()!.finish(lease!)).toBe(true);
      expect(state.add()!.finish(lease!)).toBe(false);
    }
    expect(effects.create).toHaveBeenCalledOnce();
    expect(effects.error).toHaveBeenCalledOnce();
    expect(effects.close).not.toHaveBeenCalled();
    expect(effects.reload).not.toHaveBeenCalled();
    expect(state.active()).toBe(false);
  });
});
