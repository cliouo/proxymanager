import { z } from '@/lib/openapi/zod';

/**
 * pass-8 blocker 1: the SINGLE external `src-` alias contract.
 *
 * Every model/API/workspace surface that ACCEPTS rename-template source
 * aliases uses this refinement STRUCTURALLY — plain stable keys, s0/s1
 * ordinals, ref-like and UUID-like strings fail at parse with one bounded,
 * insertion-order-independent error before any target/config/membership/
 * repository read. Stored/internal records keep the trusted plain
 * `Record<string,string>` schema (storage holds stable keys only — the
 * trusted apply boundary performs the single reverse translation).
 */
export const EXTERNAL_SRC_KEY_RE = /^src-[0-9a-f]{16}$/;

/** One bounded failure for every invalid external alias payload. */
export const ALIAS_ERROR = '来源别名格式不合法：只能使用不透明的 src- 句柄作为键。';

export const ExternalSourceAliasesSchema = z
  .record(
    z.string().refine((key) => EXTERNAL_SRC_KEY_RE.test(key), ALIAS_ERROR),
    z.string().min(1).max(40, '来源别名过长'),
  )
  .refine((v) => Object.keys(v).length <= 64, '来源别名表过大（最多 64 项）')
  .optional()
  .describe('来源别名：键必须是 src- 不透明句柄（Record<src-句柄, string>），值≤40 字、≤64 项');
