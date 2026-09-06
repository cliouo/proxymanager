import { z } from '@/lib/openapi/zod';

export const ProxyGroupReorderSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  orderedIds: z
    .array(z.uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'ID 不得重复'),
});
export const RuleMoveSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  direction: z.enum(['up', 'down']),
});
