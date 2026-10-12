import { mutationPlanning as planning, type MutationPlan } from './mutationContext';
import { createHash } from 'node:crypto';
import { getRedis } from '@/lib/redis/client';
import { REDIS_KEYS } from '@/lib/redis/keys';
import { ProblemDetailsError } from '@/lib/http/problem';
import { buildEvents, persistBuiltEvents, trimEvents, type RecordInput } from './auditRepo';
import type { AuditEvent } from '@/schemas';

export async function afterConfigCommit(effect: () => Promise<unknown>): Promise<void> {
  const context = planning.getStore();
  if (context) context.effects.push(effect);
  else await effect();
}

/** A scenario plans one preflighted CAS. No config is written until its audit is ready. */
export async function evalConfigMutation(script: string, keys: string[], args: string[]) {
  const context = planning.getStore();
  if (!context) return getRedis().eval(script, keys, args);
  if (context.mutation)
    throw new Error('An audited operation must use one atomic configuration commit.');
  context.mutation = { script, keys, args };
  return [1, String(Number(args[0]) + 1)];
}

export interface OperationIdentity {
  id: string;
  fingerprint: string;
}
export function operationIdentity(
  request: Request,
  payload: unknown,
): OperationIdentity | undefined {
  const id = request.headers.get('idempotency-key');
  if (id === null) return undefined;
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(id))
    throw ProblemDetailsError.badRequest('Invalid Idempotency-Key.');
  return {
    id,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([new URL(request.url).pathname, payload]))
      .digest('hex'),
  };
}

/** Core events and optional replay receipt land in the same CAS as the config. */
export async function auditedMutation<T>(
  plan: () => Promise<{ data: T; events: RecordInput[] }>,
  identity?: OperationIdentity,
): Promise<{ data: T; events: AuditEvent[] }> {
  const receiptKey = `operation:${identity?.id ?? crypto.randomUUID()}`;
  if (identity) {
    const receipt = await getRedis().get<{
      fingerprint: string;
      result: { data: T; events: AuditEvent[] };
    }>(receiptKey);
    if (receipt) {
      if (receipt.fingerprint !== identity.fingerprint)
        throw ProblemDetailsError.conflict(
          'Idempotency-Key was already used for a different operation.',
        );
      return receipt.result;
    }
  }
  const context: MutationPlan = { effects: [], events: [] };
  const planned = await planning.run(context, plan);
  const result = {
    data: planned.data,
    events: [...context.events, ...(planned.events.length ? buildEvents(planned.events) : [])],
  };
  const mutation = context.mutation;
  if (!mutation) {
    // Empty configuration write sets can still carry audit events and advisory writes.
    await persistBuiltEvents(result.events);
    await Promise.all(context.effects.map((effect) => effect().catch(() => undefined)));
    return result;
  }
  const keyOffset = mutation.keys.length;
  const argOffset = mutation.args.length;
  // Validate the audit key types BEFORE executing the configuration script.
  // Redis scripts are isolated, but runtime errors do not roll back earlier commands.
  const script = `
local auditIndex = KEYS[${keyOffset + 1}]
local auditBody = KEYS[${keyOffset + 2}]
local receiptKey = KEYS[${keyOffset + 3}]
local receipt = redis.call('GET', receiptKey)
if receipt then return {4, receipt} end
local indexType = redis.call('TYPE', auditIndex).ok
local bodyType = redis.call('TYPE', auditBody).ok
if (indexType ~= 'none' and indexType ~= 'zset') or (bodyType ~= 'none' and bodyType ~= 'hash') then
  return redis.error_reply('Invalid audit storage type')
end
local events = cjson.decode(ARGV[${argOffset + 1}])
-- Validate undo links before changing configuration.
for _, eventRaw in ipairs(events) do
  local event = cjson.decode(eventRaw)
  if event.undoes then
    local original = redis.call('HGET', auditBody, event.undoes)
    if not original or cjson.decode(original).undone_by then return {0, 'undo-conflict'} end
  end
end
local function applyConfig()
${mutation.script}
end
local applied = applyConfig()
if applied[1] ~= 1 then return applied end
for _, eventRaw in ipairs(events) do
  local event = cjson.decode(eventRaw)
  redis.call('ZADD', auditIndex, event.ts, event.id)
  redis.call('HSET', auditBody, event.id, eventRaw)
  if event.undoes then
    local originalRaw = redis.call('HGET', auditBody, event.undoes)
    local original = cjson.decode(originalRaw)
    if not original.undone_by then
      -- Preserve original JSON arrays (Redis cjson re-encodes empty [] as {}).
      local trimmed = string.match(originalRaw, '^(.-)%s*$')
      local linked = string.sub(trimmed, 1, -2) .. ',"undone_by":' .. cjson.encode(event.id) .. '}'
      redis.call('HSET', auditBody, event.undoes, linked)
    end
  end
end
if ARGV[${argOffset + 2}] ~= '' then
  redis.call('SET', receiptKey, ARGV[${argOffset + 2}], 'EX', 86400)
end
return applied
`;
  const response = (await getRedis().eval(
    script,
    [...mutation.keys, REDIS_KEYS.audit.events, REDIS_KEYS.audit.byId, receiptKey],
    [
      ...mutation.args,
      JSON.stringify(result.events.map((event) => JSON.stringify(event))),
      identity ? JSON.stringify({ fingerprint: identity.fingerprint, result }) : '',
    ],
  )) as [number, string];
  if (response[0] === 4) {
    const receipt = typeof response[1] === 'string' ? JSON.parse(response[1]) : response[1];
    if (receipt.fingerprint !== identity?.fingerprint)
      throw ProblemDetailsError.conflict(
        'Idempotency-Key was already used for a different operation.',
      );
    return receipt.result;
  }
  if (response[0] !== 1)
    throw ProblemDetailsError.preconditionFailed('配置或历史记录已被修改，请刷新后重试。');
  // Retention is maintenance, never a reason to report a committed operation as failed.
  await Promise.all(context.effects.map((effect) => effect().catch(() => undefined)));
  await trimEvents().catch(() => undefined);
  return result;
}

/** For services whose existing recordEvent calls already build sanitized snapshots. */
export function atomicService<TArgs extends unknown[], TResult>(
  service: (...args: TArgs) => Promise<TResult>,
) {
  return async (...args: TArgs): Promise<TResult> => {
    if (planning.getStore()) return service(...args);
    return (await auditedMutation(async () => ({ data: await service(...args), events: [] }))).data;
  };
}
