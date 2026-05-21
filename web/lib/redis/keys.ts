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
} as const;
