import { z } from '@/lib/openapi/zod';
import { RuleCreateSchema, RulePatchSchema } from './rule';

export const BatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), rule: RuleCreateSchema }),
  z.object({ op: z.literal('update'), id: z.uuid(), patch: RulePatchSchema }),
  z.object({ op: z.literal('delete'), id: z.uuid() }),
]);

export const BatchRequestSchema = z
  .object({
    ops: z.array(BatchOpSchema).min(1).max(500),
  })
  .superRefine(({ ops }, ctx) => {
    const seen = new Map<string, number>();
    ops.forEach((op, index) => {
      if (op.op === 'create') return;
      const first = seen.get(op.id);
      if (first !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['ops', index, 'id'],
          message: `与 ops.${first} 重复：同一批次每条规则只允许一次操作，请合并修改`,
        });
      else seen.set(op.id, index);
    });
  });

export const BatchOpResultSchema = z.object({
  status: z.number().int(),
  data: z.unknown().optional(),
  error: z
    .object({
      title: z.string(),
      detail: z.string().optional(),
    })
    .optional(),
});

export const BatchResponseSchema = z.object({
  results: z.array(BatchOpResultSchema),
});

export type BatchOp = z.infer<typeof BatchOpSchema>;
export type BatchRequest = z.infer<typeof BatchRequestSchema>;
export type BatchOpResult = z.infer<typeof BatchOpResultSchema>;
export type BatchResponse = z.infer<typeof BatchResponseSchema>;
