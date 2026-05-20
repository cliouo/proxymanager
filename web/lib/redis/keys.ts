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
} as const;
