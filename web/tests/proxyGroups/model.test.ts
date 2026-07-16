import { describe, expect, it } from 'vitest';
import { fromGroup, toPayload, yamlPreview } from '@/app/(authed)/proxy-groups/_lib/model';
import type { ProxyGroup } from '@/schemas';

describe('proxy-group editor model', () => {
  it('round-trips empty-fallback and pipe-separated exclude-type', () => {
    const group = {
      id: crypto.randomUUID(),
      kind: 'all',
      name: 'dynamic',
      type: 'select',
      rank: 10,
      updated_at: 1,
      'include-all-proxies': true,
      'empty-fallback': 'DIRECT',
      'exclude-type': 'Direct|Reject',
    } as ProxyGroup;

    const payload = toPayload(fromGroup(group));
    expect(payload).toMatchObject({
      'empty-fallback': 'DIRECT',
      'exclude-type': 'Direct|Reject',
    });
    expect(yamlPreview(payload)).toContain('empty-fallback: DIRECT');
  });
});
