import { describe, expect, it } from 'vitest';
import { publicNamingCandidate } from '@/lib/services/namingCandidateService';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';

describe('public naming candidate projection', () => {
  it('redacts names, regex fragments and native identities without changing the internal plan', () => {
    const impact = { profileId: 'p', profileName: 'Profile', groupId: 'g', groupName: 'Group', before: 1, after: 0, emptied: true,
      migration: { filter: '^https://user:password@host.example/sub?token=secret$', after: 1 } };
    const input: NamingCandidate = { id: 'test', title: 'Test', template: '${region}', sample: ['https://user:password@host.example/sub?token=secret'],
      groups: [impact], emptiedGroups: [impact], warnings: ['read-only reference'], blocked: true,
      references: [{ profileId: 'p', kind: 'dialer', owner: 'node:private-airport:fingerprint-secret', before: 'https://user:password@host.example/sub?token=secret', blocked: true }] };
    const output = JSON.stringify(publicNamingCandidate(input));
    expect(output).not.toContain('password');
    expect(output).not.toContain('host.example');
    expect(output).not.toContain('fingerprint-secret');
    expect(output).not.toContain('private-airport');
    expect(input.sample[0]).toContain('password');
    expect(input.groups[0].migration!.filter).toContain('password');
  });
});
