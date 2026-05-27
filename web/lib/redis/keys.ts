export const REDIS_KEYS = {
  base: {
    content: 'base:content',
    meta: 'base:meta',
  },
  rules: 'rules',
  subscriptions: 'subscriptions',
  proxies: 'proxies',
  ruleSets: 'rule-sets',
  idempotency: (key: string) => `idem:${key}`,
  /**
   * Audit log. `events` is a ZSET (score=ts ms, member=event id) used for
   * time-ordered listing. `byId` is a Hash keyed by event id storing the
   * full payload as JSON. Kept consistent via pipelined writes.
   */
  audit: {
    events: 'audit:events',
    byId: 'audit:by_id',
  },
  /**
   * Project-defined taxonomy that doesn't live in base.yaml. Used by
   * scenarios to distinguish proxy-groups by user intent (regional vs
   * platform vs custom) when the Clash schema treats them identically.
   * Hash keyed by group name → JSON {kind, region?, color?}.
   */
  taxonomy: {
    groups: 'taxonomy:groups',
  },
  /**
   * Fetch cache for remote subscription bodies. Each entry is a standalone
   * Redis key with EX TTL so it auto-expires; we don't use a Hash because
   * Upstash doesn't expose per-field TTL.
   */
  fetchCache: (cacheKey: string): string => `fetch-cache:${cacheKey}`,
  /**
   * Aggregated subscription collections. Hash keyed by collection id.
   */
  collections: 'collections',
  /**
   * Managed proxy-groups (策略组). Hash keyed by group id. Values include
   * every native mihomo proxy-group field plus our metadata (kind/section/
   * rank/template_id/notes). Migrated out of base.yaml's `proxy-groups:`
   * block — base now only carries a `# === PROXY-GROUPS ===` marker.
   */
  proxyGroups: 'proxy-groups',
  /**
   * Shared-defaults templates for proxy-groups (the moral equivalent of the
   * `&pr` YAML anchor). Hash keyed by template id; referenced by
   * proxyGroups via `template_id`.
   */
  proxyGroupTemplates: 'proxy-group-templates',
  /**
   * Cached summary of the most recent successful resolveConfig() — node
   * names, collisions, per-sub status. Readers (UI pickers, AI tools) that
   * only need the resolved node list can hit this instead of re-running the
   * pipeline. Invalidated on subscription mutations and on every successful
   * resolveConfig (which rewrites it). Plain Redis key with a long EX as a
   * safety net in case an invalidation call is missed.
   */
  resolvedSnapshot: 'resolved:snapshot',
  /**
   * Pending AI write confirmations. Each is a standalone key with a short
   * EX TTL holding the {actor, action, input} to execute once the user
   * authorises it; consumed atomically (one-time) via GETDEL.
   */
  assistantConfirm: (token: string): string => `assistant:confirm:${token}`,
  /**
   * Per-conversation assistant transcript (full message thread incl. tool
   * calls / tool results / reasoning_content), so follow-up turns keep the
   * context the model already gathered. Standalone key with EX TTL.
   */
  assistantSession: (id: string): string => `assistant:session:${id}`,
} as const;
