import { api } from '@/lib/client/api';
import {
  MAX_SUBSCRIPTION_CONTENT,
  type ManualSubscriptionRefreshReceipt,
  type SubscriptionLocalFetchSpec,
} from '@/schemas';

export type { SubscriptionLocalFetchSpec } from '@/schemas';

export type LocalSubscriptionRefreshErrorCode =
  | 'unsupported-url'
  | 'mixed-content'
  | 'user-agent-mismatch'
  | 'forbidden-header'
  | 'native-fetch-failed'
  | 'response-http'
  | 'response-too-large'
  | 'response-invalid-utf8'
  | 'response-invalid-receipt';

const MESSAGE_BY_CODE: Record<LocalSubscriptionRefreshErrorCode, string> = {
  'unsupported-url': '当前订阅地址不能由浏览器直接拉取，请使用粘贴或文件导入。',
  'mixed-content': 'HTTPS 页面不能直接访问 HTTP 订阅，请使用扩展、粘贴或文件导入。',
  'user-agent-mismatch': '订阅配置了浏览器无法模拟的 User-Agent，请使用扩展、粘贴或文件导入。',
  'forbidden-header': '订阅包含浏览器不能设置的请求头，请使用扩展、粘贴或文件导入。',
  'native-fetch-failed': '浏览器直连失败（可能被 CORS 或网络策略阻止），仍可粘贴或选择文件。',
  'response-http': '订阅服务返回失败状态，仍可粘贴或选择文件。',
  'response-too-large': '订阅响应超过 4 MiB，已停止读取。',
  'response-invalid-utf8': '订阅响应不是有效的 UTF-8 文本。',
  'response-invalid-receipt': '更新接口没有返回有效结果，请刷新页面后重试。',
};

export class LocalSubscriptionRefreshError extends Error {
  constructor(public readonly code: LocalSubscriptionRefreshErrorCode) {
    super(MESSAGE_BY_CODE[code]);
    this.name = 'LocalSubscriptionRefreshError';
  }
}

export type ExtensionSubscriptionRefreshErrorCode =
  | 'activation-required'
  | 'extension-not-configured'
  | 'origin-mismatch'
  | 'invalid-request'
  | 'fetch-failed'
  | 'upload-failed'
  | 'concurrent-update'
  | 'outcome-ambiguous';

const EXTENSION_MESSAGE_BY_CODE: Record<ExtensionSubscriptionRefreshErrorCode, string> = {
  'activation-required': '请直接点击“从本机拉取”后重试。',
  'extension-not-configured': '扩展尚未配置；仍可使用浏览器直连、粘贴或文件导入。',
  'origin-mismatch': '扩展配置与当前页面不匹配；仍可使用粘贴或文件导入。',
  'invalid-request': '扩展无法处理本次请求；仍可使用浏览器直连、粘贴或文件导入。',
  'fetch-failed': '扩展本地拉取失败；将尝试兼容的浏览器直连。',
  'upload-failed': '扩展可能已开始保存；请刷新页面确认，本次不会自动重试。',
  'concurrent-update': '订阅已被其他操作修改，请刷新后重试。',
  'outcome-ambiguous': '扩展更新结果不确定；请刷新页面确认，本次不会自动重试。',
};

export class ExtensionSubscriptionRefreshError extends Error {
  constructor(public readonly code: ExtensionSubscriptionRefreshErrorCode) {
    super(EXTENSION_MESSAGE_BY_CODE[code]);
    this.name = 'ExtensionSubscriptionRefreshError';
  }
}

const DEFINITE_PRE_UPLOAD_EXTENSION_FAILURES: Readonly<
  Record<ExtensionSubscriptionRefreshErrorCode, boolean>
> = {
  'activation-required': true,
  'extension-not-configured': true,
  'origin-mismatch': true,
  'invalid-request': true,
  'fetch-failed': true,
  'upload-failed': false,
  'concurrent-update': false,
  'outcome-ambiguous': false,
};

type ExtensionNativeFallbackErrorCode = 'native-incompatible' | 'native-failed' | 'upload-failed';

const EXTENSION_NATIVE_FALLBACK_MESSAGES: Record<ExtensionNativeFallbackErrorCode, string> = {
  'native-incompatible': '扩展本地拉取失败，且当前订阅不兼容浏览器直连；请粘贴订阅内容或选择文件。',
  'native-failed': '扩展与浏览器直连均未能拉取订阅；请粘贴订阅内容或选择文件。',
  'upload-failed': '扩展拉取失败，浏览器直连保存也未完成；请刷新后重试或使用粘贴、文件导入。',
};

class ExtensionNativeFallbackError extends Error {
  constructor(code: ExtensionNativeFallbackErrorCode) {
    super(EXTENSION_NATIVE_FALLBACK_MESSAGES[code]);
    this.name = 'ExtensionNativeFallbackError';
  }
}

const SUBSCRIPTION_BRIDGE_CHANNEL = 'proxymanager-subscription-bridge-v1' as const;

function isExtensionBridgeErrorCode(
  value: unknown,
): value is ExtensionSubscriptionRefreshErrorCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(EXTENSION_MESSAGE_BY_CODE, value)
  );
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function projectPageBridgeData(
  type: 'probe' | 'refresh',
  value: unknown,
): { ready: boolean } | { proxyCount: number; updatedAt: number } {
  if (type === 'probe') {
    if (!hasExactKeys(value, ['ready']) || typeof value.ready !== 'boolean') {
      throw new ExtensionSubscriptionRefreshError('outcome-ambiguous');
    }
    return { ready: value.ready };
  }
  if (
    !hasExactKeys(value, ['proxyCount', 'updatedAt']) ||
    !Number.isInteger(value.proxyCount) ||
    Number(value.proxyCount) < 1 ||
    !Number.isInteger(value.updatedAt) ||
    Number(value.updatedAt) < 0
  ) {
    throw new ExtensionSubscriptionRefreshError('outcome-ambiguous');
  }
  return {
    proxyCount: Number(value.proxyCount),
    updatedAt: Number(value.updatedAt),
  };
}

export interface SubscriptionBridgeWindow {
  readonly location: { origin: string };
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(timer: number): void;
}

interface SubscriptionBridgeDependencies {
  target?: SubscriptionBridgeWindow;
  randomUUID?: () => string;
}

export function callSubscriptionBridge(
  type: 'probe',
  subscriptionId?: undefined,
  timeoutMs?: number,
  dependencies?: SubscriptionBridgeDependencies,
): Promise<{ ready: boolean }>;
export function callSubscriptionBridge(
  type: 'refresh',
  subscriptionId: string,
  timeoutMs?: number,
  dependencies?: SubscriptionBridgeDependencies,
): Promise<{ proxyCount: number; updatedAt: number }>;
export function callSubscriptionBridge(
  type: 'probe' | 'refresh',
  subscriptionId?: string,
  timeoutMs = 1_200,
  dependencies: SubscriptionBridgeDependencies = {},
): Promise<{ ready: boolean } | { proxyCount: number; updatedAt: number }> {
  const target = dependencies.target ?? (window as unknown as SubscriptionBridgeWindow);
  const requestId = (dependencies.randomUUID ?? (() => crypto.randomUUID()))();

  return new Promise((resolve, reject) => {
    const finish = (
      result:
        | { ok: true; data: { ready: boolean } | { proxyCount: number; updatedAt: number } }
        | { ok: false; error: ExtensionSubscriptionRefreshError },
    ) => {
      target.clearTimeout(timer);
      target.removeEventListener('message', onMessage);
      if (result.ok) resolve(result.data);
      else reject(result.error);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== target || event.origin !== target.location.origin) return;
      const message = event.data;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const candidate = message as Record<string, unknown>;
      if (
        candidate.channel !== SUBSCRIPTION_BRIDGE_CHANNEL ||
        candidate.source !== 'proxymanager-extension' ||
        candidate.requestId !== requestId
      ) {
        return;
      }
      if (
        candidate.ok === true &&
        hasExactKeys(candidate, ['channel', 'source', 'requestId', 'ok', 'data'])
      ) {
        try {
          finish({ ok: true, data: projectPageBridgeData(type, candidate.data) });
        } catch {
          finish({
            ok: false,
            error: new ExtensionSubscriptionRefreshError('outcome-ambiguous'),
          });
        }
        return;
      }
      if (
        candidate.ok === false &&
        hasExactKeys(candidate, ['channel', 'source', 'requestId', 'ok', 'error']) &&
        isExtensionBridgeErrorCode(candidate.error)
      ) {
        finish({
          ok: false,
          error: new ExtensionSubscriptionRefreshError(candidate.error),
        });
        return;
      }
      finish({
        ok: false,
        error: new ExtensionSubscriptionRefreshError('outcome-ambiguous'),
      });
    };
    const timer = target.setTimeout(() => {
      target.removeEventListener('message', onMessage);
      reject(new ExtensionSubscriptionRefreshError('outcome-ambiguous'));
    }, timeoutMs);

    target.addEventListener('message', onMessage);
    target.postMessage(
      {
        channel: SUBSCRIPTION_BRIDGE_CHANNEL,
        source: 'proxymanager-web',
        requestId,
        type,
        ...(type === 'refresh' ? { subscriptionId } : {}),
      },
      target.location.origin,
    );
  });
}

const FORBIDDEN_HEADER_NAMES: Record<string, true> = {
  'accept-charset': true,
  'accept-encoding': true,
  'access-control-request-headers': true,
  'access-control-request-method': true,
  connection: true,
  'content-length': true,
  cookie: true,
  cookie2: true,
  date: true,
  dnt: true,
  expect: true,
  host: true,
  'keep-alive': true,
  origin: true,
  'permissions-policy': true,
  referer: true,
  'set-cookie': true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
  'user-agent': true,
  via: true,
};
const METHOD_OVERRIDE_HEADERS: Record<string, true> = {
  'x-http-method': true,
  'x-http-method-override': true,
  'x-method-override': true,
};

function isBrowserSettableHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (FORBIDDEN_HEADER_NAMES[lower] || lower.startsWith('proxy-') || lower.startsWith('sec-')) {
    return false;
  }
  if (METHOD_OVERRIDE_HEADERS[lower]) {
    return !value
      .split(',')
      .map((method) => method.trim().toUpperCase())
      .some((method) => method === 'CONNECT' || method === 'TRACE' || method === 'TRACK');
  }
  return true;
}

export function checkNativeFetchCompatibility(
  spec: SubscriptionLocalFetchSpec,
  environment: { pageProtocol: string; navigatorUserAgent: string },
): LocalSubscriptionRefreshErrorCode | null {
  let url: URL;
  try {
    url = new URL(spec.url);
  } catch {
    return 'unsupported-url';
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return 'unsupported-url';
  }
  if (environment.pageProtocol === 'https:' && url.protocol === 'http:') return 'mixed-content';
  if (spec.userAgent !== environment.navigatorUserAgent) return 'user-agent-mismatch';
  try {
    for (const [name, value] of Object.entries(spec.customHeaders)) {
      if (!isBrowserSettableHeader(name, value)) return 'forbidden-header';
      new Headers({ [name]: value });
    }
  } catch {
    return 'forbidden-header';
  }
  return null;
}

interface NativeFetchDependencies {
  fetchImpl?: typeof fetch;
  pageProtocol?: string;
  navigatorUserAgent?: string;
  timeoutMs?: number;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredRaw = response.headers.get('content-length');
  if (declaredRaw && /^(0|[1-9][0-9]*)$/.test(declaredRaw)) {
    const declared = Number(declaredRaw);
    if (Number.isSafeInteger(declared) && declared > MAX_SUBSCRIPTION_CONTENT) {
      await cancelBody(response);
      throw new LocalSubscriptionRefreshError('response-too-large');
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength === 0) continue;
      size += next.value.byteLength;
      if (size > MAX_SUBSCRIPTION_CONTENT) {
        await reader.cancel().catch(() => undefined);
        throw new LocalSubscriptionRefreshError('response-too-large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof LocalSubscriptionRefreshError) throw error;
    throw new LocalSubscriptionRefreshError('native-fetch-failed');
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchSubscriptionNatively(
  spec: SubscriptionLocalFetchSpec,
  dependencies: NativeFetchDependencies = {},
): Promise<string> {
  const pageProtocol = dependencies.pageProtocol ?? window.location.protocol;
  const navigatorUserAgent = dependencies.navigatorUserAgent ?? navigator.userAgent;
  const incompatible = checkNativeFetchCompatibility(spec, { pageProtocol, navigatorUserAgent });
  if (incompatible) throw new LocalSubscriptionRefreshError(incompatible);

  const headers = new Headers(spec.customHeaders);
  if (!headers.has('Accept')) headers.set('Accept', '*/*');
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(spec.url, {
      method: 'GET',
      headers,
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!response.ok) {
      await cancelBody(response);
      throw new LocalSubscriptionRefreshError('response-http');
    }
    const bytes = await readBoundedBody(response);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new LocalSubscriptionRefreshError('response-invalid-utf8');
    }
  } catch (error) {
    if (error instanceof LocalSubscriptionRefreshError) throw error;
    throw new LocalSubscriptionRefreshError('native-fetch-failed');
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function getSubscriptionLocalFetchSpec(
  subscriptionId: string,
): Promise<SubscriptionLocalFetchSpec> {
  const response = await api<{ data: SubscriptionLocalFetchSpec }>(
    `/api/v1/subscriptions/${subscriptionId}/local-fetch-spec`,
    { cache: 'no-store' },
  );
  return response.data;
}

export async function uploadManualSubscription(
  spec: SubscriptionLocalFetchSpec,
  content: string,
): Promise<{ proxyCount: number; updatedAt: number }> {
  if (new TextEncoder().encode(content).byteLength > MAX_SUBSCRIPTION_CONTENT) {
    throw new LocalSubscriptionRefreshError('response-too-large');
  }
  const response = await api<ManualSubscriptionRefreshReceipt>(
    `/api/v1/subscriptions/${spec.subscriptionId}/manual-refresh`,
    {
      method: 'POST',
      body: content,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'If-Match': String(spec.updatedAt),
        'X-Fetch-Identity-Revision': String(spec.fetchIdentityRevision),
      },
    },
  );
  const receipt = response.data;
  if (
    !Number.isInteger(receipt.proxyCount) ||
    receipt.proxyCount < 1 ||
    !Number.isInteger(receipt.updatedAt) ||
    receipt.updatedAt < 0
  ) {
    throw new LocalSubscriptionRefreshError('response-invalid-receipt');
  }
  return receipt;
}

interface LocalNetworkRefreshDependencies {
  getSpec: typeof getSubscriptionLocalFetchSpec;
  checkCompatibility: (
    spec: SubscriptionLocalFetchSpec,
  ) => LocalSubscriptionRefreshErrorCode | null;
  fetchNatively: typeof fetchSubscriptionNatively;
  upload: typeof uploadManualSubscription;
}

const LOCAL_NETWORK_REFRESH_DEPENDENCIES: LocalNetworkRefreshDependencies = {
  getSpec: getSubscriptionLocalFetchSpec,
  checkCompatibility: (spec) =>
    checkNativeFetchCompatibility(spec, {
      pageProtocol: window.location.protocol,
      navigatorUserAgent: navigator.userAgent,
    }),
  fetchNatively: fetchSubscriptionNatively,
  upload: uploadManualSubscription,
};

/**
 * Prefer one trusted extension attempt. Only an explicit pre-upload code may
 * continue into one compatible native fetch and one Web upload.
 */
export async function refreshSubscriptionFromLocalNetwork(
  subscriptionId: string,
  expectedUpdatedAt: number,
  refreshWithExtension: (() => Promise<{ proxyCount: number; updatedAt: number }>) | null,
  dependencies: LocalNetworkRefreshDependencies = LOCAL_NETWORK_REFRESH_DEPENDENCIES,
): Promise<{ proxyCount: number; updatedAt: number }> {
  let extensionFailure: ExtensionSubscriptionRefreshError | null = null;
  if (refreshWithExtension) {
    try {
      return await refreshWithExtension();
    } catch (error) {
      const classified =
        error instanceof ExtensionSubscriptionRefreshError
          ? error
          : new ExtensionSubscriptionRefreshError('outcome-ambiguous');
      if (!DEFINITE_PRE_UPLOAD_EXTENSION_FAILURES[classified.code]) throw classified;
      extensionFailure = classified;
    }
  }

  let spec: SubscriptionLocalFetchSpec;
  try {
    spec = await dependencies.getSpec(subscriptionId);
  } catch (error) {
    if (extensionFailure) throw new ExtensionNativeFallbackError('native-failed');
    throw error;
  }
  if (spec.updatedAt !== expectedUpdatedAt) {
    throw new Error('订阅已被修改，请刷新页面后再更新。');
  }
  const incompatible = dependencies.checkCompatibility(spec);
  if (incompatible) {
    if (extensionFailure) throw new ExtensionNativeFallbackError('native-incompatible');
    throw new LocalSubscriptionRefreshError(incompatible);
  }

  let content: string;
  try {
    content = await dependencies.fetchNatively(spec);
  } catch (error) {
    if (extensionFailure) throw new ExtensionNativeFallbackError('native-failed');
    throw error;
  }
  try {
    return await dependencies.upload(spec, content);
  } catch (error) {
    if (extensionFailure) throw new ExtensionNativeFallbackError('upload-failed');
    throw error;
  }
}

export async function refreshSubscriptionNatively(
  subscriptionId: string,
): Promise<{ proxyCount: number; updatedAt: number }> {
  const spec = await getSubscriptionLocalFetchSpec(subscriptionId);
  const content = await fetchSubscriptionNatively(spec);
  return uploadManualSubscription(spec, content);
}

export type ManualRefreshOperationKind = 'file-import' | 'paste-submit' | 'local-refresh';

export type ManualRefreshOperationLease = readonly [
  subscriptionId: string,
  sequence: number,
  kind: ManualRefreshOperationKind,
];

export type AddFormMutationLease = Readonly<{ sequence: number }>;

interface AddFormMutationController {
  start(): AddFormMutationLease | null;
  finish(lease: AddFormMutationLease): boolean;
  current(): AddFormMutationLease | null;
  owns(lease: AddFormMutationLease): boolean;
  dispose(): void;
}

/** Page-owned synchronous barrier for one AddForm create and its reload settlement. */
export function createAddFormMutationController(
  listener: (lease: AddFormMutationLease | null) => void,
): AddFormMutationController {
  let active: AddFormMutationLease | null = null;
  let sequence = 0;
  let notify: ((lease: AddFormMutationLease | null) => void) | null = listener;

  return {
    start() {
      if (active || !notify) return null;
      const lease = Object.freeze({ sequence: ++sequence });
      active = lease;
      notify(lease);
      return lease;
    },
    finish(lease) {
      if (active !== lease || !notify) return false;
      active = null;
      notify(null);
      return true;
    },
    current() {
      return active;
    },
    owns(lease) {
      return active === lease;
    },
    dispose() {
      active = null;
      notify = null;
    },
  };
}

interface ManualRefreshOperationController {
  start(
    subscriptionId: string,
    kind: ManualRefreshOperationKind,
  ): ManualRefreshOperationLease | null;
  finish(lease: ManualRefreshOperationLease): boolean;
  current(): ManualRefreshOperationLease | null;
  owns(lease: ManualRefreshOperationLease): boolean;
  dispose(): void;
}

/** Page-scoped synchronous ownership for file, paste and local refresh work. */
export function createManualRefreshOperationController(
  listener: (lease: ManualRefreshOperationLease | null) => void,
): ManualRefreshOperationController {
  let active: ManualRefreshOperationLease | null = null;
  let sequence = 0;
  let notify: ((lease: ManualRefreshOperationLease | null) => void) | null = listener;

  return {
    start(subscriptionId, kind) {
      if (active || !notify) return null;
      const lease = Object.freeze([
        subscriptionId,
        ++sequence,
        kind,
      ]) as ManualRefreshOperationLease;
      active = lease;
      notify(lease);
      return lease;
    },
    finish(lease) {
      if (active !== lease || !notify) return false;
      active = null;
      notify(null);
      return true;
    },
    current() {
      return active;
    },
    owns(lease) {
      return active === lease;
    },
    dispose() {
      active = null;
      notify = null;
    },
  };
}
