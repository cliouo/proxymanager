import { z } from '@/lib/openapi/zod';
import { BaseConfigSchema, BaseValidationResultSchema } from './base';
import { RuleSetMetaSchema, RuleSetSchema } from './ruleSet';
import { SubscriptionAdminViewSchema } from './subscription';

export const BaseResponseSchema = z.object({ data: BaseConfigSchema });
export const BaseValidationResponseSchema = z.object({ data: BaseValidationResultSchema });
export const StringArrayResponseSchema = z.object({ data: z.array(z.string()) });

// P-FFP v1: every subscription API response uses the ADMIN VIEW — remote rows
// carry the effective fetch_failure_policy + fingerprint-joined fetch_health,
// local rows omit both.
export const SubscriptionResponseSchema = z.object({ data: SubscriptionAdminViewSchema });
export const SubscriptionListResponseSchema = z.object({
  data: z.array(SubscriptionAdminViewSchema),
  meta: z.object({ total: z.number().int().nonnegative() }),
});
export const SubscriptionRefreshResponseSchema = z.object({
  data: SubscriptionAdminViewSchema,
  meta: z.object({ proxyCount: z.number().int().nonnegative() }),
});

export const RuleSetResponseSchema = z.object({ data: RuleSetSchema });
// List responses carry meta only — `content` lives behind the [id] detail route.
export const RuleSetListResponseSchema = z.object({
  data: z.array(RuleSetMetaSchema),
  meta: z.object({ total: z.number().int().nonnegative() }),
});

export type BaseResponse = z.infer<typeof BaseResponseSchema>;
export type BaseValidationResponse = z.infer<typeof BaseValidationResponseSchema>;
export type StringArrayResponse = z.infer<typeof StringArrayResponseSchema>;
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;
export type SubscriptionListResponse = z.infer<typeof SubscriptionListResponseSchema>;
export type SubscriptionRefreshResponse = z.infer<typeof SubscriptionRefreshResponseSchema>;
export type RuleSetResponse = z.infer<typeof RuleSetResponseSchema>;
export type RuleSetListResponse = z.infer<typeof RuleSetListResponseSchema>;
