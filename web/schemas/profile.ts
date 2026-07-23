import { z } from 'zod';

/**
 * A managed "配置文件 / profile". Today there's exactly one — `default` — and
 * the route `/api/v1/preview/[profile]` is hardcoded to it. This entity is
 * introduced now so subscription binding lives on a profile-shaped record
 * (instead of being bolted onto `base`), giving real multi-profile management
 * a stable place to grow without a second migration.
 *
 * Field surface stays minimal for Phase 1:
 *   - `name`   — kebab-case identifier (resolver looks up by name).
 *   - `source` — the SINGLE node source this profile pulls from. Exactly one of:
 *       · `{ type: 'none' }`                 unbound — inject no subscription
 *                                            nodes (the DEFAULT for a fresh
 *                                            profile; you pick a source later)
 *       · `{ type: 'subscription', id }`     one single subscription
 *       · `{ type: 'collection', id }`       one 聚合订阅 (its members merged)
 *     Want multiple airports? Build a collection and bind that — the profile
 *     itself never fans out to a hand-picked list (that was the multi-bind
 *     model we deliberately dropped).
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

/**
 * Human-facing subscription name. UNLIKE `name` (the kebab-case URL/file slug),
 * this is free-form (Chinese, spaces, emoji all fine) and is what proxy clients
 * show after importing the sub link — it becomes the Content-Disposition
 * filename on `/api/sub/{token}/{profile}`. Empty/unset → clients fall back to
 * the generated `proxymanager-{name}` default.
 */
const DISPLAY_NAME_MAX = 120;

/**
 * 「普通配置文件」还是「模版」。存量记录没有这个字段 → 默认 `normal`，parse-forward
 * 无需回填迁移。模版的语义与普通配置文件**完全一致**（可编辑、可预览、可激活），
 * 只差三件事：不对外分发（`/api/sub/{token}/{profile}` 404）、UI 单列一节加徽章、
 * 新建流把它置顶为「从模版新建」。判定与文案见 `lib/profiles/kind.ts`。
 */
export const ProfileKindSchema = z.enum(['normal', 'template']);

export type ProfileKind = z.infer<typeof ProfileKindSchema>;

/** Single-select node source. Discriminated on `type`. */
export const ProfileSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('subscription'), id: z.uuid() }),
  z.object({ type: z.literal('collection'), id: z.uuid() }),
]);

export type ProfileSource = z.infer<typeof ProfileSourceSchema>;

/** Default for a fresh profile — unbound, injects no subscription nodes. */
export const DEFAULT_PROFILE_SOURCE: ProfileSource = { type: 'none' };

export const ProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT),
  /** Free-form name clients display after import (Content-Disposition). */
  display_name: z.string().max(DISPLAY_NAME_MAX).optional(),
  /** The single source this profile resolves nodes from. See file header. */
  source: ProfileSourceSchema.default(DEFAULT_PROFILE_SOURCE),
  /** 普通配置文件 / 模版。缺字段的存量记录 parse-forward 成 `normal`。 */
  kind: ProfileKindSchema.default('normal'),
  notes: z.string().optional(),
  created_at: z.number().int().optional(),
  updated_at: z.number().int(),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const ProfileCreateSchema = z.object({
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT),
  display_name: z.string().max(DISPLAY_NAME_MAX).optional(),
  source: ProfileSourceSchema.default(DEFAULT_PROFILE_SOURCE),
  kind: ProfileKindSchema.default('normal'),
  notes: z.string().optional(),
  /**
   * Clone source (Phase 2). When set to an existing profile id, the new profile
   * deep-copies that profile's base + proxy-groups + rules + taxonomy (new ids,
   * names preserved). When omitted, the new profile gets a fresh skeleton copied
   * from the `default` profile's base with no groups/rules. Not persisted on the
   * Profile record — it's a create-time directive only.
   */
  copy_from: z.uuid().optional(),
});

export type ProfileCreate = z.input<typeof ProfileCreateSchema>;

export const ProfileUpdateSchema = z.object({
  name: z.string().min(1).regex(NAME_REGEX, NAME_HINT).optional(),
  display_name: z.string().max(DISPLAY_NAME_MAX).nullable().optional(),
  source: ProfileSourceSchema.optional(),
  /** 可在普通配置文件与模版之间互转 —— 转换只改这一个字段，不动任何内容。 */
  kind: ProfileKindSchema.optional(),
  notes: z.string().nullable().optional(),
});

export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;

/** The single profile name supported in Phase 1 — until multi-profile CRUD UI ships. */
export const DEFAULT_PROFILE_NAME = 'default';
