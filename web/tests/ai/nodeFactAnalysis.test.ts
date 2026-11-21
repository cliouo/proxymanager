import { describe, expect, it, vi } from 'vitest';
import {
  runNodeFactAnalysis,
  FACT_ANALYSIS_NODE_CAP,
  FACT_ANALYSIS_BATCH_SIZE,
} from '@/lib/ai/namingAnalysis';
import { nodeFingerprint } from '@/lib/proxies/naming';
import type { ChatMessage } from '@/lib/ai/deepseek';

const node = (name: string, port = 443) => ({
  name,
  type: 'ss',
  server: 'private.example',
  password: 'never-send-this',
  port,
});
const reply = (nodes: unknown[]) => vi.fn(async () => ({ content: JSON.stringify({ nodes }) }));

describe('bounded AI node fact proposals', () => {
  it('sends only scrubbed names and opaque indexes, returns validated fingerprint-keyed proposals', async () => {
    const proxy = node('mystery 专线 https://secret.example/token?key=123 203.0.113.1');
    const chat = reply([{ i: 0, facts: { region: 'HK', tags: ['IEPL'], rate: 2, info: false } }]);
    const result = await runNodeFactAnalysis({ proxies: [proxy], chat });
    expect(result.nodeFacts).toEqual({
      [nodeFingerprint(proxy)!]: { region: 'HK', tags: ['IEPL'], rate: 2, info: false },
    });
    expect(result).toMatchObject({ proposed: 1, considered: 1, truncated: false });
    const messages = (chat.mock.calls as unknown as [ChatMessage[]][])[0][0];
    const payload = JSON.parse(messages[1].content!);
    expect(Object.keys(payload[0]).sort()).toEqual(['i', 'name']);
    const sent = JSON.stringify(messages);
    for (const secret of [
      'private.example',
      'never-send-this',
      'secret.example',
      '203.0.113.1',
      nodeFingerprint(proxy)!,
    ])
      expect(sent).not.toContain(secret);
  });

  it('selects missing/ambiguous regions, ambiguous routes and unknown residual tags, not already-understood names', async () => {
    const chat = reply([]);
    const result = await runNodeFactAnalysis({
      proxies: [
        node('香港 IEPL 01', 1),
        node('香港 直连 01', 2),
        node('mystery 01', 3),
        node('香港 日本 01', 4),
        node('香港 直连 中转', 5),
        node('香港 高级线路 01', 6),
      ],
      chat,
    });
    expect(result.considered).toBe(4);
    expect(result.nodeFacts).toEqual({});
  });

  it('does not call the model for empty or fully recognized inputs', async () => {
    const chat = reply([]);
    expect((await runNodeFactAnalysis({ proxies: [], chat })).considered).toBe(0);
    expect((await runNodeFactAnalysis({ proxies: [node('🇭🇰 香港 01')], chat })).proposed).toBe(0);
    expect(chat).not.toHaveBeenCalled();
  });

  it('caps nodes, batches requests and deduplicates raw identities', async () => {
    const chat = reply([]);
    const nodes = Array.from({ length: FACT_ANALYSIS_NODE_CAP + 5 }, (_, i) =>
      node(`unknown ${i}`, i + 1),
    );
    const result = await runNodeFactAnalysis({
      proxies: [nodes[0], { ...nodes[0], name: 'renamed' }, ...nodes],
      chat,
    });
    expect(result.considered).toBe(FACT_ANALYSIS_NODE_CAP);
    expect(result.truncated).toBe(true);
    expect(chat).toHaveBeenCalledTimes(
      Math.ceil(FACT_ANALYSIS_NODE_CAP / FACT_ANALYSIS_BATCH_SIZE),
    );
  });

  it.each([
    [{ i: 99, facts: { region: 'HK' } }],
    [{ i: 0, facts: { tags: ['IPLC', 'Unknown'] } }],
    [{ i: 0, facts: { region: 'ZZ' } }],
    [{ i: 0, facts: { server: 'not-allowed' } }],
    [{ i: 0, facts: { rate: 1000 } }],
    [{ i: 0, facts: { vendor: 'https://secret.example' } }],
    [
      { i: 0, facts: { info: true } },
      { i: 0, facts: {} },
    ],
  ])('rejects invalid or invented model proposals %#', async (...rows) => {
    await expect(
      runNodeFactAnalysis({ proxies: [node('unknown')], chat: reply(rows) }),
    ).rejects.toThrow('AI 节点识别');
  });

  it('returns a bounded safe error for malformed or unavailable model responses', async () => {
    await expect(
      runNodeFactAnalysis({
        proxies: [node('unknown')],
        chat: vi.fn(async () => ({ content: 'private.example bad JSON' })),
      }),
    ).rejects.toThrow('AI 节点识别失败，请重试或手动配置。');
    await expect(
      runNodeFactAnalysis({
        proxies: [node('unknown')],
        chat: vi.fn(async () => {
          throw new Error('never-send-this');
        }),
      }),
    ).rejects.toThrow('AI 节点识别失败，请重试或手动配置。');
  });
});
