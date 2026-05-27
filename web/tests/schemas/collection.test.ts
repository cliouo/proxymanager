import { describe, expect, it } from 'vitest';
import { CollectionSchema } from '@/schemas';

describe('CollectionSchema — Phase-C migration', () => {
  it('parses a legacy record that carried dedup_by + name_prefix and silently drops them', () => {
    // Records persisted before Phase C carried these fields. Zod strips unknown
    // keys by default, so safeParse should succeed and the result must not
    // contain `dedup_by` / `name_prefix`. This is the migration path — no
    // separate rewrite script needed.
    const legacy = {
      id: 'd6f9c5a1-7e8b-4f1a-9c2d-3e4f5a6b7c8d',
      name: 'legacy-pool',
      subscription_ids: [],
      subscription_tags: ['asia'],
      // Removed in Phase C — should be dropped silently:
      dedup_by: 'name',
      name_prefix: '[X] ',
      notes: 'kept',
      updated_at: 1716000000,
    };

    const parsed = CollectionSchema.parse(legacy);
    expect(parsed.name).toBe('legacy-pool');
    expect(parsed.notes).toBe('kept');
    expect((parsed as Record<string, unknown>).dedup_by).toBeUndefined();
    expect((parsed as Record<string, unknown>).name_prefix).toBeUndefined();

    // New fields take their defaults when missing.
    expect(parsed.enabled).toBe(true);
    expect(parsed.type).toBe('select');
  });

  it('round-trips a fresh record with the new fields', () => {
    const fresh = {
      id: 'd6f9c5a1-7e8b-4f1a-9c2d-3e4f5a6b7c8d',
      name: 'fresh-pool',
      enabled: false,
      type: 'select' as const,
      subscription_ids: [],
      subscription_tags: [],
    };
    const parsed = CollectionSchema.parse(fresh);
    expect(parsed.enabled).toBe(false);
    expect(parsed.type).toBe('select');
  });

  it('rejects an invalid `type` value (only `select` allowed in MVP)', () => {
    expect(() =>
      CollectionSchema.parse({
        id: 'd6f9c5a1-7e8b-4f1a-9c2d-3e4f5a6b7c8d',
        name: 'p',
        type: 'url-test',
        subscription_ids: [],
        subscription_tags: [],
      }),
    ).toThrow();
  });
});
