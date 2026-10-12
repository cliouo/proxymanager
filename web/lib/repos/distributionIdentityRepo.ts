import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';

interface DistributionIdentity {
  id: string;
  token_version?: number;
  source?: string;
}
/** Even legacy inline bodies stay inside Redis during unauthenticated name resolution. */
export async function findDistributionIdentity(
  kind: 'subscription' | 'rule-set',
  name: string,
): Promise<DistributionIdentity | null> {
  const result = await getRedis().eval(
    `
for _, raw in ipairs(redis.call('HVALS', KEYS[1])) do
  local ok, row = pcall(cjson.decode, raw)
  if ok and type(row) == 'table' and row.name == ARGV[1] then
    return cjson.encode({ id = row.id, token_version = row.token_version, source = row.source })
  end
end
return false
`,
    [kind === 'subscription' ? REDIS_KEYS.subscriptions : REDIS_KEYS.ruleSets],
    [name],
  );
  const identity = typeof result === 'string' ? JSON.parse(result) : result;
  return identity && typeof identity.id === 'string' ? identity : null;
}
