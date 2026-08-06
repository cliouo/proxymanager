import { z } from '@/lib/openapi/zod';
import { RuleSchema } from './rule';

/**
 * The audit log supports two kinds of ops:
 *
 *  - First-party rule mutations (the original M1c CRUD path). Op enum values
 *    `rule.create | rule.update | rule.delete`, target.kind='rule'.
 *  - Scenario mutations dispatched through `POST /api/v1/ops`. Op is namespaced
 *    as `${scenarioId}.${action}` (e.g. `chained-proxy.set-dialer`,
 *    `regional-groups.add-node`). Target is whatever the scenario produces.
 *
 * The schema deliberately accepts both via union: legacy `rule.*` ops keep
 * `ruleId` for backward compat with already-recorded events; scenario ops
 * always populate `target` and may also fill `ruleId` for rule-bearing
 * scenarios (e.g. the migrated rule-anchor-append scenario).
 */
export const AuditTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rule'), id: z.string().min(1) }),
  z.object({ kind: z.literal('proxy'), name: z.string().min(1) }),
  z.object({ kind: z.literal('proxy-group'), name: z.string().min(1) }),
  z.object({ kind: z.literal('rule-set'), name: z.string().min(1) }),
  z.object({ kind: z.literal('base'), field: z.string().optional() }),
  z.object({ kind: z.literal('profile') }),
  /** 设备层 (P1)。`name` 冗余存一份,历史页要显示「设备 · {name}」而设备可能已被删。 */
  z.object({ kind: z.literal('device'), id: z.string().min(1), name: z.string().min(1) }),
  /** 智能命名:被命名算子写入的订阅源 / 聚合订阅。`name` 供历史页渲染。 */
  z.object({
    kind: z.literal('naming-source'),
    type: z.enum(['subscription', 'collection']),
    id: z.string().min(1),
    name: z.string().min(1),
  }),
]);

export const AuditOpSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/i.test(v), {
    message: 'op must be dotted segments, e.g. "rule.create" or "chained-proxy.set-dialer"',
  });

export const AuditEventSchema = z.object({
  id: z.uuid(),
  ts: z.number().int(),
  op: AuditOpSchema,
  actor: z.string().min(1),
  /** Legacy/back-compat field for `rule.*` events. Scenario ops use `target` instead. */
  ruleId: z.string().min(1).optional(),
  target: AuditTargetSchema.optional(),
  /** Pre-mutation snapshot. Shape depends on op — typed as unknown so scenarios can carry richer payloads. */
  before: z.unknown().optional(),
  /** Post-mutation snapshot. */
  after: z.unknown().optional(),
  /** Event id of the undo that reversed this entry, if any. */
  undone_by: z.uuid().optional(),
  /** When this event itself is an undo, points at the original event. */
  undoes: z.uuid().optional(),
  /** False when the operation deliberately has no safe registered inverse. */
  undoable: z.boolean().optional(),
  /** Global shared-source authority marker used by administrator naming
   * events. Other event kinds omit it. */
  scope: z.literal('global').optional(),
  /**
   * The profile this mutation targeted (Phase 2: base/rules/proxy-groups are
   * per-profile). Optional for back-compat with pre-Phase-2 events; undo falls
   * back to the `default` profile when absent.
   */
  profileId: z.string().min(1).optional(),
});

/** Convenience type for events known to target a rule (still carry a typed snapshot). */
export const RuleAuditEventSchema = AuditEventSchema.extend({
  before: RuleSchema.optional(),
  after: RuleSchema.optional(),
});

/**
 * THE strict specialized naming-audit projection — the ONLY payload shape
 * the naming repository boundary (commitEntityWithNamingHistory) accepts
 * (pass-2 findings). Built exactly by buildNamingAudit; `.strict()` rejects
 * every unknown key, every string is bounded, `op` is the naming enum, ids
 * are canonical UUIDs, `undoable` can never be true for a naming event, and
 * profile-scoped assistant writes require `profileId`; the authenticated
 * global web workspace instead records `scope: global` without pretending
 * one consuming profile authorized a shared-source mutation. The RAW
 * placeholder DSL template is never
 * persisted: `after` carries only a bounded structural summary (placeholder
 * count + length). The repository re-validates every persisted string
 * recursively AFTER this schema (sanitization stability + credential-shaped
 * material + raw-DSL fail-closed), so a payload can only reach storage when
 * the schema AND the deep walk agree.
 */
export const NamingAuditEventSchema = z
  .object({
    id: z.uuid(),
    ts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER, 'ts 超出安全整数范围'),
    op: z.enum(['naming.apply', 'naming.rollback']),
    actor: z.string().min(1).max(64),
    target: z
      .object({
        kind: z.literal('naming-source'),
        type: z.enum(['subscription', 'collection']),
        id: z.uuid(),
        name: z.string().min(1).max(64),
      })
      .strict(),
    /** Pre-mutation naming state: absent managed stage, or `hadManaged`. */
    before: z.union([z.null(), z.object({ hadManaged: z.literal(true) }).strict()]),
    /** Post-mutation naming state: bounded structural template summary +
     * mode. The raw DSL string itself is never persisted (pass-2 finding). */
    after: z
      .object({
        templateSummary: z
          .object({
            /** Number of placeholder tokens in the template (closed DSL). */
            placeholderCount: z.number().int().min(0).max(32),
            /** Template string length (structural, not the string itself). */
            length: z.number().int().min(0).max(512),
          })
          .strict(),
        mode: z.enum(['added', 'replaced', 'removed']),
      })
      .strict(),
    /** Naming writes have no registered inverse — never true. */
    undoable: z.literal(false),
    /** Present only for the administrator workspace's global-source write. */
    scope: z.literal('global').optional(),
    /** Required for profile-scoped assistant writes; forbidden for a global
     * workspace write so the audit never attributes it to an unrelated
     * active profile. */
    profileId: z.uuid().optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.scope === 'global') {
      if (event.profileId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['profileId'],
          message: '全局命名审计不能绑定配置文件',
        });
      }
      return;
    }
    if (event.profileId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['profileId'],
        message: '配置文件作用域命名审计必须绑定配置文件',
      });
    }
  });

export type NamingAuditEvent = z.infer<typeof NamingAuditEventSchema>;

export type AuditOp = z.infer<typeof AuditOpSchema>;
export type AuditTarget = z.infer<typeof AuditTargetSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
