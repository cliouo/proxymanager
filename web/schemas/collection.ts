import { z } from 'zod';
import { OperatorSchema } from './operator';

/**
 * A node pool — an aggregate subscription that merges the nodes of several
 * member subscriptions (explicit ids + tag matches). Its public link and the
 * resolve pipeline emit the deduped union of member nodes.
 *
 * User-facing identity mirrors a single subscription: a free-text `name`
 * (display, Chinese welcome) plus a stable `slug` identifier used in the
 * public link path. After the member nodes are merged, the collection's own
 * `operators` pipeline (界面「节点处理」) runs over the whole set, exactly
 * like a single sub's pipeline — see lib/proxies/operators.ts.
 *
 * Cross-source dedup is handled globally (first-writer-wins); there is no
 * per-source name prefix.
 */

export const CollectionGroupTypeSchema = z.enum(['select']);

export const CollectionSchema = z.object({
  id: z.uuid(),
  /**
   * Display label. Free text (Chinese welcome). Looked up by `id` or `slug`,
   * never by this name.
   */
  name: z.string().min(1, '名称不能为空'),
  /**
   * Stable slug identifier used in the public distribution link path. Lower
   * kebab-case so it is URL-safe; immutable after creation. Optional only for
   * backward-compat with pre-slug records (a migration backfills it).
   */
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, '标识只能用小写字母 / 数字 / -')
    .optional(),
  /** When false, the collection's proxy-group is not emitted into the resolved config. */
  enabled: z.boolean().default(true),
  /** Mihomo proxy-group type. MVP supports `select` only; future phases may add url-test / fallback. */
  type: CollectionGroupTypeSchema.default('select'),
  /** Explicit subscription ids — in order; duplicates ignored. */
  subscription_ids: z.array(z.uuid()).default([]),
  /** Auto-include any sub whose tags contains one of these. */
  subscription_tags: z.array(z.string()).default([]),
  /**
   * Ordered node-processing pipeline (界面「节点处理」). Applied to the merged
   * member nodes before dedup; same operator set as a single subscription.
   */
  operators: z.array(OperatorSchema).default([]),
  notes: z.string().optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
});

export const CollectionCreateSchema = z.object({
  name: z.string().min(1, '名称不能为空'),
  slug: z.string().regex(/^[a-z0-9-]+$/, '标识只能用小写字母 / 数字 / -'),
  enabled: z.boolean().default(true),
  type: CollectionGroupTypeSchema.default('select'),
  subscription_ids: z.array(z.uuid()).default([]),
  subscription_tags: z.array(z.string()).default([]),
  operators: z.array(OperatorSchema).default([]),
  notes: z.string().optional(),
});

export const CollectionUpdateSchema = z.object({
  name: z.string().min(1, '名称不能为空').optional(),
  // slug is immutable after creation — intentionally not updatable.
  enabled: z.boolean().optional(),
  type: CollectionGroupTypeSchema.optional(),
  subscription_ids: z.array(z.uuid()).optional(),
  subscription_tags: z.array(z.string()).optional(),
  operators: z.array(OperatorSchema).optional(),
  // P1-5: null clears the note (undefined = unchanged).
  notes: z.string().nullable().optional(),
});

export type Collection = z.infer<typeof CollectionSchema>;
export type CollectionCreate = z.infer<typeof CollectionCreateSchema>;
export type CollectionUpdate = z.infer<typeof CollectionUpdateSchema>;
export type CollectionGroupType = z.infer<typeof CollectionGroupTypeSchema>;
