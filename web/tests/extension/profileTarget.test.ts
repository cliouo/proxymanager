import { afterEach, expect, it, vi } from 'vitest';
import {
  backendCreateRule,
  backendDeleteRule,
  backendProfiles,
  bindBackendTarget,
} from '../../../extension/lib/backend';
import type { Settings } from '../../../extension/lib/settings';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const settings: Settings = {
  backendUrl: 'https://pm.test',
  adminKey: 'test-key',
  profileId: B,
  profileName: 'new-target',
  clashUrl: '',
  clashSecret: '',
  candidateGroups: [],
  defaultAnchor: 'manual',
  defaultRuleType: 'DOMAIN',
  speedtestTimeoutMs: 1000,
  autoReloadClash: false,
};
afterEach(() => vi.unstubAllGlobals());
it('writes with the requested ID and undo retains the old target after settings change', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      return Response.json(
        url.endsWith('/meta')
          ? { data: { capabilities: { profileIdScope: true } } }
          : { data: { id: 'rule' } },
      );
    }),
  );
  await backendCreateRule(settings, {
    anchor: 'manual',
    type: 'DOMAIN',
    value: 'example.test',
    policy: 'DIRECT',
    source: 'manual',
  });
  await backendDeleteRule(
    bindBackendTarget(settings, {
      origin: 'https://pm.test',
      profileId: A,
      profileName: 'original',
    }),
    'rule',
  );
  expect(requests).toContain(`https://pm.test/api/v1/rules?profileId=${B}`);
  expect(requests).toContain(`https://pm.test/api/v1/rules/rule?profileId=${A}`);
});
it('refuses legacy servers before a rule mutation is sent', async () => {
  const fetch = vi.fn(async (url: string) => {
    expect(url).toContain('/meta');
    return Response.json({ data: {} });
  });
  vi.stubGlobal('fetch', fetch);
  await expect(backendDeleteRule(settings, 'rule')).rejects.toThrow('升级服务器');
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toContain('/meta');
});
it('never forwards the current key to a history entry from another origin', () => {
  expect(() =>
    bindBackendTarget(settings, {
      origin: 'https://original.test',
      profileId: A,
      profileName: 'old',
    }),
  ).toThrow('原始后端');
});
it('lists office even when no default exists', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith('/meta')
          ? { data: { capabilities: { profileIdScope: true } } }
          : { data: [{ id: A, name: 'office' }] },
      ),
    ),
  );
  expect(await backendProfiles(settings)).toEqual([{ id: A, name: 'office' }]);
});
