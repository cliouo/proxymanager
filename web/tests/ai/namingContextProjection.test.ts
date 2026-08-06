import { beforeAll, describe, expect, it } from 'vitest';
import { installTestHandleSecret } from '../helpers/handleSecret';
import { injectHandleSignerForTests, resetHandleSecret } from '@/lib/proxies/handles';
import {
  assertModelPayloadSafe,
  buildNodeSnapshotScope,
  nameSamplesPayload,
  projectNodeSnapshot,
  sanitizeDisplayText,
} from '@/lib/ai/namingContextProjection';
import { withSource } from '@/lib/proxies/provenance';

/**
 * Round-1 AiSafeNamingContext tests (invariant 6/7/9): AI receives useful
 * bounded sanitized original names and safe source labels with zero
 * credentials/raw IDs; hostile names lose the COMPLETE sensitive span with
 * no residue while safe surrounding labels survive.
 */

beforeAll(() => {
  installTestHandleSecret();
});

const node = (name: string, type = 'ss') => ({
  name,
  type,
  server: 'edge.invalid',
  port: 443,
  password: 'pw',
});

describe('sanitizeDisplayText', () => {
  it('keeps useful labels: HK-01, IPLC, Nexitally, 2x, 家宽, US-Home', () => {
    for (const label of ['HK-01', 'IPLC', 'Nexitally', '2x', '家宽', 'US-Home']) {
      expect(sanitizeDisplayText(label)).toBe(label);
    }
  });

  it('drops the COMPLETE sensitive span with no residue; safe surroundings survive', () => {
    const cases: Array<[string, string]> = [
      // URL + query: whole span gone, surrounding label stays
      ['香港 https://evil.example/sub?token=abc123', '香港'],
      // userinfo + UUID + password-like token
      ['东京 user@example.com 00000000-0000-0000-0000-000000000000 password=pw', '东京'],
      // IPv4 / IPv6 / host:port
      ['新加坡 1.2.3.4:443 2001:db8::1 edge.invalid:8443', '新加坡'],
      // SNI / header / query data
      ['香港 sni=evil.example.com x-custom=abc q=1&r=2', '香港'],
      // reality/public/private key material (long base64-ish span)
      ['德国 abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH', '德国'],
    ];
    for (const [input, expected] of cases) {
      const out = sanitizeDisplayText(input, 48);
      expect(out, input).toBe(expected);
      expect(out, input).not.toMatch(
        /example|user@|\d+\.\d+\.\d+\.\d+|00000000-0000|pw|sni=|x-custom|abcdefghij/,
      );
    }
  });

  it('drops the field entirely when nothing safe remains', () => {
    expect(sanitizeDisplayText('https://evil.example/sub?token=abc123')).toBeNull();
    expect(sanitizeDisplayText('1.2.3.4:443')).toBeNull();
    expect(sanitizeDisplayText('')).toBeNull();
  });
});

describe('projectNodeSnapshot', () => {
  it('emits opaque refs + sanitized names + canonical protocol + safe source labels', () => {
    const proxies = [
      withSource(node('HK-01 2x IPLC'), { key: 'us-home', label: 'US-Home' }),
      withSource(node('家宽 香港'), { key: 'us-home', label: 'US-Home' }),
    ];
    const projection = projectNodeSnapshot(proxies);
    expect(projection.nodeCount).toBe(2);
    expect(projection.sourceTotal).toBe(1);
    for (const n of projection.nodes) {
      expect(n.handle).toMatch(/^nd-[0-9a-f]{16}$/);
      expect(n.protocol).toBe('ss');
    }
    expect(projection.nodes[0].name).toContain('HK-01');
    expect(projection.sources[0]).toMatchObject({ label: 'US-Home' });
    expect(projection.sources[0].id).toMatch(/^src-[0-9a-f]{16}$/);
    // raw ids/keys/credentials never serialize
    const blob = JSON.stringify(projection);
    expect(blob).not.toContain('us-home');
    expect(blob).not.toContain('edge.invalid');
    expect(blob).not.toContain('pw');
  });

  it('hostile names project name=null (nothing safe) while the handle still round-trips', () => {
    const proxies = [
      { ...node('https://evil.example/sub?token=abc123'), type: 'BenignProtocolSecret' },
    ];
    const projection = projectNodeSnapshot(proxies);
    expect(projection.nodes[0].name).toBeNull();
    expect(projection.nodes[0].protocol).toBeNull();
    expect(projection.nodes[0].handle).toMatch(/^nd-[0-9a-f]{16}$/);
    const { scope } = buildNodeSnapshotScope(proxies);
    expect(scope.resolve(projection.nodes[0].handle)).not.toBeNull();
  });

  it('node handles are collision-checked over the COMPLETE snapshot before any cap', () => {
    try {
      injectHandleSignerForTests({ mac: () => 'same-mac' } as never);
      const proxies = [node('香港 01'), node('日本 01')];
      expect(() => projectNodeSnapshot(proxies)).toThrowError(/句柄冲突/);
    } finally {
      resetHandleSecret();
      installTestHandleSecret();
    }
  });
});

describe('nameSamplesPayload', () => {
  it('caps with truthful totals and truncation; sanitizes each name', () => {
    const names = ['香港 01', 'https://evil.example/x', '日本 2x', 'US-01'];
    const payload = nameSamplesPayload(names, 3);
    expect(payload.total).toBe(4);
    expect(payload.truncated).toBe(true);
    expect(payload.sampled).toBe(3);
    expect(payload.names[0]).toBe('香港 01');
    expect(payload.names[1]).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('evil.example');
  });
});

describe('assertModelPayloadSafe', () => {
  it('rejects credential-shaped strings anywhere in nested payloads', () => {
    expect(() => assertModelPayloadSafe({ a: [{ b: 'https://evil.example/x' }] })).toThrow(
      /credential-shaped/,
    );
    expect(() => assertModelPayloadSafe({ a: '1.2.3.4:443' })).toThrow(/credential-shaped/);
    expect(() => assertModelPayloadSafe({ a: 'x'.repeat(600) })).toThrow(/size bound/);
    // server-minted opaque handles are exempt (authorization tokens)
    expect(() =>
      assertModelPayloadSafe({ src: 'src-1234567890abcdef', nd: 'nd-1234567890abcdef' }),
    ).not.toThrow();
    expect(() => assertModelPayloadSafe({ name: '香港 01', rate: 2 })).not.toThrow();
  });
});
