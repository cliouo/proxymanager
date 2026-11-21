import { z } from '@/lib/openapi/zod';
import { LINE_TAGS } from '@/lib/proxies/naming';
import { regionByCode } from '@/lib/proxies/regions';
import { containsSensitivePattern } from '@/lib/proxies/namingSanitize';

const label = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .refine((v) => !containsSensitivePattern(v), '识别值含敏感信息');

export const NodeRecognitionFactsSchema = z
  .object({
    region: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .refine((v) => regionByCode(v) !== undefined, '未知地区')
      .optional(),
    tags: z.array(z.enum(LINE_TAGS)).max(LINE_TAGS.length).optional(),
    rate: z.number().positive().max(999.99).optional(),
    route: z.enum(['中转', '直连', '落地', '入口']).optional(),
    vendor: label.optional(),
    info: z.boolean().optional(),
  })
  .strict();

export const NodeFactsSchema = z
  .record(z.string().regex(/^[a-f0-9]{16}$/), NodeRecognitionFactsSchema)
  .refine((facts) => Object.keys(facts).length <= 2000, '节点识别事实最多 2000 条');
