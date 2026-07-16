import { describe, expect, it } from 'vitest';
import {
  mergeWithTemplate,
  ProxyGroupCreateSchema,
  ProxyGroupTemplateSchema,
  ProxyGroupTemplateUpdateSchema,
  ProxyGroupUpdateSchema,
  type ProxyGroup,
} from '@/schemas';

describe('proxy-group fixed Mihomo type surface', () => {
  it('accepts the four fixed types and rejects removed relay', () => {
    for (const type of ['select', 'url-test', 'fallback', 'load-balance']) {
      expect(
        ProxyGroupCreateSchema.safeParse({ name: 'synthetic', type, proxies: ['DIRECT'] }).success,
      ).toBe(true);
    }
    expect(
      ProxyGroupCreateSchema.safeParse({
        name: 'legacy-relay',
        type: 'relay',
        proxies: ['DIRECT'],
      }).success,
    ).toBe(false);
  });

  it('round-trips a concrete empty-fallback through create/update/template merge', () => {
    const created = ProxyGroupCreateSchema.parse({
      name: 'dynamic',
      type: 'select',
      'include-all-proxies': true,
      'empty-fallback': 'DIRECT',
    });
    expect(created['empty-fallback']).toBe('DIRECT');
    expect(ProxyGroupUpdateSchema.parse({ 'empty-fallback': null })).toEqual({
      'empty-fallback': null,
    });
    expect(ProxyGroupTemplateUpdateSchema.parse({ 'empty-fallback': null })).toEqual({
      'empty-fallback': null,
    });

    const template = ProxyGroupTemplateSchema.parse({
      id: crypto.randomUUID(),
      name: 'safe-default',
      updated_at: 1,
      'empty-fallback': 'REJECT',
    });
    const group = {
      id: crypto.randomUUID(),
      kind: 'all',
      name: 'all-nodes',
      type: 'select',
      rank: 10,
      updated_at: 1,
      'include-all-proxies': true,
    } as ProxyGroup;
    expect(mergeWithTemplate(group, template)['empty-fallback']).toBe('REJECT');
    expect(
      mergeWithTemplate({ ...group, 'empty-fallback': 'DIRECT' }, template)['empty-fallback'],
    ).toBe('DIRECT');
  });

  it('accepts pipe-separated fixed AdapterTypes and rejects silent no-op spellings', () => {
    expect(
      ProxyGroupCreateSchema.safeParse({
        name: 'valid',
        type: 'select',
        proxies: ['DIRECT'],
        'exclude-type': 'Direct|Reject|URLTest',
      }).success,
    ).toBe(true);
    for (const value of ['Direct,Reject', 'Direct |Reject', 'Direct||Reject', 'Direct|direct']) {
      expect(
        ProxyGroupCreateSchema.safeParse({
          name: 'invalid',
          type: 'select',
          proxies: ['DIRECT'],
          'exclude-type': value,
        }).success,
      ).toBe(false);
    }
  });
});
