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

describe('legacy profile repair actions', () => {
  const repairs = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      filter: '(?i)(?<![A-Za-z])USA?(?![A-Za-z])',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      filter: '(?i)(?<![A-Za-z])DEU?(?![A-Za-z])',
    },
  ];

  it('registers a read preflight and one confirmation-gated write', () => {
    expect(getAction('preview_legacy_profile_repair')?.risk).toBe('read');
    expect(getAction('repair_legacy_profile')?.risk).toBe('write');
  });

  it('requires both preview guards on the write input', () => {
    const action = getAction('repair_legacy_profile');
    expect(action?.input.safeParse({ alias: '直连', repairs, expected_version: 7 }).success).toBe(
      false,
    );
    expect(
      action?.input.safeParse({
        alias: '直连',
        repairs,
        expected_version: 7,
        expected_base_etag: 'feedfacefeedface',
      }).success,
    ).toBe(true);
  });

  it('requires two distinct filter repairs with at least one field each', () => {
    const action = getAction('preview_legacy_profile_repair');
    expect(action?.input.safeParse({ alias: '直连', repairs: [repairs[0]] }).success).toBe(false);
    expect(
      action?.input.safeParse({
        alias: '直连',
        repairs: [repairs[0], { id: repairs[0].id, exclude_filter: 'test' }],
      }).success,
    ).toBe(false);
    expect(
      action?.input.safeParse({
        alias: '直连',
        repairs: [repairs[0], { id: repairs[1].id }],
      }).success,
    ).toBe(false);
  });
});

describe('legacy chain profile repair actions', () => {
  const repairs = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      filter: '(?i)(?<![A-Za-z])USA?(?![A-Za-z])',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      filter: '(?i)(?<![A-Za-z])DEU?(?![A-Za-z])',
    },
  ];

  it('registers the narrow read preflight and confirmation-gated write', () => {
    expect(getAction('preview_legacy_chain_profile_repair')?.risk).toBe('read');
    expect(getAction('repair_legacy_chain_profile')?.risk).toBe('write');
  });

  it('requires a special chain/source repair and both write guards', () => {
    const preview = getAction('preview_legacy_chain_profile_repair');
    const write = getAction('repair_legacy_chain_profile');
    expect(preview?.input.safeParse({ alias: '直连', repairs }).success).toBe(false);
    expect(
      preview?.input.safeParse({
        alias: '直连',
        repairs,
        quarantine_spx_subscription_id: '33333333-3333-4333-8333-333333333333',
      }).success,
    ).toBe(true);
    expect(
      write?.input.safeParse({
        alias: '直连',
        repairs,
        quarantine_spx_subscription_id: '33333333-3333-4333-8333-333333333333',
        expected_version: 7,
      }).success,
    ).toBe(false);
    expect(
      write?.input.safeParse({
        alias: '直连',
        repairs,
        quarantine_spx_subscription_id: '33333333-3333-4333-8333-333333333333',
        expected_version: 7,
        expected_base_etag: 'feedfacefeedface',
      }).success,
    ).toBe(true);
  });
});
