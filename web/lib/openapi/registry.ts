import { ProxyGroupReorderSchema, RuleMoveSchema } from '@/schemas/reorder';
import { ProxyGroupSchema } from '@/schemas/proxyGroup';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from './zod';

import {
  BaseConfigSchema,
  BaseResponseSchema,
  BaseUpdateRequestSchema,
  BaseValidationResponseSchema,
  BaseValidationResultSchema,
  BatchRequestSchema,
  BatchResponseSchema,
  ProblemSchema,
  ProxyCreateSchema,
  ProxySchema,
  ProxyUpdateSchema,
  RuleCreateSchema,
  RulePatchSchema,
  RuleReplaceSchema,
  RuleSchema,
  RuleSetCreateSchema,
  RuleSetListResponseSchema,
  RuleSetMetaSchema,
  RuleSetResponseSchema,
  RuleSetSchema,
  RuleSetUpdateSchema,
  SetupBootstrapRequestSchema,
  SetupBootstrapResponseSchema,
  SetupStatusSchema,
  StringArrayResponseSchema,
  ManualSubscriptionRefreshReceiptSchema,
  SubscriptionCreateSchema,
  SubscriptionListResponseSchema,
  SubscriptionLocalFetchSpecSchema,
  SubscriptionRefreshResponseSchema,
  SubscriptionResponseSchema,
  SubscriptionSchema,
  SubscriptionUpdateSchema,
} from '@/schemas';

export const registry = new OpenAPIRegistry();

registry.register('Rule', RuleSchema);
registry.register('RuleCreate', RuleCreateSchema);
registry.register('RuleReplace', RuleReplaceSchema);
registry.register('RulePatch', RulePatchSchema);

registry.register('Subscription', SubscriptionSchema);
registry.register('SubscriptionCreate', SubscriptionCreateSchema);
registry.register('SubscriptionUpdate', SubscriptionUpdateSchema);
registry.register('SubscriptionResponse', SubscriptionResponseSchema);
registry.register('SubscriptionListResponse', SubscriptionListResponseSchema);
registry.register('SubscriptionRefreshResponse', SubscriptionRefreshResponseSchema);
registry.register('RuleSet', RuleSetSchema);
registry.register('RuleSetMeta', RuleSetMetaSchema);
registry.register('RuleSetCreate', RuleSetCreateSchema);
registry.register('RuleSetUpdate', RuleSetUpdateSchema);
registry.register('RuleSetResponse', RuleSetResponseSchema);
registry.register('RuleSetListResponse', RuleSetListResponseSchema);

registry.register('Proxy', ProxySchema);
registry.register('ProxyCreate', ProxyCreateSchema);
registry.register('ProxyUpdate', ProxyUpdateSchema);

registry.register('BaseConfig', BaseConfigSchema);
registry.register('BaseUpdateRequest', BaseUpdateRequestSchema);
registry.register('BaseValidationResult', BaseValidationResultSchema);
registry.register('SetupStatus', SetupStatusSchema);
registry.register('SetupBootstrapRequest', SetupBootstrapRequestSchema);
registry.register('SetupBootstrapResponse', SetupBootstrapResponseSchema);

registry.register('Problem', ProblemSchema);
registry.register('BatchRequest', BatchRequestSchema);
registry.register('BatchResponse', BatchResponseSchema);

registry.register('BaseResponse', BaseResponseSchema);
registry.register('BaseValidationResponse', BaseValidationResponseSchema);
registry.register('StringArrayResponse', StringArrayResponseSchema);

registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'Use the ADMIN_KEY env var as the bearer token.',
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/health',
  summary: 'Health check',
  description: 'Returns service health and Redis connectivity status. No auth required.',
  tags: ['ops'],
  security: [],
  responses: {
    200: { description: 'Healthy' },
    503: { description: 'Degraded — see checks.redis.error' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/setup/status',
  summary: 'Read setup status',
  description:
    'Returns an uncached, side-effect-free empty/recoverable/configured/blocked classification derived from raw profile, base, proxy-group, and rule inventory. Invalid schemas and WRONGTYPE storage are blocked; exact starter provenance is returned only while every starter resource still matches.',
  tags: ['setup'],
  responses: {
    200: {
      description: 'Current setup state and recovery diagnostics',
      headers: {
        'Cache-Control': {
          description: 'Always no-store because setup state is a CAS precondition.',
          schema: { type: 'string', enum: ['no-store'] },
        },
      },
      content: {
        'application/json': {
          schema: z.object({ data: SetupStatusSchema }),
        },
      },
    },
    503: {
      description: 'Redis or another status dependency is temporarily unavailable',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    500: {
      description: 'An unclassified server error occurred',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/setup/bootstrap',
  summary: 'Atomically bootstrap the starter configuration',
  description:
    'Strictly accepts expected_revision and starter-v1. The starter leaves listener ports to the importing proxy client. The server derives empty or recoverable state, preflights the exact final candidate, then atomically writes resources, provenance, a non-undoable audit event, snapshot invalidation, and one config-version bump.',
  tags: ['setup'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: SetupBootstrapRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'A server-classified recoverable default profile was completed',
      content: {
        'application/json': {
          schema: z.object({ data: SetupBootstrapResponseSchema }),
        },
      },
    },
    201: {
      description: 'Starter configuration created from an empty state',
      content: {
        'application/json': {
          schema: z.object({ data: SetupBootstrapResponseSchema }),
        },
      },
    },
    409: {
      description: 'Setup is already configured or blocked and no writes were applied',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    412: {
      description: 'Setup state changed during preflight or atomic commit',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    422: {
      description: 'The exact starter or repaired candidate is invalid',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    503: {
      description: 'Redis or final candidate validation is temporarily unavailable',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    400: {
      description: 'Request body is not valid JSON',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    500: {
      description: 'An unclassified server error occurred',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/base',
  summary: 'Read base config',
  description:
    'Returns the YAML base config text plus parsed anchors / policies metadata. The response ETag header reflects the current base.etag for use with If-Match on updates.',
  tags: ['base'],
  responses: {
    200: {
      description: 'Base config',
      content: { 'application/json': { schema: BaseResponseSchema } },
    },
    404: {
      description: 'Base config has not been initialized',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/base',
  summary: 'Replace base config',
  description:
    'Validates the exact final rendered candidate, then writes against the same config version. If no base exists, the first write is create-only; concurrent initializers cannot overwrite each other. Pass If-Match with the current etag for optimistic concurrency control on updates.',
  tags: ['base'],
  request: {
    body: { content: { 'application/json': { schema: BaseUpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Updated; body contains the new etag plus parsed metadata',
      content: { 'application/json': { schema: BaseValidationResponseSchema } },
    },
    412: {
      description:
        'Concurrency conflict: If-Match failed, the preflight config version changed, or another writer won first initialization',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    404: {
      description: 'Target profile configuration is missing',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    422: {
      description: 'Candidate YAML or exact final rendered configuration is invalid',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    503: {
      description: 'Final candidate validation is temporarily unavailable',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/base/validate',
  summary: 'Dry-run validate a base config',
  description:
    'Parses the supplied YAML and checks consistency with current rules without writing anything. Useful for UI editors.',
  tags: ['base'],
  request: {
    body: { content: { 'application/json': { schema: BaseUpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Validation result',
      content: { 'application/json': { schema: BaseValidationResponseSchema } },
    },
    422: {
      description: 'YAML invalid',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/anchors',
  summary: 'List anchor names',
  description: 'Anchor names parsed from base.yaml in order of appearance.',
  tags: ['base'],
  responses: {
    200: {
      description: 'Anchor names',
      content: { 'application/json': { schema: StringArrayResponseSchema } },
    },
    404: { description: 'Base config has not been initialized' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/subscriptions',
  summary: 'List subscriptions',
  description:
    "Upstream airport subscription sources. Every enabled subscription has its (operator-processed) nodes auto-injected into the rendered config's `proxies:` block at resolve time — see /api/v1/preview for the resolved view.",
  tags: ['subscriptions'],
  responses: {
    200: {
      description: 'Subscription list',
      content: { 'application/json': { schema: SubscriptionListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/subscriptions',
  summary: 'Create subscription',
  tags: ['subscriptions'],
  request: { body: { content: { 'application/json': { schema: SubscriptionCreateSchema } } } },
  responses: {
    201: {
      description: 'Created',
      content: { 'application/json': { schema: SubscriptionResponseSchema } },
    },
    409: {
      description: 'Name already exists',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    422: { description: 'Validation failed' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/subscriptions/{id}',
  summary: 'Get subscription',
  tags: ['subscriptions'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Subscription',
      content: { 'application/json': { schema: SubscriptionResponseSchema } },
    },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/subscriptions/{id}',
  summary: 'Replace subscription',
  tags: ['subscriptions'],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: SubscriptionCreateSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SubscriptionResponseSchema } },
      description: 'Updated',
    },
    404: { description: 'Not found' },
    409: { description: 'Name already exists' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/subscriptions/{id}',
  summary: 'Update subscription (partial)',
  tags: ['subscriptions'],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: SubscriptionUpdateSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: SubscriptionResponseSchema } },
      description: 'Updated',
    },
    404: { description: 'Not found' },
    409: { description: 'Name already exists' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/subscriptions/{id}',
  summary: 'Delete subscription',
  tags: ['subscriptions'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: 'Deleted' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/subscriptions/{id}/refresh',
  summary: 'Refresh subscription from upstream',
  description:
    "Force-fetches the upstream URL (bypasses the fetch cache — fresh-only, no stale serving), validates it parses as Clash YAML, and records actual-attempt fetch health (separate advisory value; NO definition-row write). The fresh content is cached and used at the next resolveConfig run when the subscription's nodes are injected into `/api/sub/{token}/default`. Returns the current admin view (effective fetch_failure_policy + fingerprint-matched fetch_health). Failures surface the fixed 503 (transport) / 422 (invalid upstream response) problem; the health receipt records failed-no-cache.",
  tags: ['subscriptions'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Refreshed',
      content: { 'application/json': { schema: SubscriptionRefreshResponseSchema } },
    },
    404: { description: 'Not found' },
    422: { description: 'Subscription disabled, or invalid upstream response (fixed detail)' },
    503: { description: 'Upstream fetch unavailable (fixed detail)' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/subscriptions/{id}/manual-refresh',
  summary: 'Import and activate manually fetched subscription content',
  description:
    'Accepts a bounded UTF-8 text body, validates every node and affected profile/device without network or cache side effects, then atomically stores a separate checksum-bound snapshot and switches the remote source to manual mode.',
  tags: ['subscriptions'],
  request: {
    params: z.object({ id: z.string() }),
    headers: z.object({
      'if-match': z.string(),
      'x-fetch-identity-revision': z.string(),
      'x-source': z.enum(['web', 'extension']).optional(),
    }),
    body: {
      content: {
        'text/plain': {
          schema: z
            .string()
            .describe(
              'Maximum 4,194,304 UTF-8 encoded bytes; this byte limit is not a character-count guarantee.',
            ),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Imported and activated',
      content: { 'application/json': { schema: ManualSubscriptionRefreshReceiptSchema } },
    },
    400: { description: 'Missing or malformed precondition header' },
    404: { description: 'Not found' },
    412: { description: 'Definition, fetch identity, config version, or ordinal race' },
    413: { description: 'Decoded body exceeds 4 MiB' },
    415: { description: 'Content-Type is not text/plain' },
    422: { description: 'Invalid UTF-8, empty/invalid content, or non-remote subscription' },
    500: { description: 'Invalid persisted state or unexpected failure' },
    503: { description: 'Save-time rendered-config validation unavailable' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/subscriptions/{id}/local-fetch-spec',
  summary: 'Read one authenticated no-store local-fetch input',
  description:
    'Returns only the remote fetch inputs and both optimistic revisions. This response can contain subscription credentials and must never be persisted, logged, or forwarded through the page bridge.',
  tags: ['subscriptions'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Local-fetch input',
      content: {
        'application/json': {
          schema: z.object({ data: SubscriptionLocalFetchSpecSchema }),
        },
      },
    },
    404: { description: 'Not found' },
    422: { description: 'Not a remote subscription' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sub/{token}/source/{name}',
  summary: 'Public node-only link for a single subscription',
  description:
    "Distribution endpoint: serves the subscription's processed nodes (operators 节点处理 + dedup). Default format is a Clash provider YAML (`proxies:` block only), usable directly as a mihomo proxy-provider `url:` or imported as a plain subscription; `?format=base64` serves a universal share-link subscription (one `ss://`/`vmess://`/… URI per line, base64-encoded — importable by Shadowrocket / v2rayN-class clients; nodes that cannot be expressed as a share link are skipped and counted in `X-Skipped-Nodes`). The upstream source URL is never exposed. Validates SUB_TOKEN; disabled subscriptions return 404. Sends `Subscription-Userinfo` when upstream traffic info is known, a content-addressed ETag (If-None-Match → 304), and `X-Stale: 1` when serving the stale-on-error cache. `?noCache=1` forces a fresh upstream attempt and disables stale serving and collection-member skipping for this request (fresh-only semantics). A direct subscription export never skips a failed member: transport failures return 503 and invalid-upstream-response failures return 422, both with fixed credential-free details.",
  tags: ['subscriptions'],
  security: [],
  request: {
    params: z.object({ token: z.string(), name: z.string() }),
    query: z.object({
      format: z.enum(['clash', 'base64']).optional(),
      noCache: z.enum(['1']).optional(),
    }),
  },
  responses: {
    200: { description: 'Provider YAML (`proxies:` only), or base64 share-link list' },
    304: { description: 'ETag matched If-None-Match' },
    401: { description: 'Bad token' },
    404: { description: 'Unknown or disabled subscription' },
    422: { description: 'Invalid upstream response (fixed detail)' },
    503: { description: 'Upstream fetch unavailable (fixed detail)' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sub/{token}/collection/{name}',
  summary: 'Public node-only link for a collection (聚合订阅)',
  description:
    "Distribution endpoint: merges the collection's enabled member subscriptions (explicit ids + tag matches, member order), runs the collection's own operators 节点处理 over the merged union, dedups first-writer-wins, and serves the result. Default format is a Clash provider YAML; `?format=base64` serves a universal share-link subscription (one URI per line, base64-encoded — importable by Shadowrocket / v2rayN-class clients; unrepresentable nodes are skipped and counted in `X-Skipped-Nodes`). `{name}` matches the collection slug first, then the collection id when it looks like a UUID, then the display name as a legacy fallback (URL-encoded CJK ok). P-FFP v1 member policy: an enabled member with a tolerant (use-stale-cache) policy whose fresh attempt fails with an eligible typed error is skipped (`X-Skipped-Members`, fixed category text only) unless a validated stale cache was served; strict (fail-closed) members, ineligible failures and `?noCache=1` requests are NEVER skipped. The request fails with the first typed failure in member order when every member is skipped (503 transport / 422 invalid-upstream-response), and with 422 when the collection has no enabled members. Disabled collections return 404.",
  tags: ['subscriptions'],
  security: [],
  request: {
    params: z.object({ token: z.string(), name: z.string() }),
    query: z.object({
      format: z.enum(['clash', 'base64']).optional(),
      noCache: z.enum(['1']).optional(),
    }),
  },
  responses: {
    200: { description: 'Merged provider YAML (`proxies:` only), or base64 share-link list' },
    304: { description: 'ETag matched If-None-Match' },
    400: { description: 'Aggregate candidate node limit exceeded' },
    401: { description: 'Bad token' },
    404: { description: 'Unknown or disabled collection' },
    422: { description: 'No enabled members, or invalid upstream response (fixed detail)' },
    503: { description: 'Every member unavailable (fixed detail)' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/rule-sets',
  summary: 'List rule sets',
  description:
    'User-maintained rule-set files (the YAML blobs referenced by base.yaml `rule-providers`). MVP supports text/yaml content, served verbatim at /api/rule-providers/{token}/{name}. List items are meta-only — `content` is returned by the {id} detail endpoint.',
  tags: ['rule-sets'],
  responses: {
    200: {
      content: { 'application/json': { schema: RuleSetListResponseSchema } },
      description: 'Rule set list',
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/rule-sets',
  summary: 'Create rule set',
  tags: ['rule-sets'],
  request: { body: { content: { 'application/json': { schema: RuleSetCreateSchema } } } },
  responses: {
    201: {
      content: { 'application/json': { schema: RuleSetResponseSchema } },
      description: 'Created',
    },
    409: { description: 'Name already exists' },
    422: { description: 'Validation failed' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/rule-sets/{id}',
  summary: 'Get rule set',
  tags: ['rule-sets'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: RuleSetResponseSchema } },
      description: 'Rule set',
    },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/rule-sets/{id}',
  summary: 'Replace rule set',
  tags: ['rule-sets'],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: RuleSetCreateSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: RuleSetResponseSchema } },
      description: 'Updated',
    },
    404: { description: 'Not found' },
    409: { description: 'Name already exists' },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/rule-sets/{id}',
  summary: 'Update rule set (partial)',
  tags: ['rule-sets'],
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: RuleSetUpdateSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: RuleSetResponseSchema } },
      description: 'Updated',
    },
    404: { description: 'Not found' },
    409: { description: 'Name already exists' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/rule-sets/{id}',
  summary: 'Delete rule set',
  tags: ['rule-sets'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    204: { description: 'Deleted' },
    404: { description: 'Not found' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rule-providers/{token}/{name}',
  summary: 'Public rule-provider endpoint',
  description:
    'Mihomo `rule-providers` `url:` target. Validates SUB_TOKEN, streams the rule-set content verbatim.',
  tags: ['rule-sets'],
  security: [],
  request: { params: z.object({ token: z.string(), name: z.string() }) },
  responses: {
    200: { description: 'Rule-set body (text/yaml or text/plain)' },
    401: { description: 'Bad token' },
    404: { description: 'Unknown rule-set name' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/policies',
  summary: 'List valid rule policies',
  description:
    'Policies that rules may reference: managed proxy-groups (the hash, rank order) merged with base.yaml literals (leftover groups / hand-written proxies / built-ins).',
  tags: ['base'],
  responses: {
    200: {
      description: 'Policy names',
      content: { 'application/json': { schema: StringArrayResponseSchema } },
    },
    404: { description: 'Base config has not been initialized' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/resolved-snapshot',
  summary: 'Last render summary snapshot',
  description:
    'Summary of the most recent successful render (node names, collisions, per-subscription status, warnings, anchor stats). Read-only, one Redis GET — never triggers the render pipeline or upstream subscription fetches. `data` is null when nothing has been rendered yet.',
  tags: ['base'],
  responses: {
    200: { description: 'Snapshot, or null when never rendered' },
  },
});

// Stable profile IDs are the preferred editing contract. Cookie/name scope is
// retained only for compatibility with clients predating explicit ID support.
const ProfileScopeQuery = z.object({
  profileId: z
    .uuid()
    .optional()
    .describe('Stable editing profile ID. Invalid/missing records never fall back to default.'),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe('Legacy profile name. When ID is also supplied both must identify the same profile.'),
});
const versionMeta = z.object({
  profileId: z.uuid(),
  configVersion: z.number().int().nonnegative(),
});
const countMap = z.record(z.string(), z.number().int().nonnegative());
const ruleSummary = z.object({
  total: z.number(),
  active: z.number(),
  disabled: z.number(),
  policies: countMap,
  ruleSets: countMap,
  anchors: z.record(z.string(), z.object({ total: z.number(), active: z.number() })),
});
registry.register('ProxyGroupReorder', ProxyGroupReorderSchema);
registry.register('RuleMove', RuleMoveSchema);
registry.register('RuleSummary', ruleSummary);
registry.registerPath({
  method: 'get',
  path: '/api/v1/meta',
  summary: 'Instance and profile metadata',
  request: { query: ProfileScopeQuery },
  responses: {
    200: {
      description: 'Includes profile ID capability; available before a default base exists.',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              capabilities: z.object({ profileIdScope: z.literal(true) }),
              hasBase: z.boolean(),
              subBase: z.string(),
              subscriptionUrl: z.string(),
              buildId: z.string().nullable(),
            }),
          }),
        },
      },
    },
    400: { description: 'Invalid or conflicting explicit profile scope' },
    404: { description: 'Explicit profile missing' },
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/rules',
  summary: 'Page rules in a stable config snapshot',
  request: {
    query: ProfileScopeQuery.extend({
      limit: z.coerce.number().min(1).max(500).optional(),
      offset: z.coerce.number().min(0).optional(),
      q: z.string().optional().describe('Search value, note and options'),
      anchor: z.string().optional(),
      policy: z.string().optional(),
      type: z.string().optional(),
      enabled: z.enum(['true', 'false']).optional(),
      sort: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Filtered page with stable ID tie-breaking',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(RuleSchema),
            meta: versionMeta.extend({ total: z.number(), limit: z.number(), offset: z.number() }),
          }),
        },
      },
    },
    412: { description: 'Concurrent changes prevented a stable read; retry' },
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/rules/summary',
  summary: 'Complete rule counts for the current profile',
  request: { query: ProfileScopeQuery },
  responses: {
    200: {
      description: 'Includes all rules regardless of page limit, including disabled references',
      content: {
        'application/json': { schema: z.object({ data: ruleSummary, meta: versionMeta }) },
      },
    },
    412: { description: 'Concurrent changes prevented a stable read' },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/rules/batch',
  summary: 'Apply distinct rule operations in one final candidate',
  description:
    'Repeated update/delete IDs reject the entire batch with 422 before preflight, storage or audit. Merge fields into one patch. Distinct IDs retain 200/207 semantics.',
  request: {
    query: ProfileScopeQuery,
    body: { required: true, content: { 'application/json': { schema: BatchRequestSchema } } },
  },
  responses: {
    200: {
      description: 'All operations applied',
      content: { 'application/json': { schema: BatchResponseSchema } },
    },
    207: { description: 'Per-operation results; successful candidates committed together' },
    422: { description: 'Duplicate IDs or final configuration invalid' },
    412: { description: 'Concurrent modification; no candidate writes applied' },
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/proxy-groups',
  summary: 'Read all profile groups with a stable configuration version',
  request: { query: ProfileScopeQuery },
  responses: {
    200: {
      description: 'Group order and version for atomic reorder',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ProxyGroupSchema),
            meta: versionMeta.extend({ total: z.number() }),
          }),
        },
      },
    },
    412: { description: 'Concurrent changes prevented a stable read' },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/proxy-groups/reorder',
  summary: 'Atomically reorder every group in a profile',
  description:
    'orderedIds must contain the full profile group set exactly once. Validates the final rendered config, commits once with CAS, and records one non-undoable audit.',
  request: {
    query: ProfileScopeQuery,
    body: { required: true, content: { 'application/json': { schema: ProxyGroupReorderSchema } } },
  },
  responses: {
    200: {
      description: 'Complete new group order',
      content: { 'application/json': { schema: z.object({ data: z.array(ProxyGroupSchema) }) } },
    },
    412: { description: 'Stale version; order unchanged' },
    422: { description: 'Invalid ID set or final configuration' },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/rules/{id}/move',
  summary: 'Move a rule against its true anchor neighbor across pages',
  request: {
    query: ProfileScopeQuery,
    params: z.object({ id: z.uuid() }),
    body: { required: true, content: { 'application/json': { schema: RuleMoveSchema } } },
  },
  responses: {
    200: {
      description: 'Complete new same-anchor sequence (no-op at the edge)',
      content: { 'application/json': { schema: z.object({ data: z.array(RuleSchema) }) } },
    },
    404: { description: 'Rule not in this profile' },
    412: { description: 'Stale version; order unchanged' },
    422: { description: 'Invalid final configuration or MATCH terminal violation' },
  },
});
for (const resource of ['subscriptions', 'collections'])
  registry.registerPath({
    method: 'get',
    path: `/api/v1/${resource}/{id}/usage`,
    summary: 'Read safe source usage relationships',
    request: { params: z.object({ id: z.uuid() }) },
    responses: {
      200: {
        description: 'Profile and collection names/IDs only; no source credentials',
        content: {
          'application/json': {
            schema: z.object({
              data: z.object({
                profiles: z.array(z.object({ id: z.uuid(), name: z.string() })),
                collections: z.array(z.object({ id: z.uuid(), name: z.string() })),
              }),
              meta: z.object({ configVersion: z.number() }),
            }),
          },
        },
      },
      404: { description: 'Source missing' },
      412: { description: 'Concurrent changes prevented a stable read' },
    },
  });
for (const definition of registry.definitions) {
  if (definition.type !== 'route') continue;
  const route = definition.route;
  if (!/^\/api\/v1\/(?:base|anchors|policies|rule-sets|resolved-snapshot)(?:\/|$)/.test(route.path))
    continue;
  route.request = { ...route.request, query: ProfileScopeQuery };
}
