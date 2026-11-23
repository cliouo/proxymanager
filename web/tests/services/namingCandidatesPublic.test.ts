import { describe, expect, it } from 'vitest';
import { publicGroupingPreview, publicNamingCandidate } from '@/lib/services/namingCandidateService';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';

describe('public naming candidate projection', () => {
  it('keeps names while redacting regex fragments and native identities', () => {
    const impact = { profileId: 'p', profileName: 'Profile', groupId: 'g', groupName: 'Group', before: 1, after: 0, emptied: true,
      migration: { filter: '^https://user:password@host.example/sub?token=secret$', after: 1 } };
    const input: NamingCandidate = { id: 'test', title: 'Test', template: '${region}', sample: ['https://user:password@host.example/sub?token=secret'],
      groups: [impact], emptiedGroups: [impact], warnings: ['read-only reference'], blocked: true,
      references: [{ profileId: 'p', kind: 'dialer', owner: 'node:private-airport:fingerprint-secret', before: 'https://user:password@host.example/sub?token=secret', blocked: true }] };
    const projected = publicNamingCandidate(input);
    const output = JSON.stringify(projected);
    expect(projected.groups[0].migration!.filter).not.toContain('password');
    expect(projected.groups[0].migration!.filter).not.toContain('host.example');
    expect(output).not.toContain('fingerprint-secret');
    expect(output).not.toContain('private-airport');
    expect(input.sample[0]).toContain('password');
    expect(input.groups[0].migration!.filter).toContain('password');

    expect(projected.sample).toEqual(input.sample);
    expect(projected.references[0]).toMatchObject({ before: input.references[0].before, owner: 'node' });
  });

  it('preserves group sample node names and omits the bound source id', () => {
    const sample = ['[HK-01]'];
    const input = {
      configVersion: 1, template: '${region}', purposes: [], blocked: false, warnings: [],
      profiles: [{ name: 'Profile', groups: [{
        name: 'Group', kind: 'filter' as const, type: 'select' as const, bound_subscription_id: 'private-id',
        count: 1, sample,
      }] }],
    };
    const [group] = publicGroupingPreview(input).profiles[0].groups;
    expect(group.sample).toEqual(sample);
    expect(group).not.toHaveProperty('bound_subscription_id');
  });
});
