import { z } from 'zod';

/**
 * A managed "配置文件 / profile". Today there's exactly one — `default` — and
 * the route `/api/v1/preview/[profile]` is hardcoded to it. This entity is
 * introduced now so subscription binding lives on a profile-shaped record
 * (instead of being bolted onto `base`), giving real multi-profile management
 * a stable place to grow without a second migration.
 *
 * Field surface stays minimal for Phase 1:
 *   - `name`            — kebab-case identifier (resolver looks up by name).
 *   - `subscription_ids` — explicit binding. Empty array = "use every enabled
 *     subscription" (backward-compat with pre-Profile behaviour).
 *
 * Fields reserved for Phase 2 (multi-profile content overlays) — intentionally
 * NOT in the schema yet so we don't ship dead fields:
 *   - `base_content_overlay`    — per-profile YAML skeleton overrides
 *   - `rule_anchor_overrides`   — per-profile rule routing differences
 *   - `proxy_group_overrides`   — per-profile group set
 *
 * Adding those is purely additive; existing records parse forward.
 */

const NAME_REGEX = /^[a-z0-9-]+$/;
const NAME_HINT = 'must contain only lowercase letters, digits, and dashes';

export const ProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT),
  /**
   * Subscriptions this profile pulls nodes from. Empty array → fall back to
   * every `enabled` subscription (legacy behaviour). Order is preserved so a
   * preferred sub can win deterministically against later collisions.
   */
  subscription_ids: z.array(z.uuid()).default([]),
  notes: z.string().optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int(),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileCreateSchema = z.object({
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT),
  subscription_ids: z.array(z.uuid()).default([]),
  notes: z.string().optional(),
});

export type ProfileCreate = z.input<typeof ProfileCreateSchema>;

export const ProfileUpdateSchema = z.object({
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT).optional(),
  subscription_ids: z.array(z.uuid()).optional(),
  notes: z.string().nullable().optional(),
});

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

/** The single profile name supported in Phase 1 — until multi-profile CRUD UI ships. */
export const DEFAULT_PROFILE_NAME = 'default';
