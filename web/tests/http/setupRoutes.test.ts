import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigPreflightUnavailableError } from '@/lib/config/errors';

const mocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  bootstrapSetup: vi.fn(),
}));

vi.mock('@/lib/services/setupService', () => ({
  getSetupStatus: mocks.getSetupStatus,
  bootstrapSetup: mocks.bootstrapSetup,
}));

import { POST } from '@/app/api/v1/setup/bootstrap/route';
import { GET } from '@/app/api/v1/setup/status/route';

const STATUS = {
  state: 'empty',
  can_bootstrap: true,
  revision: 0,
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
  revision: 1,
  starter_version: 'starter-v1',
  profile: {
    id: '35000000-0000-4000-8000-000000000001',
    name: 'default',
    source: { type: 'none' },
  },
  provenance: {
    starter_version: 'starter-v1',
    expected_revision: 0,
    completed_revision: 1,
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

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('https://pm.test/api/v1/setup/bootstrap', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );
}

describe('setup routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSetupStatus.mockResolvedValue(STATUS);
    mocks.bootstrapSetup.mockResolvedValue(SUCCESS);
  });

  it('returns uncached derived setup status', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ data: STATUS });
  });

  it('passes the strict bootstrap contract and returns 201 for empty creation', async () => {
    const input = {
      expected_revision: 0,
      starter_version: 'starter-v1',
    };
    const response = await post(input);

    expect(response.status).toBe(201);
    expect(mocks.bootstrapSetup).toHaveBeenCalledWith(input);
    const json = await response.json();
    expect(json.data).toMatchObject({
      profile: { name: 'default', source: { type: 'none' } },
      provenance: {
        starter_version: 'starter-v1',
        completed_revision: 1,
      },
      resources: {
        base_etag: expect.any(String),
        build_id: expect.any(String),
        proxy_group_ids: SUCCESS.resources.proxy_group_ids,
        rule_ids: SUCCESS.resources.rule_ids,
      },
      readiness: { config_renderable: true },
    });
    expect(JSON.stringify(json)).not.toMatch(/token|subscription_url|password/iu);
  });

  it('returns 200 when the server-derived recoverable state is completed', async () => {
    mocks.bootstrapSetup.mockResolvedValue({
      ...SUCCESS,
      created: false,
      provenance: { ...SUCCESS.provenance, created: false },
    });

    const response = await post({
      expected_revision: 0,
      starter_version: 'starter-v1',
    });

    expect(response.status).toBe(200);
  });

  it.each([
    [{ expected_revision: 0, starter_version: 'starter-v1', repair: true }],
    [{ expected_revision: -1, starter_version: 'starter-v1' }],
    [
      {
        expected_revision: Number.MAX_SAFE_INTEGER + 1,
        starter_version: 'starter-v1',
      },
    ],
    [{ expected_revision: 0, starter_version: 'starter-v2' }],
    [{ expected_revision: 0, starter_version: 'starter-v1', mixed_port: 7890 }],
    [{}],
  ])('returns 422 and never strips an invalid or unknown request: %j', async (input) => {
    const response = await post(input);

    expect(response.status).toBe(422);
    expect(mocks.bootstrapSetup).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON without calling the service', async () => {
    const response = await POST(
      new Request('https://pm.test/api/v1/setup/bootstrap', {
        method: 'POST',
        body: '{',
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.bootstrapSetup).not.toHaveBeenCalled();
  });

  it('maps Redis availability failures to a credential-free 503', async () => {
    mocks.getSetupStatus.mockRejectedValue(new ConfigPreflightUnavailableError());

    const response = await GET();
    const problem = await response.json();

    expect(response.status).toBe(503);
    expect(problem).toMatchObject({
      type: 'https://proxymanager.dev/errors/config-validation-unavailable',
      status: 503,
    });
    expect(JSON.stringify(problem)).not.toMatch(/redis|token|connection/iu);
  });
});
