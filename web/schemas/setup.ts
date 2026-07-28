import { z } from '@/lib/openapi/zod';

export const SETUP_STARTER_VERSION = 'starter-v1' as const;

const SafeRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SetupStateSchema = z.enum(['empty', 'recoverable', 'configured', 'blocked']);

export const SetupDiagnosticSchema = z.object({
  code: z.string().min(1),
  component: z.enum(['profile', 'base', 'proxy-groups', 'rules', 'storage', 'provenance']),
  message: z.string().min(1),
  repairable: z.boolean(),
});

export const SetupProvenanceSchema = z
  .object({
    starter_version: z.literal(SETUP_STARTER_VERSION),
    expected_revision: SafeRevisionSchema,
    completed_revision: SafeRevisionSchema,
    created: z.boolean(),
    profile_id: z.uuid(),
    base_etag: z.string().regex(/^[0-9a-f]{16}$/u),
    build_id: z.string().regex(/^[0-9a-f]{8}$/u),
    proxy_group_ids: z.array(z.uuid()).length(2),
    rule_ids: z.array(z.uuid()).length(1),
    audit_event_id: z.uuid(),
  })
  .strict();

export const SetupStarterSummarySchema = z.object({
  profile_name: z.literal('default'),
  listener_ports: z.literal('client-managed'),
  allow_lan: z.literal(false),
  mode: z.literal('rule'),
  log_level: z.literal('info'),
  dns_enabled: z.literal(false),
  tun_enabled: z.literal(false),
  sniffer_enabled: z.literal(false),
  rule_sets_total: z.literal(0),
  proxy_groups: z.tuple([
    z.object({ name: z.literal('自动选择'), type: z.literal('url-test') }),
    z.object({ name: z.literal('默认'), type: z.literal('select') }),
  ]),
  final_rule: z.literal('MATCH,默认'),
});

export const SetupInventorySchema = z.object({
  profiles_total: z.number().int().nonnegative(),
  profiles_valid: z.number().int().nonnegative(),
  profiles_invalid: z.number().int().nonnegative(),
  default_profile_id: z.uuid().nullable(),
  has_base: z.boolean(),
  base_content_present: z.boolean(),
  base_meta_present: z.boolean(),
  proxy_groups_total: z.number().int().nonnegative(),
  proxy_groups_invalid: z.number().int().nonnegative(),
  rules_total: z.number().int().nonnegative(),
  rules_invalid: z.number().int().nonnegative(),
  source_type: z.enum(['none', 'subscription', 'collection']).nullable(),
});

export const SetupStatusSchema = z.object({
  state: SetupStateSchema,
  can_bootstrap: z.boolean(),
  revision: SafeRevisionSchema,
  starter_version: z.literal(SETUP_STARTER_VERSION),
  reason_codes: z.array(z.string().min(1)),
  inventory: SetupInventorySchema,
  starter: SetupStarterSummarySchema,
  provenance: SetupProvenanceSchema.nullable(),
  diagnostics: z.array(SetupDiagnosticSchema),
});

export const SetupBootstrapRequestSchema = z
  .object({
    expected_revision: SafeRevisionSchema,
    starter_version: z.literal(SETUP_STARTER_VERSION),
  })
  .strict();

export const SetupBootstrapResponseSchema = z.object({
  state: z.literal('configured'),
  created: z.boolean(),
  revision: SafeRevisionSchema,
  starter_version: z.literal(SETUP_STARTER_VERSION),
  profile: z.object({
    id: z.uuid(),
    name: z.literal('default'),
    source: z.object({ type: z.literal('none') }),
  }),
  provenance: SetupProvenanceSchema,
  resources: z.object({
    base_etag: z.string().regex(/^[0-9a-f]{16}$/u),
    build_id: z.string().regex(/^[0-9a-f]{8}$/u),
    proxy_group_ids: z.array(z.uuid()).length(2),
    rule_ids: z.array(z.uuid()).length(1),
  }),
  readiness: z.object({
    config_renderable: z.literal(true),
    source: z.literal('unbound'),
    distribution_available: z.literal(true),
  }),
});

export type SetupDiagnostic = z.infer<typeof SetupDiagnosticSchema>;
export type SetupProvenance = z.infer<typeof SetupProvenanceSchema>;
export type SetupApiStatus = z.infer<typeof SetupStatusSchema>;
export type SetupBootstrapRequest = z.infer<typeof SetupBootstrapRequestSchema>;
export type SetupBootstrapApiResponse = z.infer<typeof SetupBootstrapResponseSchema>;
