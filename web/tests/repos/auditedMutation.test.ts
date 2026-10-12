import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  exec: vi.fn(),
  eval: vi.fn(),
  hset: vi.fn(),
  zadd: vi.fn(),
}));
vi.mock('@/lib/redis/client', () => ({
  getRedis: () => ({ multi: () => storage, eval: storage.eval }),
}));
import { afterConfigCommit, atomicService, auditedMutation } from '@/lib/repos/auditedMutation';
import { recordEvent } from '@/lib/repos/auditRepo';

beforeEach(() => {
  vi.clearAllMocks();
  storage.exec.mockResolvedValue([]);
  storage.eval.mockResolvedValue(0);
});

describe('audited operations without a configuration CAS', () => {
  it('runs deferred effects even when there are no events', async () => {
    const effect = vi.fn().mockResolvedValue(1);
    const result = await auditedMutation(async () => {
      await afterConfigCommit(effect);
      expect(effect).not.toHaveBeenCalled();
      return { data: 'unchanged', events: [] };
    });
    expect(effect).toHaveBeenCalledOnce();
    expect(result).toEqual({ data: 'unchanged', events: [] });
    expect(storage.exec).not.toHaveBeenCalled();
  });

  it('persists both collected and returned events with their original IDs', async () => {
    let collected;
    const result = await auditedMutation(async () => {
      collected = await recordEvent({ op: 'rule.create', actor: 'test' });
      return { data: 'result', events: [{ op: 'rule.delete', actor: 'test' }] };
    });
    expect(result.data).toBe('result');
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual(collected);
    expect(storage.hset).toHaveBeenCalledWith(
      'audit:by_id',
      Object.fromEntries(result.events.map((event) => [event.id, event])),
    );
    expect(storage.exec).toHaveBeenCalledOnce();
  });

  it('retains events collected by atomicService when its write set is empty', async () => {
    const service = atomicService(async () => {
      await recordEvent({ op: 'proxy-groups.reorder', actor: 'test', after: [] });
      return [];
    });
    expect(await service()).toEqual([]);
    expect(storage.hset).toHaveBeenCalledOnce();
    expect(storage.exec).toHaveBeenCalledOnce();
  });

  it('keeps auxiliary effect and retention failures from losing the audit', async () => {
    storage.eval.mockRejectedValueOnce(new Error('retention unavailable'));
    const effect = vi.fn().mockRejectedValue(new Error('taxonomy unavailable'));
    const result = await auditedMutation(async () => {
      await afterConfigCommit(effect);
      return { data: true, events: [{ op: 'rule.update', actor: 'test' }] };
    });
    expect(result.events).toHaveLength(1);
    expect(effect).toHaveBeenCalledOnce();
    expect(storage.exec).toHaveBeenCalledOnce();
  });

  it('does not run effects or persist collected events if planning fails', async () => {
    const effect = vi.fn();
    await expect(
      auditedMutation(async () => {
        await afterConfigCommit(effect);
        await recordEvent({ op: 'rule.update', actor: 'test' });
        throw new Error('invalid candidate');
      }),
    ).rejects.toThrow('invalid candidate');
    expect(effect).not.toHaveBeenCalled();
    expect(storage.exec).not.toHaveBeenCalled();
  });
});
