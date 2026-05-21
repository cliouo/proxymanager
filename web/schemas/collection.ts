import { z } from 'zod';

/**
 * Aggregation over multiple Subscriptions — Sub-Store calls this 组合订阅.
 * A Collection is referenced from base.yaml's `pm-inline-collections:`
 * top-level field; at render time the renderer pulls every subscription
 * it points at (explicit ids + auto-include by matching tags), merges
 * their proxy lists with the configured dedup + prefix policy, and
 * appends the result into the rendered config's `proxies:` block.
 */

export const CollectionSchema = z.object({
  id: z.uuid(),
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes'),
  /** Explicit subscription ids — in order; duplicates ignored. */
  subscription_ids: z.array(z.uuid()).default([]),
  /** Auto-include any sub whose tags contains one of these. */
  subscription_tags: z.array(z.string()).default([]),
  /**
   * How to dedupe nodes after merging upstream YAMLs.
   *   - 'name': drop entries with the same `name`
   *   - 'server-port': drop entries with the same `server:port` pair (legitimate dups when one airport offers the same nodes through multiple subs)
   *   - 'none': keep everything (rename collisions will surface as Mihomo errors)
   */
  dedup_by: z.enum(['name', 'server-port', 'none']).default('name'),
  /**
   * Prepended to each member's name. Use to disambiguate when two
   * subscriptions ship a node with the same name (e.g. `[airport-A] HK01`).
   * Applied after dedup so dedup respects upstream names.
   */
  name_prefix: z.string().optional(),
  notes: z.string().optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
});

export const CollectionCreateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes'),
  subscription_ids: z.array(z.uuid()).default([]),
  subscription_tags: z.array(z.string()).default([]),
  dedup_by: z.enum(['name', 'server-port', 'none']).default('name'),
  name_prefix: z.string().optional(),
  notes: z.string().optional(),
});

export const CollectionUpdateSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes')
    .optional(),
  subscription_ids: z.array(z.uuid()).optional(),
  subscription_tags: z.array(z.string()).optional(),
  dedup_by: z.enum(['name', 'server-port', 'none']).optional(),
  name_prefix: z.string().optional(),
  notes: z.string().optional(),
});

export type Collection = z.infer<typeof CollectionSchema>;
export type CollectionCreate = z.infer<typeof CollectionCreateSchema>;
export type CollectionUpdate = z.infer<typeof CollectionUpdateSchema>;
