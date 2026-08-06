import { describe, expect, it } from 'vitest';
import { resolveSubscriptionProxies } from '@/lib/services/subscriptionFetcher';
import { fingerprintOf, envelopeOf } from '@/lib/proxies/provenance';
import { nodeFingerprint, withRawIdentity } from '@/lib/proxies/naming';
import { applyOperatorsToCandidates } from '@/lib/engine/resolve';
import type { Subscription } from '@/schemas';

/**
 * C4 raw-identity continuity: the immutable raw envelope is attached at the
 * ingestion boundary BEFORE any early return (even zero-operator sources) and
 * survives every source/collection transform until serialisation — a
 * transform can never silently recompute identity from post-transform data.
 */

function localSub(name: string, content: string): Subscription {
  return {
    id: crypto.randomUUID(),
    name,
    display_name: name,
    enabled: true,
    kind: 'local',
    content,
    ttl_ms: 600_000,
    tags: [],
    operators: [],
  } as Subscription;
}

const PROVIDER_YAML = `proxies:
  - { name: '香港 01', type: ss, server: h.example, port: 443, cipher: aes-128-gcm, password: p }
`;

describe('raw identity continuity (C4)', () => {
  it('a ZERO-OPERATOR local source still carries the immutable envelope', async () => {
    const result = await resolveSubscriptionProxies(localSub('zero-op', PROVIDER_YAML));
    const [node] = result.proxies;
    const expected = nodeFingerprint({
      name: '香港 01',
      type: 'ss',
      server: 'h.example',
      port: 443,
      cipher: 'aes-128-gcm',
      password: 'p',
    });
    expect(fingerprintOf(node)).toBe(expected);
    expect(envelopeOf(node)?.rawName).toBe('香港 01');
    // a subsequent transform (spread + rename + set-prop) preserves it
    const transformed = { ...node, name: '改名', udp: true, 'skip-cert-verify': true };
    expect(fingerprintOf(transformed)).toBe(expected);
  });

  it('collection transforms (applyOperatorsToCandidates) preserve the raw identity', () => {
    const raw = {
      name: '香港 01',
      type: 'ss',
      server: 'h.example',
      port: 443,
      cipher: 'aes-128-gcm',
    };
    const withEnvelope = withRawIdentity(raw, { key: 'airport-a', label: '机场A' });
    const expected = fingerprintOf(withEnvelope);
    const out = applyOperatorsToCandidates(
      [
        {
          node: withEnvelope,
          name: '香港 01',
          fromSub: 'airport-a',
          fromSubLabel: '机场A',
        },
      ],
      [
        {
          id: 'sp',
          kind: 'set-prop',
          udp: true,
        },
        {
          id: 'rt',
          kind: 'rename-template',
          template: '${emoji} ${region}${?index: · ${index}}',
          recognitionRules: [],
        },
      ],
    );
    // the collection stage output KEEPS the envelope (not stripped mid-pipeline)
    expect(fingerprintOf(out[0].node)).toBe(expected);
    expect(out[0].node).toMatchObject({ name: '🇭🇰 香港 · 01' });
  });
});
