import './setup';
import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

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
  StringArrayResponseSchema,
  SubscriptionCreateSchema,
  SubscriptionListResponseSchema,
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
    'Validates the new YAML, checks that all existing rules still reference valid anchors / policies, then writes atomically. Pass If-Match with the current etag for optimistic concurrency control.',
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
      description: 'If-Match etag did not match current value',
      content: { 'application/problem+json': { schema: ProblemSchema } },
    },
    422: {
      description: 'YAML invalid, or new base would orphan existing rules',
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
    "Force-fetches the upstream URL (bypasses the fetch cache), validates it parses as Clash YAML, and records sync time + traffic info. The fresh content is cached and used at the next resolveConfig run when the subscription's nodes are injected into `/api/sub/{token}/default`.",
  tags: ['subscriptions'],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Refreshed',
      content: { 'application/json': { schema: SubscriptionRefreshResponseSchema } },
    },
    400: { description: 'Upstream fetch failed' },
    404: { description: 'Not found' },
    422: { description: 'Subscription disabled' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sub/{token}/source/{name}',
  summary: 'Public node-only link for a single subscription',
  description:
    "Distribution endpoint: serves the subscription's processed nodes (operators 节点处理 + dedup) as a Clash provider YAML (`proxies:` block only). Usable directly as a mihomo proxy-provider `url:` or imported as a plain subscription — the upstream source URL is never exposed. Validates SUB_TOKEN; disabled subscriptions return 404. Sends `Subscription-Userinfo` when upstream traffic info is known, a content-addressed ETag (If-None-Match → 304), and `X-Stale: 1` when serving the stale-on-error cache. `?noCache=1` bypasses the fetch cache.",
  tags: ['subscriptions'],
  security: [],
  request: { params: z.object({ token: z.string(), name: z.string() }) },
  responses: {
    200: { description: 'Provider YAML (`proxies:` only)' },
    304: { description: 'ETag matched If-None-Match' },
    401: { description: 'Bad token' },
    404: { description: 'Unknown or disabled subscription' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sub/{token}/collection/{name}',
  summary: 'Public node-only link for a collection (聚合订阅)',
  description:
    "Distribution endpoint: merges the collection's enabled member subscriptions (explicit ids + tag matches, member order), runs the collection's own operators 节点处理 over the merged union, dedups first-writer-wins, and serves the result as a Clash provider YAML. `{name}` matches the collection slug first, then the collection id when it looks like a UUID, then the display name as a legacy fallback (URL-encoded CJK ok). Failed members are skipped (`X-Skipped-Members`); the request only fails when every member fails. Disabled collections return 404.",
  tags: ['subscriptions'],
  security: [],
  request: { params: z.object({ token: z.string(), name: z.string() }) },
  responses: {
    200: { description: 'Merged provider YAML (`proxies:` only)' },
    304: { description: 'ETag matched If-None-Match' },
    400: { description: 'Every member fetch failed' },
    401: { description: 'Bad token' },
    404: { description: 'Unknown or disabled collection' },
    422: { description: 'Collection has no enabled members' },
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
