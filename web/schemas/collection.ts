import { z } from 'zod';

/**
 * A node pool — a managed `proxy-group` produced from a set of
 * subscriptions. At resolve time, ProxyManager emits one group per enabled
 * Collection whose `proxies:` field lists the node names of its member
 * subscriptions (after each sub's `node_prefix` + operator pipeline). Users
 * reference the pool by name in their rules and in `proxy-groups`
 * (e.g. as a dialer-proxy for chained-proxy).
 *
 * Phase-A note: cross-source dedup and per-source name prefixing are now
 * handled globally in resolveConfig (dedup) and on each Subscription
 * (`node_prefix`). The legacy `dedup_by` / `name_prefix` fields on the
 * Collection are gone — Collections only describe pool membership now.
 */

export const CollectionGroupTypeSchema = z.enum(['select']);

export const CollectionSchema = z.object({
  id: z.uuid(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes'),
  /** When false, the collection's proxy-group is not emitted into the resolved config. */
  enabled: z.boolean().default(true),
  /** Mihomo proxy-group type. MVP supports `select` only; future phases may add url-test / fallback. */
  type: CollectionGroupTypeSchema.default('select'),
  /** Explicit subscription ids — in order; duplicates ignored. */
  subscription_ids: z.array(z.uuid()).default([]),
  /** Auto-include any sub whose tags contains one of these. */
  subscription_tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
});

export const CollectionCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes'),
  enabled: z.boolean().default(true),
  type: CollectionGroupTypeSchema.default('select'),
  subscription_ids: z.array(z.uuid()).default([]),
  subscription_tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const CollectionUpdateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes')
    .optional(),
  enabled: z.boolean().optional(),
  type: CollectionGroupTypeSchema.optional(),
  subscription_ids: z.array(z.uuid()).optional(),
  subscription_tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export type Collection = z.infer<typeof CollectionSchema>;
export type CollectionCreate = z.infer<typeof CollectionCreateSchema>;
export type CollectionUpdate = z.infer<typeof CollectionUpdateSchema>;
export type CollectionGroupType = z.infer<typeof CollectionGroupTypeSchema>;
