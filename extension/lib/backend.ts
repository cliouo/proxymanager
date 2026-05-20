import type { Settings } from './settings';

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

function ensureBackend(settings: Settings): { url: string; key: string } {
  if (!settings.backendUrl) {
    throw new BackendError('Backend URL is not configured. Open the options page.');
  }
  if (!settings.adminKey) {
    throw new BackendError('ADMIN_KEY is not configured. Open the options page.');
  }
  return { url: settings.backendUrl.replace(/\/+$/, ''), key: settings.adminKey };
}

async function call<T>(
  settings: Settings,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const { url, key } = ensureBackend(settings);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init?.body && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${url}${path}`, { ...init, headers });
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

export async function backendHealth(settings: Settings): Promise<unknown> {
  const { url } = ensureBackend(settings);
  const res = await fetch(`${url}/api/v1/health`);
  if (!res.ok) throw new BackendError(`Backend health HTTP ${res.status}`, res.status);
  return res.json();
}

export async function backendAnchors(settings: Settings): Promise<string[]> {
  const res = await call<{ data: string[] }>(settings, '/api/v1/anchors');
  return res.data;
}

export async function backendPolicies(settings: Settings): Promise<string[]> {
  const res = await call<{ data: string[] }>(settings, '/api/v1/policies');
  return res.data;
}

export async function backendCreateRule(
  settings: Settings,
  rule: {
    anchor: string;
    type: 'DOMAIN' | 'DOMAIN-SUFFIX';
    value: string;
    policy: string;
    source: 'speedtest' | 'manual';
    note?: string;
  },
): Promise<{ id: string }> {
  const res = await call<{ data: { id: string } }>(settings, '/api/v1/rules', {
    method: 'POST',
    body: JSON.stringify(rule),
  });
  return res.data;
}
