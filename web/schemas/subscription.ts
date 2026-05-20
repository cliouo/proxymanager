import { z } from 'zod';

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
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'must contain only lowercase letters, digits, and dashes'),
  url: z.url(),
  enabled: z.boolean(),
  ua_override: z.string().optional(),
  last_synced_at: z.number().int().optional(),
  last_traffic: SubscriptionTrafficSchema.optional(),
});

export const SubscriptionCreateSchema = SubscriptionSchema.omit({
  id: true,
  last_synced_at: true,
  last_traffic: true,
});

export const SubscriptionUpdateSchema = SubscriptionCreateSchema.partial();

export type Subscription = z.infer<typeof SubscriptionSchema>;
export type SubscriptionCreate = z.infer<typeof SubscriptionCreateSchema>;
export type SubscriptionUpdate = z.infer<typeof SubscriptionUpdateSchema>;
export type SubscriptionTraffic = z.infer<typeof SubscriptionTrafficSchema>;
