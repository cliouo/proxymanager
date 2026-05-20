import { z } from 'zod';
import { BaseConfigSchema, BaseValidationResultSchema } from './base';
import { RuleSetSchema } from './ruleSet';
import { SubscriptionSchema } from './subscription';

export const BaseResponseSchema = z.object({ data: BaseConfigSchema });
export const BaseValidationResponseSchema = z.object({ data: BaseValidationResultSchema });
export const StringArrayResponseSchema = z.object({ data: z.array(z.string()) });

export const SubscriptionResponseSchema = z.object({ data: SubscriptionSchema });
export const SubscriptionListResponseSchema = z.object({
  data: z.array(SubscriptionSchema),
  meta: z.object({ total: z.number().int().nonnegative() }),
});
export const SubscriptionRefreshResponseSchema = z.object({
  data: SubscriptionSchema,
  meta: z.object({ proxyCount: z.number().int().nonnegative() }),
});

export const RuleSetResponseSchema = z.object({ data: RuleSetSchema });
export const RuleSetListResponseSchema = z.object({
  data: z.array(RuleSetSchema),
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
