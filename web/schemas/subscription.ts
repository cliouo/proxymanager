import { z } from 'zod';
import { OperatorSchema } from './operator';

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

export const SubscriptionSchema = z.object({
  id: z.uuid(),
  name: z
    .string()
    .min(1, '标识不能为空')
    .regex(/^[a-z0-9-]+$/, '标识只能包含小写字母、数字和短横线（-）'),
  /**
   * Human-facing label shown in the UI (Chinese welcome). Purely cosmetic —
   * `name` remains the stable slug identifier used in public links and group
   * bindings. Falls back to `name` when empty.
   */
  display_name: z.string().optional(),
  enabled: z.boolean(),
  /**
   * Source type. Defaults to 'remote' so legacy records (which only had
   * `url`) parse correctly through safeParse.
   */
  kind: SubscriptionKindSchema.default('remote'),
  /** Required when kind=remote. */
  url: z.url().optional(),
  /** Per-sub UA override (legacy: ua_override). */
  ua_override: z.string().optional(),
  /** Extra request headers attached to remote fetches. */
  custom_headers: z.record(z.string(), z.string()).optional(),
  /** Per-sub fetch cache TTL in ms. */
  ttl_ms: z.number().int().positive().default(DEFAULT_SUBSCRIPTION_TTL_MS),
  /** Required when kind=local — inline Clash provider YAML (just a `proxies:` block). */
  content: z.string().optional(),
  /** Tags used by Collections for `subscription_tags` auto-inclusion. */
  tags: z.array(z.string()).default([]),
  /**
   * Ordered node-processing pipeline (界面「节点处理」). Applied to this
   * sub's parsed proxies after fetch/normalise; see lib/proxies/operators.ts.
   * Cross-source same-name collisions are handled by the dedup step here and
   * by global first-writer-wins dedup — there is no separate name prefix.
   */
  operators: z.array(OperatorSchema).default([]),
  /** Last successful sync time (ms epoch via Date.now). */
  last_synced_at: z.number().int().optional(),
  /** Sub-Userinfo header parse from the last successful fetch. */
  last_traffic: SubscriptionTrafficSchema.optional(),
  /** Last fetch error message — surfaced in the UI status badge. */
  last_error: z.string().optional(),
});

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
    url: z.url().optional(),
    ua_override: z.string().optional(),
    custom_headers: z.record(z.string(), z.string()).optional(),
    ttl_ms: z.number().int().positive().default(DEFAULT_SUBSCRIPTION_TTL_MS),
    content: z.string().optional(),
    tags: z.array(z.string()).default([]),
    operators: z.array(OperatorSchema).default([]),
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
  url: z.url().optional(),
  ua_override: z.string().optional(),
  custom_headers: z.record(z.string(), z.string()).optional(),
  ttl_ms: z.number().int().positive().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  operators: z.array(OperatorSchema).optional(),
});

export type Subscription = z.infer<typeof SubscriptionSchema>;
export type SubscriptionCreate = z.infer<typeof SubscriptionCreateSchema>;
export type SubscriptionUpdate = z.infer<typeof SubscriptionUpdateSchema>;
export type SubscriptionTraffic = z.infer<typeof SubscriptionTrafficSchema>;
export type SubscriptionKind = z.infer<typeof SubscriptionKindSchema>;
