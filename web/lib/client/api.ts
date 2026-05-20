import { clearAdminKey, getAdminKey } from './auth-storage';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly problem: { title: string; detail?: string; errors?: unknown[] } & Record<string, unknown>,
  ) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body' | 'headers'> {
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip auth header (use for public endpoints during dev). */
  skipAuth?: boolean;
  /** Return raw Response instead of parsed JSON (e.g. text/yaml). */
  raw?: boolean;
}

async function parseProblem(res: Response): Promise<ApiError> {
  let problem: Record<string, unknown> = { title: `HTTP ${res.status}` };
  try {
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('json')) {
      problem = await res.json();
    }
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, problem as ApiError['problem']);
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { body, headers, skipAuth, raw, ...rest } = opts;
  const finalHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (!skipAuth) {
    const key = getAdminKey();
    if (key) finalHeaders.Authorization = `Bearer ${key}`;
  }
  if (body !== undefined && !(body instanceof FormData) && finalHeaders['Content-Type'] === undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, {
    ...rest,
    headers: finalHeaders,
    body:
      body === undefined
        ? undefined
        : body instanceof FormData || typeof body === 'string'
          ? (body as BodyInit)
          : JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await parseProblem(res);
    if (err.status === 401) {
      clearAdminKey();
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      }
    }
    throw err;
  }

  if (raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function apiRaw(path: string, opts: ApiOptions = {}): Promise<Response> {
  return api<Response>(path, { ...opts, raw: true });
}
