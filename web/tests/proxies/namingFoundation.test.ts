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

describe('info nodes and data-size units', () => {
  const config = { template: '${emoji} ${region} ${index}${?note: · ${note}}' };

  it('applies saved field overrides when info=false keeps a heuristic info match', () => {
    const original = withRawIdentity(node('套餐 GB 2倍'), { key: 'source:a', label: 'A' });
    const facts = { info: false, region: 'JP', tags: ['IEPL' as const], rate: 3 };
    const naming = {
      template: '${region_code} ${tags} ${rate}',
      nodeFacts: { [nodeFingerprint(original)!]: facts },
    };
    expect(formatNodeName({ name: '套餐 GB 2倍', config: naming, facts })).toBe('JP IEPL 3x');
    expect(applyRenameTemplate([original], naming).proxies.map((p) => p.name)).toEqual(['JP IEPL 3x']);
    expect(applyRenameTemplate([original], { template: naming.template }).proxies).toEqual([]);
    expect(applyRenameTemplate([original], {
      ...naming, nodeFacts: { [nodeFingerprint(original)!]: { ...facts, info: true } },
    }).proxies).toEqual([]);
    expect(applyRenameTemplate([original], {
      template: '${region_code} ${rate}',
      nodeFacts: { [nodeFingerprint(original)!]: { info: false } },
    }).proxies.map((p) => p.name)).toEqual(['GB 2x']);
  });

  it.each(['我的订阅', '官网合集'])('does not classify a generated alias %s as upstream info', (label) => {
    const original = withRawIdentity(node('香港 01'), { key: 'source:a', label });
    const naming = { template: '${region} · ${source} · ${index}' };
    const first = applyRenameTemplate([original], naming);
    expect(first.proxies.map((p) => p.name)).toEqual([`香港 · ${label} · 01`]);
    expect(applyRenameTemplate(first.proxies, naming).proxies.map((p) => p.name)).toEqual([`香港 · ${label} · 01`]);
    const info = withRawIdentity(node('剩余流量：88 GB'), { key: 'source:a', label: '香港' });
    expect(applyRenameTemplate([{ ...info, name: '香港 01' }], naming).proxies).toEqual([]);
  });

  it.each([
    '剩余流量：88 GB', '剩余流量：88GB', '到期时间：2027-01-01',
    '套餐：500 MB', '官网：https://example.com', 'Remaining traffic: 1.5 TB',
    'expire: 2027-01-01', '重置：30天',
  ])('detects %s before region recognition and drops it from template naming', (name) => {
    expect(recognizeName(name, [{ pattern: '.*', field: 'region', value: 'GB' }])).toMatchObject({
      info: true, region: null, regionSignals: 0, base: name,
    });
    expect(formatNodeName({ name, config, index: 1 })).toBe(name);
    expect(applyRenameTemplate([node(name)], config).proxies).toEqual([]);
  });

  it.each(['88 GB', '88GB', '88 MB', '88MB', '1.5 TB', '1.5TB', '88 gb'])('%s is not a region', (name) => {
    expect(recognizeName(name)).toMatchObject({ region: null, regionSignals: 0, base: name });
    expect(recognizeName(name).info).not.toBe(true);
  });

  it.each(['GB 01', 'UK 01', '88 GB | GB 01', '88GB | UK 01'])('keeps a real UK token in %s', (name) => {
    expect(recognizeName(name)).toMatchObject({ region: 'GB', regionSignals: 1 });
  });

  it('does not add UK ambiguity or remove the size unit from a real node', () => {
    expect(recognizeName('日本 88 GB')).toMatchObject({ region: 'JP', regionSignals: 1, base: '88 GB', ambiguousFields: [] });
    expect(applyRenameTemplate([node('剩余流量：88 GB'), node('GB 01', 444)], config).proxies.map((p) => p.name)).toEqual(['🇬🇧 英国 01']);
    expect(applyRenameTemplate([], config).proxies).toEqual([]);
    expect(recognizeName('香港 https://example.com/traffic')).toMatchObject({ region: 'HK' });
    expect(recognizeName('香港 https://example.com/traffic').info).not.toBe(true);
  });
});

describe('line tags and compatible residuals', () => {
  it.each([
    ['🇭🇰 香港 IEPL 01', '🇭🇰 香港 01 · IEPL'],
    ['香港 IPLC 02 2倍', '🇭🇰 香港 02 · IPLC · 2x'],
    ['日本 家庭宽带 03', '🇯🇵 日本 03 · 家庭宽带'],
    ['香港 Tokyo 04', '🇭🇰 香港 04 · Tokyo'],
    ['香港 05', '🇭🇰 香港 05'],
  ])('keeps the note when extracting the ordinal from %s', (name, expected) => {
    const config = {
      template: '${emoji} ${region} ${index}${?note: · ${note}}${?rate: · ${rate}}',
    };
    expect(formatNodeName({ name, config, index: 1 })).toBe(expected);
    expect(applyRenameTemplate([node(name)], config).proxies[0].name).toBe(expected);
  });

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

  it('drops info nodes locally while allowing explicit info facts to override detection', () => {
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
      expect(applyRenameTemplate(nodes, { template: '${note}' }).proxies).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
