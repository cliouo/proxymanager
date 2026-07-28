import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/client/api', () => ({ api: mocks.api }));

import { fetchSetupStatus, runSetupBootstrap } from '@/lib/client/setup';

const EMPTY_STATUS = {
  state: 'empty',
  can_bootstrap: true,
  revision: 7,
  starter_version: 'starter-v1',
  reason_codes: [],
  inventory: {
    profiles_total: 0,
    profiles_valid: 0,
    profiles_invalid: 0,
    default_profile_id: null,
    has_base: false,
    base_content_present: false,
    base_meta_present: false,
    proxy_groups_total: 0,
    proxy_groups_invalid: 0,
    rules_total: 0,
    rules_invalid: 0,
    source_type: null,
  },
  starter: {
    profile_name: 'default',
    listener_ports: 'client-managed',
    allow_lan: false,
    mode: 'rule',
    log_level: 'info',
    dns_enabled: false,
    tun_enabled: false,
    sniffer_enabled: false,
    rule_sets_total: 0,
    proxy_groups: [
      { name: '自动选择', type: 'url-test' },
      { name: '默认', type: 'select' },
    ],
    final_rule: 'MATCH,默认',
  },
  provenance: null,
  diagnostics: [],
};

const SUCCESS = {
  state: 'configured',
  created: true,
  revision: 8,
  starter_version: 'starter-v1',
  profile: {
    id: '35000000-0000-4000-8000-000000000001',
    name: 'default',
    source: { type: 'none' },
  },
  provenance: {
    starter_version: 'starter-v1',
    expected_revision: 7,
    completed_revision: 8,
    created: true,
    profile_id: '35000000-0000-4000-8000-000000000001',
    base_etag: '0123456789abcdef',
    build_id: 'abcdef12',
    proxy_group_ids: [
      '35000000-0000-4000-8000-000000000002',
      '35000000-0000-4000-8000-000000000003',
    ],
    rule_ids: ['35000000-0000-4000-8000-000000000004'],
    audit_event_id: '35000000-0000-4000-8000-000000000099',
  },
  resources: {
    base_etag: '0123456789abcdef',
    build_id: 'abcdef12',
    proxy_group_ids: [
      '35000000-0000-4000-8000-000000000002',
      '35000000-0000-4000-8000-000000000003',
    ],
    rule_ids: ['35000000-0000-4000-8000-000000000004'],
  },
  readiness: {
    config_renderable: true,
    source: 'unbound',
    distribution_available: true,
  },
};

describe('setup client wire contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the F status schema without legacy state remapping', async () => {
    mocks.api.mockResolvedValueOnce({ data: EMPTY_STATUS });
    const status = await fetchSetupStatus();

    expect(status).toMatchObject({
      state: 'empty',
      revision: 7,
      starter_version: 'starter-v1',
      starter: { listener_ports: 'client-managed' },
    });
    expect(mocks.api).toHaveBeenCalledWith('/api/v1/setup/status', { cache: 'no-store' });
  });

  it('posts only the exact confirmed revision and starter version', async () => {
    mocks.api.mockResolvedValueOnce({ data: SUCCESS });
    const request = {
      expected_revision: 7,
      starter_version: 'starter-v1' as const,
    };

    const receipt = await runSetupBootstrap(request);

    expect(mocks.api).toHaveBeenCalledWith('/api/v1/setup/bootstrap', {
      method: 'POST',
      body: request,
    });
    expect(receipt).toMatchObject({
      state: 'configured',
      provenance: { completed_revision: 8 },
      resources: { build_id: 'abcdef12' },
      readiness: { config_renderable: true },
    });
  });

  it('rejects a client-side request with unknown fields before sending it', async () => {
    await expect(
      runSetupBootstrap({
        expected_revision: 7,
        starter_version: 'starter-v1',
        repair: true,
      } as never),
    ).rejects.toThrow();
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
