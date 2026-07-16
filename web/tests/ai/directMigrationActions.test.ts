import { describe, expect, it } from 'vitest';
import { getAction } from '@/lib/ai/actions/registry';

describe('direct alias migration actions', () => {
  it('registers a read preflight and a confirmation-gated write', () => {
    expect(getAction('preview_direct_alias_migration')?.risk).toBe('read');
    expect(getAction('migrate_direct_alias')?.risk).toBe('write');
  });

  it('requires both preview guards on the write input', () => {
    const action = getAction('migrate_direct_alias');
    expect(action?.input.safeParse({ alias: '直连', expected_version: 7 }).success).toBe(false);
    expect(
      action?.input.safeParse({
        alias: '直连',
        expected_version: 7,
        expected_base_etag: 'feedfacefeedface',
      }).success,
    ).toBe(true);
  });

  it('rejects control characters and the built-in name as aliases', () => {
    const action = getAction('migrate_direct_alias');
    for (const alias of ['bad\nname', 'DIRECT']) {
      expect(
        action?.input.safeParse({
          alias,
          expected_version: 7,
          expected_base_etag: 'feedfacefeedface',
        }).success,
      ).toBe(false);
    }
  });
});
