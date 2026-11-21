import { describe, expect, it, vi } from 'vitest';
import {
  applyRenameTemplate,
  formatNodeName,
  nodeFingerprint,
  recognizeName,
  validateTemplate,
  withRawIdentity,
  type RenameTemplateConfig,
} from '@/lib/proxies/naming';
import { applyOperators } from '@/lib/proxies/operators';
import { NodeFactsSchema } from '@/schemas/nodeFacts';
import { OperatorSchema, StoredOperatorListSchema } from '@/schemas/operator';

const node = (name: string, port = 443) => ({ name, type: 'ss', server: 'edge.example', port });
const format = (name: string, template: string) =>
  formatNodeName({ name, index: 1, config: { template } });

describe('line tags and compatible residuals', () => {
  it('recognizes a closed, deduplicated vocabulary in canonical order', () => {
    expect(recognizeName('Native BGP 家庭宽带 IPLC专线 iepl IEPL 原生').tags).toEqual([
      'IEPL',
      'IPLC',
      '专线',
      'BGP',
      '家宽',
      '原生',
    ]);
    expect(recognizeName('myiepl IPLCx anative bgplus').tags).toEqual([]);
    expect(recognizeName('家庭寬帶 專線').tags).toEqual(['专线', '家宽']);
    expect(recognizeName('').tags).toEqual([]);
  });

  it('leaves old note-only and default-style names byte-identical', () => {
    expect(format('香港 IPLC专线 foo 01', '${note}')).toBe('IPLC专线 foo 01');
    expect(format('香港 01 | IEPL', '${emoji} ${region}${?index: · ${index}}')).toBe(
      '🇭🇰 香港 · 01',
    );
    expect(format('香港 01 | IEPL', '${emoji} ${region}${?note: · ${note}}')).toBe(
      '🇭🇰 香港 · 01 | IEPL',
    );
  });

  it('renders tags and removes their spans only when tags are used, including nested guards', () => {
    expect(validateTemplate('${region}${?tags: · ${tags}}').ok).toBe(true);
    expect(
      format('香港 01 | IEPL', '${emoji} ${region} ${index}${?tags: · ${tags}}${?note: · ${note}}'),
    ).toBe('🇭🇰 香港 01 · IEPL');
    expect(format('香港 IPLC专线 foo', '${tags}${?note: · ${note}}')).toBe('IPLC 专线 · foo');
    expect(format('香港 foo', '${region}${?tags: · ${tags}}')).toBe('香港');
    expect(format('香港 iepl foo', '${region}${?region: · ${tags}}${?note: · ${note}}')).toBe(
      '香港 · IEPL · foo',
    );
    expect(validateTemplate('${tag}').ok).toBe(false);
  });

  it('adds canonical tag facts through rules without stripping legacy notes', () => {
    const config: RenameTemplateConfig = {
      template: '${note}',
      recognitionRules: [{ pattern: '高速', field: 'tag', value: 'IEPL' }],
    };
    expect(formatNodeName({ name: '香港 高速 foo', config })).toBe('高速 foo');
    expect(
      formatNodeName({
        name: '香港 高速 foo',
        config: { ...config, template: '${tags}${?note: · ${note}}' },
      }),
    ).toBe('IEPL · foo');
    expect(OperatorSchema.safeParse({ id: 'r', kind: 'rename-template', ...config }).success).toBe(
      true,
    );
    expect(
      OperatorSchema.safeParse({
        id: 'r',
        kind: 'rename-template',
        ...config,
        recognitionRules: [{ pattern: '高速', field: 'tag', value: 'fast' }],
      }).success,
    ).toBe(false);
  });
});

describe('naming engine regressions', () => {
  it.each(['2倍', '倍率2', '倍率:2', '倍率：2', 'x2', '×2', '2x', '2×'])(
    'preserves the boundary character before multiplier %s', (rate) => {
      expect(recognizeName(`香港 专线${rate}`).base).toBe('专线');
      expect(format(`香港 专线${rate}`, '${rate} · ${note}')).toBe('2x · 专线');
    },
  );

  it('populates source and emoji recursively inside optional blocks', () => {
    expect(
      formatNodeName({
        name: '香港 01',
        source: { key: 'a', label: '机场A' },
        config: { template: '${region}${?region: · ${source}}' },
      }),
    ).toBe('香港 · 机场A');
    expect(format('香港 01', '${region}${?region: ${emoji}}')).toBe('香港 🇭🇰');
  });

  it('uses the first matching rule per field, independently for each field', () => {
    const result = recognizeName('香港 alpha beta', [
      { pattern: 'absent', field: 'region', value: 'US' },
      { pattern: 'alpha', field: 'region', value: 'JP' },
      { pattern: 'beta', field: 'region', value: 'SG' },
      { pattern: 'beta', field: 'vendor', value: 'Brand' },
    ]);
    expect(result.region).toBe('JP');
    expect(result.vendor).toBe('Brand');
  });

  it.each(['2倍', '倍率2', '倍率:2', '倍率：2', 'x2', '×2', '0.5倍', '倍率：0.5', 'x0.5'])(
    'recognizes bounded multiplier %s',
    (rate) => {
      expect(recognizeName(`香港 ${rate}`).rate).toBe(rate.includes('0.5') ? 0.5 : 2);
    },
  );

  it.each(['倍率1234', '倍率2.345', 'x1234', '1234倍', 'ax2', 'x2b'])(
    'rejects out-of-bounds/word-internal multiplier %s',
    (rate) => {
      expect(recognizeName(rate).rate).toBeNull();
    },
  );
});

describe('saved raw-fingerprint facts', () => {
  it('strips case-insensitive literal vendor facts from notes and stays idempotent', () => {
    const config = { template: '${vendor} · ${note}' };
    let name = '香港 acme.* AcmeXYZ';
    for (let i = 0; i < 3; i += 1) {
      name = formatNodeName({ name, config, facts: { vendor: 'Acme.*' } });
      expect(name).toBe('Acme.* · AcmeXYZ');
    }
    expect(formatNodeName({ name: '香港 foo', config, facts: {} })).toBe('foo');
    expect(formatNodeName({ name: '香港', config, facts: { vendor: 'Acme' } })).toBe('Acme');
  });

  it('strips repeated region and route fact labels without eating Latin word-internal text', () => {
    const config = { template: '${region} · ${route}${?note: · ${note}}' };
    let name = '新加坡 新加坡 SG 直连 直连 Business';
    for (let i = 0; i < 3; i += 1) {
      name = formatNodeName({ name, config, facts: { region: 'SG', route: '直连' } });
      expect(name).toBe('新加坡 · 直连 · Business');
    }
  });

  it('validates bounded strict facts and persists them through stored-operator decoding', () => {
    const nodeFacts = {
      [nodeFingerprint(node('old'))!]: {
        region: 'HK',
        tags: ['IEPL'],
        rate: 2,
        route: '中转',
        vendor: 'Brand',
        info: false,
      },
    };
    const op = { id: 'n', kind: 'rename-template', template: '${region}', nodeFacts };
    expect(OperatorSchema.parse(op)).toMatchObject({ nodeFacts });
    expect(StoredOperatorListSchema.parse([op])[0]).toMatchObject({ nodeFacts });
    expect(NodeFactsSchema.parse({})).toEqual({});
    for (const invalid of [
      { rawName: { region: 'HK' } },
      { aaaaaaaaaaaaaaaa: { region: 'ZZ' } },
      { aaaaaaaaaaaaaaaa: { tags: ['Unknown'] } },
      { aaaaaaaaaaaaaaaa: { rate: -1 } },
      { aaaaaaaaaaaaaaaa: { rate: 1000 } },
      { aaaaaaaaaaaaaaaa: { server: 'secret' } },
      { aaaaaaaaaaaaaaaa: { vendor: 'x'.repeat(25) } },
      Object.fromEntries(
        Array.from({ length: 2001 }, (_, i) => [i.toString(16).padStart(16, '0'), { info: true }]),
      ),
    ])
      expect(NodeFactsSchema.safeParse(invalid).success).toBe(false);
  });

  it('overrides built-ins and rules and survives upstream rename and property operators', () => {
    const original = node('香港 高速 2x');
    const fp = nodeFingerprint(original)!;
    const config: RenameTemplateConfig = {
      template: '${region_code} ${tags} ${rate}${?route: · ${route}}${?vendor: · ${vendor}}',
      recognitionRules: [{ pattern: '高速', field: 'region', value: 'JP' }],
      nodeFacts: {
        [fp]: {
          region: 'SG',
          tags: ['原生', 'IEPL', 'IEPL'],
          rate: 3,
          route: '直连',
          vendor: 'Brand',
        },
      },
    };
    const before = withRawIdentity(original, { key: 'a', label: 'A' });
    const renamed = { ...before, name: 'new upstream label', udp: true };
    expect(nodeFingerprint({ ...original, name: renamed.name })).toBe(fp);
    expect(applyRenameTemplate([renamed], config).proxies[0].name).toBe(
      'SG IEPL 原生 3x · 直连 · Brand',
    );
  });

  it('drops info nodes only for explicit info=true facts, without a model call', () => {
    const fetch = vi.fn(() => {
      throw new Error('render must not call model');
    });
    vi.stubGlobal('fetch', fetch);
    try {
      const nodes = [node('剩余流量', 1), node('到期时间', 2), node('香港', 3)];
      const nodeFacts = {
        [nodeFingerprint(nodes[0])!]: { info: true },
        [nodeFingerprint(nodes[1])!]: { info: false },
      };
      const result = applyOperators(nodes, [
        { id: 'n', kind: 'rename-template', template: '${note}', recognitionRules: [], nodeFacts },
      ]);
      expect(result.proxies.map((p) => p.name)).toEqual(['到期时间', '香港']);
      expect(result.steps[0].dropped).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      expect(applyRenameTemplate([], { template: '${tags}', nodeFacts }).proxies).toEqual([]);
      expect(applyRenameTemplate(nodes, { template: '${note}' }).proxies).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
