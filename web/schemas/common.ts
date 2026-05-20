import { z } from 'zod';

export const RuleTypeSchema = z.enum([
  'DOMAIN',
  'DOMAIN-SUFFIX',
  'DOMAIN-KEYWORD',
  'DOMAIN-REGEX',
  'RULE-SET',
  'GEOIP',
  'GEOSITE',
  'IP-CIDR',
  'IP-CIDR6',
  'IP-ASN',
  'SRC-IP-CIDR',
  'DST-PORT',
  'SRC-PORT',
  'PROCESS-NAME',
  'PROCESS-PATH',
  'NETWORK',
  'MATCH',
]);

export const RuleSourceSchema = z.enum(['manual', 'speedtest', 'import']);

export const PaginationMetaSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

export type RuleType = z.infer<typeof RuleTypeSchema>;
export type RuleSource = z.infer<typeof RuleSourceSchema>;
export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;
