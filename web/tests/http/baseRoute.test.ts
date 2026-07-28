import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getBase: vi.fn(),
  setBase: vi.fn(),
  listProxyGroups: vi.fn(),
  resolveScopeProfile: vi.fn(),
  parseAndValidate: vi.fn(),
  preflightProfileConfig: vi.fn(),
}));

vi.mock('@/lib/repos/baseRepo', () => ({
  getBase: mocks.getBase,
  setBase: mocks.setBase,
}));
vi.mock('@/lib/repos/proxyGroupsRepo', () => ({
  listProxyGroups: mocks.listProxyGroups,
}));
vi.mock('@/lib/profileScope', () => ({
  resolveScopeProfile: mocks.resolveScopeProfile,
}));
vi.mock('@/lib/services/baseService', () => ({
  computeEtag: () => 'candidate-etag',
  parseAndValidate: mocks.parseAndValidate,
}));
vi.mock('@/lib/services/configPreflight', () => ({
  preflightProfileConfig: mocks.preflightProfileConfig,
}));

import { PUT } from '@/app/api/v1/base/route';
import { ConfigValidationError } from '@/lib/config/errors';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT = ['proxies: []', 'rules:', '  # === ANCHOR: manual ==='].join('\n');

function request(headers?: HeadersInit): Request {
  return new Request('https://pm.test/api/v1/base', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ content: CONTENT }),
  });
}

describe('PUT /api/v1/base', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveScopeProfile.mockResolvedValue({ id: PROFILE_ID, name: 'default' });
    mocks.parseAndValidate.mockResolvedValue({
      parsedBase: { anchors: ['manual'], policies: ['DIRECT'] },
      validation: {
        valid: true,
        anchors: ['manual'],
        policies: ['DIRECT'],
        orphans: [],
      },
    });
    mocks.preflightProfileConfig.mockResolvedValue({
      configVersion: 0,
      baseExisted: false,
      candidate: {},
    });
    mocks.setBase.mockResolvedValue({ ok: true });
  });

  it('writes the first valid base with create-only and same-version CAS semantics', async () => {
    const response = await PUT(request());

    expect(response.status).toBe(200);
    expect(mocks.preflightProfileConfig).toHaveBeenCalledWith(PROFILE_ID, expect.any(Function), {
      initializeBaseContent: CONTENT,
    });
    expect(mocks.setBase).toHaveBeenCalledWith(
      PROFILE_ID,
      CONTENT,
      expect.objectContaining({ etag: 'candidate-etag', anchors: ['manual'] }),
      { type: 'must-not-exist' },
      0,
    );
  });

  it('returns 412 when another first writer wins and does not retry as an overwrite', async () => {
    mocks.setBase.mockResolvedValue({
      ok: false,
      conflict: 'exists',
      currentEtag: 'winner',
    });

    const response = await PUT(request());
    const body = await response.json();

    expect(response.status).toBe(412);
    expect(body.type).toBe('https://proxymanager.dev/errors/precondition-failed');
    expect(mocks.setBase).toHaveBeenCalledTimes(1);
    expect(mocks.setBase.mock.calls[0][3]).toEqual({ type: 'must-not-exist' });
  });

  it('does not write when the exact rendered candidate is invalid', async () => {
    mocks.preflightProfileConfig.mockRejectedValue(
      new ConfigValidationError({
        code: 'final_rule_invalid',
        message: 'Full config render rejected: a final rule policy is missing.',
        section: 'rules',
        path: 'rules',
        resource: 'rendered-config',
      }),
    );

    const response = await PUT(request());
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.type).toBe('https://proxymanager.dev/errors/config-validation');
    expect(mocks.setBase).not.toHaveBeenCalled();
  });
});
