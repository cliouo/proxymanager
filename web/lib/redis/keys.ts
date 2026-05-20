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
} as const;
