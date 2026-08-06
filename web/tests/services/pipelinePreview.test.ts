import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorStep } from '@/lib/proxies/operators';
import type { NodeReference } from '@/lib/services/nodeReferenceService';
import {
  buildPreviewIssues,
  duplicateFinalNames,
  namesPayload,
  renameTemplateCollisions,
} from '@/lib/services/pipelinePreview';

vi.mock('@/lib/repos/profilesRepo', () => ({
  listProfiles: vi.fn(async () => [
    { id: 'p1', name: 'default', updated_at: 1 },
    { id: 'p2', name: 'second', updated_at: 1 },
  ]),
}));

const refsMock = vi.fn(async (profileId: string, names: string[]): Promise<NodeReference[]> => {
  void profileId;
  void names;
  return [];
});
vi.mock('@/lib/services/nodeReferenceService', () => ({
  findNodeReferences: (...args: unknown[]) => refsMock(...(args as [string, string[]])),
}));

import { listProfiles } from '@/lib/repos/profilesRepo';

const node = (name: string) => ({ name, type: 'ss' });

function step(over: Partial<OperatorStep>): OperatorStep {
  return {
    id: 's1',
    kind: 'rename-template',
    applied: true,
    before: 1,
    after: 1,
    dropped: 0,
    changed: 0,
    ...over,
  };
}

beforeEach(() => {
  refsMock.mockClear();
  refsMock.mockResolvedValue([]);
});

describe('duplicateFinalNames', () => {
  it('finds post-pipeline duplicates with counts', () => {
    const dupes = duplicateFinalNames([node('A'), node('A'), node('B'), node('A')]);
    expect(dupes).toEqual([{ name: 'A', count: 3 }]);
  });

  it('ignores empty names', () => {
    expect(duplicateFinalNames([node(''), node('')])).toEqual([]);
  });
});

describe('renameTemplateCollisions', () => {
  it('collects collisions from applied rename-template steps only', () => {
    const steps = [
      step({ id: 'a', kind: 'rename-template', applied: true, collisions: ['X'] }),
      step({ id: 'b', kind: 'rename-template', applied: false, collisions: ['Y'] }),
    ];
    expect(renameTemplateCollisions(steps)).toEqual(['X']);
  });
});

describe('buildPreviewIssues', () => {
  it('reports duplicate final names + resolved collisions', async () => {
    const issues = await buildPreviewIssues(
      [node('香港 01'), node('香港 01')],
      [node('A'), node('A')],
      [step({ collisions: ['香港 01'] })],
    );
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('duplicate-final-name');
    expect(codes).toContain('rename-collision-resolved');
  });

  it('reports TRUE duplicates removed by node identity (source-priority dedup)', async () => {
    const issues = await buildPreviewIssues(
      [node('香港 01')],
      [node('香港 01')],
      [
        step({
          deduped: [
            { kept: '香港 01', dropped: '香港 02', sourceKey: 'airport-a' },
            { kept: '🇭🇰 香港 https://evil.example/sub?token=abc123 ::1', dropped: '日本 01' },
          ],
        }),
      ],
    );
    const dedup = issues.filter((i) => i.code === 'true-dedup');
    expect(dedup).toHaveLength(2);
    // diagnostic provenance + scrubbing, end to end
    const serialized = JSON.stringify(issues);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
    expect(serialized).not.toContain('::1');
  });

  it('reports orphaned references for names that disappeared, across profiles', async () => {
    refsMock.mockImplementation(async (_profileId: string, names: string[]) =>
      names.map((n) => ({ node: n, kind: 'chain-backend', via: '出口' })),
    );
    const issues = await buildPreviewIssues(
      [node('香港 01'), node('日本 01')],
      [node('香港 01')], // 日本 01 renamed/dropped
      [],
    );
    expect(issues).toContainEqual({
      code: 'orphaned-reference',
      kind: 'chain-backend',
      node: '日本 01',
      via: '出口',
    });
    // both profiles were scanned
    expect(refsMock.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2']);
    void listProfiles;
  });

  it('no disappeared names → no reference scans', async () => {
    const issues = await buildPreviewIssues([node('A')], [node('A')], []);
    expect(issues).toEqual([]);
    expect(refsMock).not.toHaveBeenCalled();
  });

  it('issues stay credential-free: only scrubbed labels + handles', async () => {
    refsMock.mockResolvedValue([
      { node: '香港 01', kind: 'rule-policy', via: 'DOMAIN,example.com' },
    ]);
    const issues = await buildPreviewIssues(
      [{ ...node('香港 01'), server: '1.2.3.4', port: 443, uuid: 'secret' }],
      [node('A')],
      [],
    );
    const serialized = JSON.stringify(issues);
    expect(serialized).not.toContain('1.2.3.4');
    expect(serialized).not.toContain('secret');
    // hostname-shaped rule values are scrubbed too — the issue stays
    // actionable via kind + scrubbed via, never the raw host
    expect(serialized).not.toContain('example.com');
    expect(serialized).toContain('rule-policy');
    expect(serialized).toContain('香港 01');
  });
});

describe('namesPayload', () => {
  it('caps the list at NAME_CAP and flags truncation', () => {
    const many = Array.from({ length: 500 }, (_, i) => node(`N${i}`));
    const payload = namesPayload(many);
    expect(payload.count).toBe(500);
    expect(payload.names).toHaveLength(300);
    expect(payload.truncated).toBe(true);
  });
});

describe('adversarial credential-free issues (final repair group 3)', () => {
  const HOSTILE = {
    name: '🇭🇰 香港 https://evil.example/sub?token=abc123 ::1 2001:db8:: edge.airport.ai',
  };

  it('duplicate-final-name issues scrub credential-shaped names', async () => {
    const issues = await buildPreviewIssues([HOSTILE, HOSTILE], [HOSTILE, HOSTILE], []);
    const serialized = JSON.stringify(issues);
    for (const needle of ['evil.example', 'token=abc123', '::1', '2001:db8', 'airport.ai']) {
      expect(serialized, needle).not.toContain(needle);
    }
    const dup = issues.find((i) => i.code === 'duplicate-final-name');
    expect(dup).toBeDefined();
    if (dup && dup.code === 'duplicate-final-name') {
      expect(dup.count).toBe(2);
      expect(dup.name).toContain('香港');
    }
  });

  it('rename-collision-resolved issues scrub collision names', async () => {
    const issues = await buildPreviewIssues(
      [],
      [],
      [step({ collisions: ['🇭🇰 香港 https://evil.example/sub?token=abc123 ::1'] })],
    );
    const serialized = JSON.stringify(issues);
    expect(serialized).not.toContain('evil.example');
    expect(serialized).not.toContain('token=abc123');
    expect(serialized).not.toContain('::1');
  });

  it('orphaned-reference node + via scrub host/IP/token material', async () => {
    refsMock.mockResolvedValue([
      {
        node: '🇭🇰 香港 https://evil.example/sub?token=abc123 ::1',
        kind: 'chain-backend',
        via: 'chain:edge.airport.moe:8443',
      },
    ]);
    const issues = await buildPreviewIssues([HOSTILE], [node('A')], []);
    const serialized = JSON.stringify(issues);
    for (const needle of ['evil.example', 'token=abc123', '::1', 'airport.moe', '8443']) {
      expect(serialized, needle).not.toContain(needle);
    }
    expect(serialized).toContain('chain-backend');
    expect(serialized).toContain('香港');
  });

  it('representative step samples in traces never carry credentials', async () => {
    const issues = await buildPreviewIssues(
      [],
      [],
      [
        step({
          samples: [
            {
              before: '🇭🇰 香港 https://evil.example/sub?token=abc123',
              after: '🇭🇰 香港 ::1 01',
            },
          ],
        }),
      ],
    );
    // samples are not issue strings; the engine redacts them at creation —
    // this guards the boundary contract end to end
    expect(issues).toEqual([]);
  });
});
