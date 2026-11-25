import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMihomoDocsMock = vi.fn();
const safeFetchTextMock = vi.fn();
const resolveScopeProfileMock = vi.fn();
const planDirectAliasMigrationMock = vi.fn();
const executeDirectAliasMigrationMock = vi.fn();
const planLegacyProfileRepairMock = vi.fn();
const executeLegacyProfileRepairMock = vi.fn();
const planLegacyChainProfileRepairMock = vi.fn();
const executeLegacyChainProfileRepairMock = vi.fn();

vi.mock('@/lib/tools/mihomoDocs', () => ({
  queryMihomoDocs: (...args: unknown[]) => queryMihomoDocsMock(...args),
}));

vi.mock('@/lib/net/safeFetch', () => ({
  safeFetchText: (...args: unknown[]) => safeFetchTextMock(...args),
}));

vi.mock('@/lib/profileScope', () => ({
  resolveScopeProfile: (...args: unknown[]) => resolveScopeProfileMock(...args),
}));

vi.mock('@/lib/services/directMigrationService', () => ({
  BUILTIN_DIRECT: 'DIRECT',
  planDirectAliasMigration: (...args: unknown[]) => planDirectAliasMigrationMock(...args),
  executeDirectAliasMigration: (...args: unknown[]) => executeDirectAliasMigrationMock(...args),
}));

vi.mock('@/lib/services/legacyProfileRepairService', () => ({
  planLegacyProfileRepair: (...args: unknown[]) => planLegacyProfileRepairMock(...args),
  executeLegacyProfileRepair: (...args: unknown[]) => executeLegacyProfileRepairMock(...args),
}));

vi.mock('@/lib/services/legacyChainProfileRepairService', () => ({
  planLegacyChainProfileRepair: (...args: unknown[]) => planLegacyChainProfileRepairMock(...args),
  executeLegacyChainProfileRepair: (...args: unknown[]) => executeLegacyChainProfileRepairMock(...args),
}));

import { POST as postMihomoDocs } from '@/app/api/v1/tools/mihomo-docs/route';
import { POST as postFetchUrl } from '@/app/api/v1/tools/fetch-url/route';
import { POST as postDirectMigration } from '@/app/api/v1/tools/direct-alias-migration/route';
import { POST as postLegacyRepair } from '@/app/api/v1/tools/legacy-profile-repair/route';
import { POST as postLegacyChainRepair } from '@/app/api/v1/tools/legacy-chain-repair/route';

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';

function jsonPost(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('/api/v1/tools/* routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveScopeProfileMock.mockResolvedValue({ id: UUID_1, name: 'default' });
  });

  it('mihomo-docs queries DeepWiki with default Meta-Docs repo', async () => {
    queryMihomoDocsMock.mockResolvedValue({
      question: 'tun 配置怎么写',
      repo: 'MetaCubeX/Meta-Docs',
      answer: 'tun:\n  enable: true',
      source: 'https://deepwiki.com/MetaCubeX/Meta-Docs',
      untrusted: true,
    });

    const res = await postMihomoDocs(
      jsonPost('http://localhost/api/v1/tools/mihomo-docs', { question: 'tun 配置怎么写' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.answer).toContain('tun:');
    expect(json.data.untrusted).toBe(true);
    expect(queryMihomoDocsMock).toHaveBeenCalledWith('MetaCubeX/Meta-Docs', 'tun 配置怎么写');
  });

  it('fetch-url delegates to safeFetchText with 64KB cap and untrusted marker', async () => {
    safeFetchTextMock.mockResolvedValue({
      finalUrl: 'https://example.com/rules.yaml',
      contentType: 'text/plain',
      bytes: 12,
      truncated: false,
      text: 'payload: []\n',
    });

    const res = await postFetchUrl(
      jsonPost('http://localhost/api/v1/tools/fetch-url', {
        url: 'https://example.com/rules.yaml',
        reader: false,
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toMatchObject({
      url: 'https://example.com/rules.yaml',
      content: 'payload: []\n',
      untrusted: true,
    });
    expect(safeFetchTextMock).toHaveBeenCalledWith('https://example.com/rules.yaml', {
      reader: false,
      maxBytes: 64_000,
    });
  });

  it('direct-alias-migration supports preview and apply with actor propagation', async () => {
    planDirectAliasMigrationMock.mockResolvedValue({
      summary: { alias: '直连', replacement: 'DIRECT', groupsTouched: 1, rulesTouched: 2 },
      expectedVersion: 5,
      expectedBaseEtag: '0123456789abcdef',
      subscriptionFailureSignature: 'sig-ok',
    });

    const previewRes = await postDirectMigration(
      jsonPost('http://localhost/api/v1/tools/direct-alias-migration', {
        action: 'preview',
        alias: '直连',
      }),
    );
    expect(previewRes.status).toBe(200);
    const previewJson = await previewRes.json();
    expect(previewJson.data).toMatchObject({
      safe: true,
      expectedVersion: 5,
      expectedBaseEtag: '0123456789abcdef',
      subscriptionFailureSignature: 'sig-ok',
    });

    executeDirectAliasMigrationMock.mockResolvedValue({
      summary: { alias: '直连', replacement: 'DIRECT' },
      newVersion: 6,
      auditEventId: 'ev-1',
    });
    const applyRes = await postDirectMigration(
      jsonPost(
        'http://localhost/api/v1/tools/direct-alias-migration',
        {
          action: 'apply',
          alias: '直连',
          expected_version: 5,
          expected_base_etag: '0123456789abcdef',
          expected_subscription_failure_signature: 'sig-ok',
        },
        { 'X-Source': 'webmcp' },
      ),
    );
    expect(applyRes.status).toBe(200);
    expect(executeDirectAliasMigrationMock).toHaveBeenCalledWith(
      UUID_1,
      '直连',
      5,
      '0123456789abcdef',
      'webmcp',
      'sig-ok',
    );
  });

  it('legacy-profile-repair validates at least 2 distinct repairs and runs preview', async () => {
    planLegacyProfileRepairMock.mockResolvedValue({
      summary: { alias: '直连', replacement: 'DIRECT' },
      filterRepairAfter: [{ name: 'G1' }, { name: 'G2' }],
      expectedVersion: 7,
      expectedBaseEtag: 'fedcba9876543210',
      subscriptionFailureSignature: 'sig-2',
    });

    const badRes = await postLegacyRepair(
      jsonPost('http://localhost/api/v1/tools/legacy-profile-repair', {
        action: 'preview',
        repairs: [{ id: UUID_1, filter: 'HK' }],
      }),
    );
    expect(badRes.status).toBe(422);

    const okRes = await postLegacyRepair(
      jsonPost('http://localhost/api/v1/tools/legacy-profile-repair', {
        action: 'preview',
        alias: '直连',
        repairs: [
          { id: UUID_1, filter: 'HK' },
          { id: UUID_2, exclude_filter: '到期' },
        ],
      }),
    );
    expect(okRes.status).toBe(200);
    expect(planLegacyProfileRepairMock).toHaveBeenCalledWith(UUID_1, '直连', [
      { id: UUID_1, filter: 'HK' },
      { id: UUID_2, 'exclude-filter': '到期' },
    ]);
  });

  it('legacy-chain-repair requires spx quarantine or stale chain and supports apply', async () => {
    const badRes = await postLegacyChainRepair(
      jsonPost('http://localhost/api/v1/tools/legacy-chain-repair', {
        action: 'preview',
        repairs: [
          { id: UUID_1, filter: 'HK' },
          { id: UUID_2, filter: 'US' },
        ],
      }),
    );
    expect(badRes.status).toBe(422);

    executeLegacyChainProfileRepairMock.mockResolvedValue({
      summary: { repairedFilterGroups: ['G1', 'G2'] },
      newVersion: 9,
      auditEventId: 'ev-9',
    });
    const okRes = await postLegacyChainRepair(
      jsonPost(
        'http://localhost/api/v1/tools/legacy-chain-repair',
        {
          action: 'apply',
          alias: '直连',
          repairs: [
            { id: UUID_1, filter: 'HK' },
            { id: UUID_2, filter: 'US' },
          ],
          quarantine_spx_subscription_id: UUID_3,
          expected_version: 8,
          expected_base_etag: '0123456789abcdef',
        },
        { 'X-Source': 'ai_chat' },
      ),
    );
    expect(okRes.status).toBe(200);
    expect(executeLegacyChainProfileRepairMock).toHaveBeenCalledWith(
      UUID_1,
      {
        alias: '直连',
        repairs: [
          { id: UUID_1, filter: 'HK' },
          { id: UUID_2, filter: 'US' },
        ],
        quarantineSpxSubscriptionId: UUID_3,
      },
      8,
      '0123456789abcdef',
      'ai_chat',
    );
  });
});
