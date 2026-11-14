'use client';

/**
 * Thin fetch client for the admin API (`/api/v1/*`, Bearer ADMIN_KEY).
 * Errors are normalised from RFC 7807 problem documents into `ApiError`, which
 * keeps the structured `errors` array (config preflight issues, zod issues,
 * orphaned rules …) so the UI can render them precisely instead of a blob.
 */

import { trackRequest } from './activity';

const KEY_STORAGE = 'pm.admin-key';
export const UNAUTHORIZED_EVENT = 'pm:unauthorized';

export function getAdminKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setAdminKey(key: string): void {
  window.localStorage.setItem(KEY_STORAGE, key);
}

export function clearAdminKey(): void {
  try {
    window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

export interface ConfigIssue {
  code?: string;
  message: string;
  path?: string | (string | number)[];
  section?: string;
  resource?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail?: string;
  readonly issues: ConfigIssue[];
  readonly raw: unknown;

  constructor(status: number, title: string, detail: string | undefined, issues: ConfigIssue[], raw: unknown) {
    super(detail || title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.detail = detail;
    this.issues = issues;
    this.raw = raw;
  }
}

function normaliseIssues(errors: unknown): ConfigIssue[] {
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((item): ConfigIssue[] => {
    if (!item || typeof item !== 'object') {
      return typeof item === 'string' ? [{ message: item }] : [];
    }
    const record = item as Record<string, unknown>;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.reason === 'string' && record.reason) ||
      (typeof record.detail === 'string' && record.detail) ||
      '';
    if (!message) return [];
    return [
      {
        message,
        code: typeof record.code === 'string' ? record.code : undefined,
        path: Array.isArray(record.path)
          ? (record.path as (string | number)[])
          : typeof record.path === 'string'
            ? record.path
            : typeof record.rule_id === 'string'
              ? `rule ${record.rule_id}`
              : undefined,
        section: typeof record.section === 'string' ? record.section : undefined,
        resource: typeof record.resource === 'string' ? record.resource : undefined,
      },
    ];
  });
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  /** Send `body` verbatim as text/plain instead of JSON. */
  text?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('/api/') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url;
}

/** Set while a speculative (prefetch) call starts its requests; see withLowPriority. */
let lowPriority = false;

/**
 * Run `start` so every request it begins synchronously is sent with fetch
 * `priority: 'low'` — prefetches shouldn't compete with what the user is
 * waiting for. Browsers without fetch priority ignore the hint.
 */
export function withLowPriority<T>(start: () => T): T {
  const previous = lowPriority;
  lowPriority = true;
  try {
    return start();
  } finally {
    lowPriority = previous;
  }
}

export function request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  return trackRequest(send<T>(path, options, lowPriority ? 'low' : undefined));
}

async function send<T>(path: string, options: RequestOptions, priority?: RequestPriority): Promise<T> {
  const key = getAdminKey();
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (key) headers.Authorization = `Bearer ${key}`;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (options.text) {
      headers['Content-Type'] = 'text/plain; charset=utf-8';
      body = String(options.body);
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      signal: options.signal,
      cache: 'no-store',
      ...(priority ? { priority } : {}),
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new ApiError(0, '网络连接失败', '无法连接到服务器，请检查网络后重试。', [], error);
  }

  if (response.status === 204) return null as T;
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    const problem = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
    const title =
      typeof problem.title === 'string' ? problem.title : `请求失败（${response.status}）`;
    const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
    throw new ApiError(response.status, title, detail, normaliseIssues(problem.errors), json);
  }
  return json as T;
}

/** Convenience verbs that unwrap the `{ data }` envelope most routes use. */
export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) =>
    request<{ data: T }>(path, { query, signal }).then((r) => r.data),
  raw: <T>(path: string, options?: RequestOptions) => request<T>(path, options),
  post: <T>(path: string, body?: unknown, query?: Query) =>
    request<{ data: T }>(path, { method: 'POST', body: body ?? {}, query }).then((r) => r?.data as T),
  put: <T>(path: string, body: unknown, query?: Query, headers?: Record<string, string>) =>
    request<{ data: T }>(path, { method: 'PUT', body, query, headers }).then((r) => r?.data as T),
  patch: <T>(path: string, body: unknown, query?: Query, headers?: Record<string, string>) =>
    request<{ data: T }>(path, { method: 'PATCH', body, query, headers }).then((r) => r?.data as T),
  del: <T = null>(path: string, query?: Query) =>
    request<{ data?: T } | null>(path, { method: 'DELETE', query }).then((r) => (r?.data ?? null) as T | null),
};

/** Human-readable one-liner for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.issues.length > 0) return error.issues[0].message;
    return error.detail || error.title;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
