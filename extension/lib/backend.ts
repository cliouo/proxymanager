import { z } from "zod";
import type { BackendTarget, BackendProfile, BackendRule } from "./messages";
import type { Settings } from "./settings";

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}

function ensureBackend(settings: Settings): { url: string; key: string } {
  if (!settings.backendUrl) {
    throw new BackendError(
      "Backend URL is not configured. Open the options page.",
    );
  }
  if (!settings.adminKey) {
    throw new BackendError(
      "ADMIN_KEY is not configured. Open the options page.",
    );
  }
  return {
    url: new URL(settings.backendUrl).origin,
    key: settings.adminKey,
  };
}

async function call<T>(
  settings: Settings,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { url, key } = ensureBackend(settings);
  if (/^\/api\/v1\/(?:rules|policies|anchors)(?:[/?]|$)/.test(path)) {
    if (!z.string().uuid().safeParse(settings.profileId).success) throw new BackendError('请选择目标 Profile。');
    const meta = await call<{ data: { capabilities?: { profileIdScope?: boolean } } }>(settings, '/api/v1/meta');
    if (meta.data.capabilities?.profileIdScope !== true) throw new BackendError('服务器不支持 Profile ID 作用域，请先升级服务器。已停止规则写回。');
    const scoped = new URL(path, url);
    scoped.searchParams.set('profileId', settings.profileId);
    path = scoped.pathname + scoped.search;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "X-Source": "extension",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init?.body && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${url}${path}`, { ...init, credentials: "omit", headers });
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const problem = (body as { detail?: string; title?: string }) ?? {};
    throw new BackendError(
      problem.detail ?? problem.title ?? `HTTP ${res.status}`,
      res.status,
      problem.detail,
    );
  }
  return body as T;
}

export function targetFromSettings(settings: Settings): BackendTarget {
  if (!settings.profileId) throw new BackendError('请选择目标 Profile。');
  return { origin: ensureBackend(settings).url, profileId: settings.profileId, profileName: settings.profileName };
}

export function bindBackendTarget(settings: Settings, target: BackendTarget): Settings {
  const parsed = z.object({ origin: z.string().url(), profileId: z.string().uuid(), profileName: z.string() }).safeParse(target);
  if (!parsed.success) throw new BackendError('原始写入目标未记录，无法安全执行。');
  const current = ensureBackend(settings).url;
  if (parsed.data.origin !== current) throw new BackendError('请先连接原始后端实例，再执行此操作。');
  return { ...settings, profileId: parsed.data.profileId, profileName: parsed.data.profileName };
}

export async function backendProfiles(settings: Settings): Promise<BackendProfile[]> {
  const meta = await call<{ data: { capabilities?: { profileIdScope?: boolean } } }>(settings, '/api/v1/meta');
  if (meta.data.capabilities?.profileIdScope !== true) throw new BackendError('服务器不支持 Profile ID 作用域，请先升级服务器。已停止规则写回。');
  const res = await call<{ data: BackendProfile[] }>(settings, '/api/v1/profiles');
  return res.data;
}

export async function backendHealth(settings: Settings): Promise<unknown> {
  const { url } = ensureBackend(settings);
  const res = await fetch(`${url}/api/v1/health`);
  if (!res.ok)
    throw new BackendError(`Backend health HTTP ${res.status}`, res.status);
  return res.json();
}

export async function backendAnchors(settings: Settings): Promise<string[]> {
  const res = await call<{ data: string[] }>(settings, "/api/v1/anchors");
  return res.data;
}

export async function backendPolicies(settings: Settings): Promise<string[]> {
  const res = await call<{ data: string[] }>(settings, "/api/v1/policies");
  return res.data;
}

export interface SubscriptionLocalFetchSpec {
  subscriptionId: string;
  url: string;
  userAgent: string;
  customHeaders: Record<string, string>;
  updatedAt: number;
  fetchIdentityRevision: number;
}

export interface ManualSubscriptionRefreshResult {
  data: {
    proxyCount: number;
    updatedAt: number;
  };
}

export async function backendSubscriptionLocalFetchSpec(
  settings: Settings,
  subscriptionId: string,
): Promise<SubscriptionLocalFetchSpec> {
  const res = await call<{ data: SubscriptionLocalFetchSpec }>(
    settings,
    `/api/v1/subscriptions/${encodeURIComponent(subscriptionId)}/local-fetch-spec`,
    { cache: "no-store" },
  );
  return res.data;
}

export async function backendImportManualSubscription(
  settings: Settings,
  spec: SubscriptionLocalFetchSpec,
  content: string,
): Promise<ManualSubscriptionRefreshResult> {
  return call<ManualSubscriptionRefreshResult>(
    settings,
    `/api/v1/subscriptions/${encodeURIComponent(spec.subscriptionId)}/manual-refresh`,
    {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "If-Match": String(spec.updatedAt),
        "X-Fetch-Identity-Revision": String(spec.fetchIdentityRevision),
      },
      body: content,
    },
  );
}

export async function backendListRulesByAnchor(
  settings: Settings,
  anchor: string,
): Promise<BackendRule[]> {
  const rules: BackendRule[] = [];
  let version: number | undefined;
  for (let offset = 0; ; offset += 500) {
    const qs = new URLSearchParams({ anchor, limit: "500", offset: String(offset) });
    const res = await call<{ data: BackendRule[]; meta: { total: number; configVersion: number } }>(settings, `/api/v1/rules?${qs}`);
    if (version !== undefined && version !== res.meta.configVersion) throw new BackendError('规则在读取期间发生变化，请重试。');
    version = res.meta.configVersion;
    rules.push(...res.data);
    if (rules.length >= res.meta.total || res.data.length === 0) return rules;
  }
}

export async function backendDeleteRule(
  settings: Settings,
  ruleId: string,
): Promise<void> {
  await call<unknown>(settings, `/api/v1/rules/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
  });
}

export async function backendCreateRule(
  settings: Settings,
  rule: {
    anchor: string;
    type: "DOMAIN" | "DOMAIN-SUFFIX";
    value: string;
    policy: string;
    source: "speedtest" | "manual";
    note?: string;
  },
): Promise<{ id: string }> {
  const res = await call<{ data: { id: string } }>(settings, "/api/v1/rules", {
    method: "POST",
    body: JSON.stringify(rule),
  });
  return res.data;
}

export interface NewRuleInput {
  anchor: string;
  type: "DOMAIN" | "DOMAIN-SUFFIX";
  value: string;
  policy: string;
  source: "speedtest" | "manual";
  note?: string;
}

export interface BatchCreateResult {
  /** Per-input outcome — index matches the input array order. */
  outcomes: Array<
    { status: "ok"; ruleId: string } | { status: "err"; message: string }
  >;
}

export async function backendCreateRulesBatch(
  settings: Settings,
  rules: NewRuleInput[],
): Promise<BatchCreateResult> {
  const ops = rules.map((rule) => ({ op: "create" as const, rule }));
  const res = await call<{
    results: Array<{
      status: number;
      data?: { id: string };
      error?: { title: string; detail?: string };
    }>;
  }>(settings, "/api/v1/rules/batch", {
    method: "POST",
    body: JSON.stringify({ ops }),
  });
  const outcomes = res.results.map((r) => {
    if (r.status >= 200 && r.status < 300 && r.data?.id) {
      return { status: "ok" as const, ruleId: r.data.id };
    }
    return {
      status: "err" as const,
      message: r.error?.detail ?? r.error?.title ?? `HTTP ${r.status}`,
    };
  });
  return { outcomes };
}
