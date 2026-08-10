import { z } from '@/lib/openapi/zod';
import {
  MutableOperatorListSchema,
  StoredOperatorListSchema,
  type StoredOperator,
} from './operator';
import { MAX_SUBSCRIPTION_CONTENT } from './base';

/**
 * The fixed eligible fetch-failure category values used by the health
 * union's `failure_category` enum. The RUNTIME classifier enum and the only
 * eligibility predicate remain owned by
 * subscriptionResolutionErrors.ts; the two lists are pinned equal by
 * subscriptionSchema.test.ts. Kept LOCAL to the schema module so the shared
 * `@/schemas` index never drags server-only imports (node:net, node:crypto)
 * into client bundles.
 */
export const SUBSCRIPTION_FETCH_FAILURE_CATEGORIES = [
  'network',
  'timeout',
  'http',
  'response-encoding',
  'response-content-format',
  'proxy-node',
] as const;

/**
 * P3-19: restrict remote subscription URLs to http/https. The upstream is
 * fetched server-side, so allowing arbitrary schemes (file:, gopher:, etc.) is
 * an SSRF footgun. This direct subscription-fetch path intentionally permits
 * private/internal http(s) hosts for self-hosters; the schema still rejects
 * URL userinfo so credentials cannot leak through redirects or diagnostics.
 */
const httpUrl = z.url().refine(
  (value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      );
    } catch {
      return false;
    }
  },
  { message: 'URL 必须使用 http(s)，且不得包含用户名或密码' },
);

/**
 * Historical persisted rows allowed HTTP(S) userinfo. Keep those rows
 * manageable after an upgrade; create/update stays on `httpUrl`, while the
 * fetch boundary independently rejects userinfo before making a request.
 */
const storedHttpUrl = z.url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'URL 必须是 http(s) 协议',
});

/**
 * Default TTL for the fetch cache — within this window subsequent reads of
 * the same upstream skip the network and serve cached content. Sub-Store
 * defaults to 1 hour; we go shorter (10 min) since this is a personal tool
 * where freshness matters more than upstream load.
 */
export const DEFAULT_SUBSCRIPTION_TTL_MS = 10 * 60 * 1000;

export const SubscriptionKindSchema = z.enum(['remote', 'local']);

export const SubscriptionTrafficSchema = z.object({
  upload: z.number().nonnegative(),
  download: z.number().nonnegative(),
  total: z.number().nonnegative(),
  expire: z.number().int(),
});

/**
 * Per-remote-source fetch failure policy (P-FFP v1):
 *
 *   - `use-stale-cache` (effective default): after a fresh attempt fails with
 *     an eligible typed error, a retained, strictly validated last-known-good
 *     cache entry may be served; without one, an enabled member of an actual
 *     bound/exported collection may be skipped (one member, order preserved,
 *     safe warning). Direct/unbound resolution still fails.
 *   - `fail-closed`: an eligible failure never stale-serves and never skips —
 *     the failure propagates (fixed 422/503 at the boundary).
 *
 * The field is DECLARATIVE and remote-only: a persisted row/request without
 * it has effective `use-stale-cache` and reads never rewrite storage. Local
 * sources omit and never consult it.
 */
export const SubscriptionFetchFailurePolicySchema = z.enum(['use-stale-cache', 'fail-closed']);
export type SubscriptionFetchFailurePolicy = z.infer<typeof SubscriptionFetchFailurePolicySchema>;

/**
 * How a remote source obtains its current bytes:
 *
 *   - server-auto: the deployed backend fetches the upstream URL and uses the
 *     normal fetch cache / failure policy.
 *   - manual: one checksum-verified snapshot from the dedicated Redis key is
 *     the only source of bytes. Missing stays server-auto for legacy rows.
 */
export const SubscriptionRefreshModeSchema = z.enum(['server-auto', 'manual']);
export type SubscriptionRefreshMode = z.infer<typeof SubscriptionRefreshModeSchema>;

export const SubscriptionManualUpdateOriginSchema = z.enum(['web', 'extension']);
export type SubscriptionManualUpdateOrigin = z.infer<typeof SubscriptionManualUpdateOriginSchema>;

/** Bounded metadata stored with the definition; raw bytes are always separate. */
export const SubscriptionManualSnapshotMetaSchema = z
  .object({
    updated_at: z.number().int().nonnegative(),
    proxy_count: z.number().int().positive(),
    origin: SubscriptionManualUpdateOriginSchema,
    fetch_identity_revision: z.number().int().nonnegative(),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type SubscriptionManualSnapshotMeta = z.infer<typeof SubscriptionManualSnapshotMetaSchema>;

/** Secret-free admin projection of the stored manual snapshot metadata. */
export const SubscriptionManualSnapshotSchema = z
  .object({
    updated_at: z.number().int().nonnegative(),
    proxy_count: z.number().int().positive(),
    origin: SubscriptionManualUpdateOriginSchema,
    source_changed: z.boolean(),
  })
  .strict();
export type SubscriptionManualSnapshot = z.infer<typeof SubscriptionManualSnapshotSchema>;

/** Authenticated, no-store fetch inputs consumed only by the page or extension background. */
export const SubscriptionLocalFetchSpecSchema = z
  .object({
    subscriptionId: z.uuid(),
    url: storedHttpUrl,
    userAgent: z.string(),
    customHeaders: z.record(z.string(), z.string()),
    updatedAt: z.number().int().nonnegative(),
    fetchIdentityRevision: z.number().int().nonnegative(),
  })
  .strict();
export type SubscriptionLocalFetchSpec = z.infer<typeof SubscriptionLocalFetchSpecSchema>;

/** The only successful manual-import receipt. */
export const ManualSubscriptionRefreshReceiptSchema = z
  .object({
    data: z
      .object({
        proxyCount: z.number().int().positive(),
        updatedAt: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ManualSubscriptionRefreshReceipt = z.infer<
  typeof ManualSubscriptionRefreshReceiptSchema
>;

export function effectiveSubscriptionRefreshMode(
  sub: Pick<Subscription, 'kind' | 'refresh_mode'>,
): SubscriptionRefreshMode {
  return sub.refresh_mode ?? 'server-auto';
}

/** Missing legacy revisions are observed as zero and are never rewritten on read. */
export function effectiveFetchIdentityRevision(
  sub: Pick<Subscription, 'fetch_identity_revision'>,
): number {
  return sub.fetch_identity_revision ?? 0;
}

/**
 * Effective policy (missing = documented default). The value is only ever
 * CONSULTED on the remote path — every call site guards `kind === 'remote'`
 * first (fetcher remote branch, resolve skip predicate, health fingerprint,
 * MCP projection, admin view) — so the parameter accepts the subscription
 * shape without re-narrowing the object type at the call sites.
 */
export function effectiveFetchFailurePolicy(
  sub: Pick<Subscription, 'kind' | 'fetch_failure_policy'>,
): SubscriptionFetchFailurePolicy {
  return sub.fetch_failure_policy ?? 'use-stale-cache';
}

/** Default User-Agent used for remote fetches (blank override = unset). */
export const DEFAULT_SUBSCRIPTION_UA = 'clash.meta/1.18.0';

/** Effective UA for a subscription — whitespace-only means default; stored text is trimmed. */
export function subscriptionUserAgent(sub: Pick<Subscription, 'ua_override'>): string {
  return sub.ua_override?.trim() || DEFAULT_SUBSCRIPTION_UA;
}

/**
 * Effective non-User-Agent request headers. The dedicated `ua_override`
 * channel is authoritative, so every casing of a custom User-Agent is
 * ignored. Sorting keeps cache, health and optimistic identity byte-stable.
 */
export function effectiveSubscriptionCustomHeaders(
  sub: Pick<Subscription, 'custom_headers'>,
): Record<string, string> | undefined {
  if (!sub.custom_headers) return undefined;
  const entries = Object.entries(sub.custom_headers)
    .filter(([name]) => name.toLowerCase() !== 'user-agent')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Eligible fetch-failure categories — the fixed closed enum (classifier). */
export const SubscriptionFetchFailureCategorySchema = z.enum(SUBSCRIPTION_FETCH_FAILURE_CATEGORIES);
export type SubscriptionFetchFailureCategory = z.infer<
  typeof SubscriptionFetchFailureCategorySchema
>;

/**
 * v2 I12: the definition_fingerprint is ONE canonical unpadded base64url
 * encoding of exactly 32 SHA-256 bytes — exactly 43 characters from
 * A-Za-z0-9_-, no padding, decode length 32, and byte-identical
 * re-encoding. Short, long, padded, plus/slash alphabet, and non-canonical
 * trailing-bit encodings are invalid.
 */
export const CanonicalBase64urlSha256Schema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, 'definition_fingerprint 必须是 43 字符的 base64url 编码')
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value;
  }, 'definition_fingerprint 必须是 32 字节 SHA-256 的规范无填充 base64url 编码');
export type CanonicalBase64urlSha256 = z.infer<typeof CanonicalBase64urlSha256Schema>;

/**
 * Separate, advisory, non-preview runtime fetch health. NOT part of the
 * definition row: it is stored under its own per-source key, expires seven
 * days after the last actual attempt, and never changes config:version,
 * render caches or snapshots. Malformed combinations read absent. Fresh
 * cache hits and local resolution record no health.
 */
export const SubscriptionFetchHealthSchema = z.discriminatedUnion('state', [
  z
    .object({
      definition_fingerprint: CanonicalBase64urlSha256Schema,
      state: z.literal('fresh'),
      attempted_at: z.number().int().nonnegative(),
      observed_at: z.number().int().nonnegative(),
      fresh_at: z.number().int().nonnegative(),
      proxy_count: z.number().int().nonnegative(),
      traffic: SubscriptionTrafficSchema.optional(),
    })
    .strict(),
  z
    .object({
      definition_fingerprint: CanonicalBase64urlSha256Schema,
      state: z.literal('stale-served'),
      attempted_at: z.number().int().nonnegative(),
      observed_at: z.number().int().nonnegative(),
      fresh_at: z.number().int().nonnegative(),
      failure_category: SubscriptionFetchFailureCategorySchema,
      cache_disposition: z.literal('served'),
      proxy_count: z.number().int().nonnegative(),
      traffic: SubscriptionTrafficSchema.optional(),
    })
    .strict(),
  z
    .object({
      definition_fingerprint: CanonicalBase64urlSha256Schema,
      state: z.literal('failed-no-cache'),
      attempted_at: z.number().int().nonnegative(),
      observed_at: z.number().int().nonnegative(),
      failure_category: SubscriptionFetchFailureCategorySchema,
      cache_disposition: z.enum(['unavailable', 'invalid', 'policy-blocked', 'bypassed']),
    })
    .strict(),
]);
export type SubscriptionFetchHealth = z.infer<typeof SubscriptionFetchHealthSchema>;
export type SubscriptionFetchHealthState = SubscriptionFetchHealth['state'];

/**
 * The shared stored-row fields. The kind-discriminated branches below add
 * the kind literal and (remote only) the optional policy, so a LOCAL stored
 * row that carries a legacy policy decodes successfully with the field
 * STRIPPED from the in-memory value (zod drops undeclared keys); HGET and
 * HGETALL reads never rewrite Redis.
 */
const StoredSubscriptionFields = {
  id: z.uuid(),
  /**
   * Distribution identifier: `name` is the slug used in public subscription
   * links and group bindings. NOTE — rename is an ACCEPTED IDENTITY RESET:
   * `SubscriptionUpdateSchema` permits changing it, and a rename breaks old
   * distribution links and intentionally resets the naming aliases /
   * ordinals bound to the OLD key (the renamed slug is a new source
   * identity). Never treat it as a stable slug.
   */
  name: z
    .string()
    .min(1, '标识不能为空')
    .regex(/^[a-z0-9-]+$/, '标识只能包含小写字母、数字和短横线（-）'),
  /**
   * Human-facing label shown in the UI (Chinese welcome). Purely cosmetic —
   * falls back to `name` when empty.
   */
  display_name: z.string().optional(),
  enabled: z.boolean(),
  /** Required when kind=remote. */
  url: storedHttpUrl.optional(),
  /** Per-sub UA override (legacy: ua_override). */
  ua_override: z.string().optional(),
  /** Extra request headers attached to remote fetches. */
  custom_headers: z.record(z.string(), z.string()).optional(),
  /** Per-sub fetch cache TTL in ms. */
  ttl_ms: z.number().int().positive().default(DEFAULT_SUBSCRIPTION_TTL_MS),
  /** Required when kind=local — inline Clash provider YAML (just a `proxies:` block). */
  content: z.string().max(MAX_SUBSCRIPTION_CONTENT, '订阅内容过大').optional(),
  /** Tags used by Collections for `subscription_tags` auto-inclusion. */
  tags: z.array(z.string()).default([]),
  /**
   * Ordered node-processing pipeline (界面「节点处理」). Applied to this
   * sub's parsed proxies after fetch/normalise; see lib/proxies/operators.ts.
   * Cross-source same-name collisions are handled by the dedup step here and
   * by global first-writer-wins dedup — there is no separate name prefix.
   */
  operators: StoredOperatorListSchema.default([]),
  /**
   * P2-2: optimistic-concurrency version (epoch seconds). Bumped on every
   * create/replace/patch edit so an If-Match PATCH can detect a concurrent
   * overwrite. Optional for backward-compat with records written before it
   * existed (they simply carry no version until first edited).
   */
  updated_at: z.number().int().optional(),
} as const;

/**
 * v2 I1: the STORED subscription schema is kind-discriminated. The remote
 * branch may carry the optional fetch_failure_policy (missing = effective
 * use-stale-cache, reads never rewrite storage); the local branch does NOT
 * declare it, so a local row that contains a legacy policy decodes with the
 * field stripped in memory. A row with a MISSING legacy kind falls through
 * to the legacy branch and is canonicalized in memory to remote. An invalid
 * policy enum keeps the existing unparseable-row behavior — never a silent
 * coercion.
 */
export const SubscriptionSchema: z.ZodType<Subscription> = z
  .discriminatedUnion('kind', [
    z.object({
      ...StoredSubscriptionFields,
      kind: z.literal('remote'),
      fetch_failure_policy: SubscriptionFetchFailurePolicySchema.optional(),
      refresh_mode: SubscriptionRefreshModeSchema.optional(),
      fetch_identity_revision: z.number().int().nonnegative().optional(),
      // Preserve malformed legacy/corrupt metadata so a manual source reaches
      // the resolver and fails the whole consumer closed instead of vanishing.
      manual_snapshot_meta: z.unknown().optional(),
    }),
    z.object({
      ...StoredSubscriptionFields,
      kind: z.literal('local'),
    }),
  ])
  .or(
    z.object({
      ...StoredSubscriptionFields,
      kind: SubscriptionKindSchema.default('remote'),
      fetch_failure_policy: SubscriptionFetchFailurePolicySchema.optional(),
      refresh_mode: SubscriptionRefreshModeSchema.optional(),
      fetch_identity_revision: z.number().int().nonnegative().optional(),
      manual_snapshot_meta: z.unknown().optional(),
    }),
  );

/**
 * Hand-written `create` payload: trim runtime/state fields and pin the
 * kind/url/content combination through a stricter refine. We can't use
 * .omit + .partial on the unified schema because zod loses the refine when
 * the union of optional fields changes; spelling it out is cleaner.
 */
export const SubscriptionCreateSchema = z
  .object({
    name: z
      .string()
      .min(1, '标识不能为空')
      .regex(/^[a-z0-9-]+$/, '标识只能包含小写字母、数字和短横线（-）'),
    display_name: z.string().optional(),
    enabled: z.boolean().default(true),
    kind: SubscriptionKindSchema.default('remote'),
    url: httpUrl.optional(),
    ua_override: z.string().optional(),
    custom_headers: z.record(z.string(), z.string()).optional(),
    ttl_ms: z.number().int().positive().default(DEFAULT_SUBSCRIPTION_TTL_MS),
    content: z.string().max(MAX_SUBSCRIPTION_CONTENT, '订阅内容过大').optional(),
    tags: z.array(z.string()).default([]),
    operators: MutableOperatorListSchema.default([]),
    // Remote-only declarative policy; an explicit value on a LOCAL create is
    // rejected by the service against the merged candidate (422).
    fetch_failure_policy: SubscriptionFetchFailurePolicySchema.optional(),
  })
  .refine(
    (s) => (s.kind === 'remote' ? !!s.url : !!s.content),
    'remote subs need url, local subs need content',
  );

export const SubscriptionUpdateSchema = z.object({
  name: z
    .string()
    .min(1, '标识不能为空')
    .regex(/^[a-z0-9-]+$/, '标识只能包含小写字母、数字和短横线（-）')
    .optional(),
  display_name: z.string().optional(),
  enabled: z.boolean().optional(),
  kind: SubscriptionKindSchema.optional(),
  url: httpUrl.optional(),
  ua_override: z.string().optional(),
  custom_headers: z.record(z.string(), z.string()).optional(),
  ttl_ms: z.number().int().positive().optional(),
  content: z.string().max(MAX_SUBSCRIPTION_CONTENT, '订阅内容过大').optional(),
  tags: z.array(z.string()).optional(),
  operators: MutableOperatorListSchema.optional(),
  fetch_failure_policy: SubscriptionFetchFailurePolicySchema.optional(),
  // Import is the sole transition into manual mode. Generic PATCH can only
  // request the validated manual → server-auto transition.
  refresh_mode: z.literal('server-auto').optional(),
});

/**
 * Admin-facing view of a subscription (v2 I1): a TRUE remote/local
 * discriminated union. The remote branch carries the REQUIRED effective
 * fetch_failure_policy and the REQUIRED nullable fingerprint-joined
 * fetch_health; the local branch declares neither — a local view input that
 * carries them parses with the fields stripped (omission), exactly like the
 * stored schema. The stored row itself stays config-only — health lives in
 * the separate advisory store.
 */
export const SubscriptionAdminViewSchema: z.ZodType<SubscriptionAdminView> = z.discriminatedUnion(
  'kind',
  [
    z.object({
      ...StoredSubscriptionFields,
      kind: z.literal('remote'),
      fetch_failure_policy: SubscriptionFetchFailurePolicySchema,
      fetch_health: SubscriptionFetchHealthSchema.nullable(),
      refresh_mode: SubscriptionRefreshModeSchema,
      manual_snapshot: SubscriptionManualSnapshotSchema.nullable(),
    }),
    z.object({
      ...StoredSubscriptionFields,
      kind: z.literal('local'),
    }),
  ],
);
/**
 * In-memory view shape. The TRUE remote/local discrimination lives in the
 * SubscriptionAdminViewSchema union above (remote requires policy + nullable
 * health; local declares neither) and is enforced at every parse; the
 * projection guarantees the same invariants at runtime (remote always sets
 * both, local always omits both). The compile-time shape stays permissive
 * because the projection's defensive `delete` on the local branch requires
 * both fields optional on the type.
 */
export interface SubscriptionAdminView {
  id: string;
  name: string;
  display_name?: string;
  enabled: boolean;
  kind: 'remote' | 'local';
  url?: string;
  ua_override?: string;
  custom_headers?: Record<string, string>;
  ttl_ms: number;
  content?: string;
  tags: string[];
  operators: StoredOperator[];
  updated_at?: number;
  fetch_failure_policy?: SubscriptionFetchFailurePolicy;
  fetch_health?: SubscriptionFetchHealth | null;
  refresh_mode?: SubscriptionRefreshMode;
  manual_snapshot?: SubscriptionManualSnapshot | null;
}

/** In-memory decoded subscription (remote branch may carry the policy). */
export interface Subscription {
  id: string;
  name: string;
  display_name?: string;
  enabled: boolean;
  kind: 'remote' | 'local';
  url?: string;
  ua_override?: string;
  custom_headers?: Record<string, string>;
  ttl_ms: number;
  content?: string;
  tags: string[];
  operators: StoredOperator[];
  updated_at?: number;
  fetch_failure_policy?: 'use-stale-cache' | 'fail-closed';
  refresh_mode?: SubscriptionRefreshMode;
  /** Server-owned optimistic identity. Missing legacy values are effective zero. */
  fetch_identity_revision?: number;
  /** Bounded definition metadata. Readers validate this unknown value before use. */
  manual_snapshot_meta?: unknown;
}
export type SubscriptionCreate = z.infer<typeof SubscriptionCreateSchema>;
export type SubscriptionUpdate = z.infer<typeof SubscriptionUpdateSchema>;
export type SubscriptionTraffic = z.infer<typeof SubscriptionTrafficSchema>;
export type SubscriptionKind = z.infer<typeof SubscriptionKindSchema>;
