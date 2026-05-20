import { z } from 'zod';

export const ProblemSchema = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(z.unknown()).optional(),
  })
  .loose();

export type Problem = z.infer<typeof ProblemSchema>;
