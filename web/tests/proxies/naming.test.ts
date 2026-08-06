import { describe, expect, it } from 'vitest';
import { applyOperators } from '@/lib/proxies/operators';
import {
  applyRenameTemplate,
  DEFAULT_NAMING_TEMPLATE,
  defaultTemplateFor,
  formatNodeName,
  nodeFingerprint,
  recognizeName,
  withRawIdentity,
  type OrdinalResolver,
  type RenameTemplateConfig,
} from '@/lib/proxies/naming';
import { withSource, type SourceIdentity } from '@/lib/proxies/provenance';

function config(template: string, over: Partial<RenameTemplateConfig> = {}): RenameTemplateConfig {
  return { template, ...over };
}

function proxy(
  name: string,
  type = 'vless',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, type, server: 'edge.invalid', port: 443, ...extra };
}

const AGG_TEMPLATE = DEFAULT_NAMING_TEMPLATE;

/* ─── recognition ──────────────────────────────────────────────────── */

describe('recognizeName', () => {
  it('region from explicit flag emoji wins, keyword removed from base', () => {
    const r = recognizeName('🇭🇰 香港 01');
    expect(r.region).toBe('HK');
    expect(r.base).toBe('01');
  });

  it('region from keyword/code patterns (shared region table)', () => {
    expect(recognizeName('日本 Tokyo 01').region).toBe('JP');
    expect(recognizeName('Tokyo 01').region).toBe('JP');
    expect(recognizeName('US Los Angeles').region).toBe('US');
    expect(recognizeName('HKG-01').region).toBe('HK');
    expect(recognizeName('回国专线').region).toBe('CN');
  });

  it('no region → null, base untouched', () => {
    const r = recognizeName('某些奇怪的名字');
    expect(r.region).toBeNull();
    expect(r.base).toBe('某些奇怪的名字');
  });

  it('rate: bounded Nx/N× patterns, base cleaned', () => {
    expect(recognizeName('香港 2x 01').rate).toBe(2);
    expect(recognizeName('香港 1.5× 01').rate).toBe(1.5);
    expect(recognizeName('香港 01').rate).toBeNull();
    expect(recognizeName('香港 01 x2').rate).toBeNull();
  });

  it('route tokens (conservative table); entry only for the entry token', () => {
    expect(recognizeName('香港 中转 01').route).toBe('中转');
    expect(recognizeName('香港 Relay 01').route).toBe('中转');
    expect(recognizeName('香港 直连').route).toBe('直连');
    expect(recognizeName('香港 落地').route).toBe('落地');
    expect(recognizeName('香港 入口').route).toBe('入口');
    expect(recognizeName('香港 入口').entry).toBe('入口');
    expect(recognizeName('香港 中转').entry).toBeNull();
    expect(recognizeName('香港 01').route).toBeNull();
  });

  it('vendor tokens (conservative, word-bounded)', () => {
    expect(recognizeName('Nexitally 香港 01').vendor).toBe('Nexitally');
    expect(recognizeName('花云 香港').vendor).toBe('花云');
    expect(recognizeName('tagged 香港').vendor).toBeNull();
    expect(recognizeName('nexitallybro 香港').vendor).toBeNull();
    expect(recognizeName('TAG-香港-01').vendor).toBe('TAG');
  });

  it('"indirect route" does NOT infer 直连 (word boundaries)', () => {
    expect(recognizeName('indirect route').route).toBeNull();
    expect(recognizeName('direct 香港').route).toBe('直连');
    expect(recognizeName('elementary 香港').route).toBeNull();
    expect(recognizeName('entry 香港').route).toBe('入口');
  });

  it('ambiguity signals: flag-vs-keyword and multiple route tokens', () => {
    const conflicted = recognizeName('🇭🇰 日本 01');
    expect(conflicted.region).toBe('HK');
    expect(conflicted.regionSignals).toBeGreaterThan(1);
    const routes = recognizeName('香港 中转 直连');
    expect(routes.routeSignals).toBeGreaterThan(1);
    expect(recognizeName('香港 01').regionSignals).toBe(1);
  });

  it('saved recognition rules override facts deterministically', () => {
    const rules = [{ pattern: '机场A', field: 'vendor' as const, value: '机场A' }];
    const r = recognizeName('机场A 香港 01', rules);
    expect(r.vendor).toBe('机场A');
    // the rule's matched span is removed from the residual
    expect(r.base).toBe('01');
  });
});

/* ─── formatting via templates ─────────────────────────────────────── */

describe('formatNodeName', () => {
  it('balanced-style template: flag + region block + index', () => {
    const out = formatNodeName({
      name: '🇭🇰 香港 01',
      index: 1,
      indexWidth: 2,
      config: config('${emoji} ${region}${?index: · ${index}}'),
    });
    expect(out).toBe('🇭🇰 香港 · 01');
  });

  it('upstream ordinal reuse: 香港 01 renders 01 (not position)', () => {
    const out = formatNodeName({
      name: '香港 01',
      index: 7,
      indexWidth: 2,
      config: config('${emoji} ${region}${?index: · ${index}}'),
    });
    expect(out).toBe('🇭🇰 香港 · 01');
  });

  it('1x rate omitted by default; ${rate:include1x} shows it', () => {
    const base = config('${emoji} ${region}${?rate: · ${rate}}');
    expect(formatNodeName({ name: '香港 1x 01', index: 1, indexWidth: 2, config: base })).toBe(
      '🇭🇰 香港',
    );
    expect(formatNodeName({ name: '香港 2x 01', index: 1, indexWidth: 2, config: base })).toBe(
      '🇭🇰 香港 · 2x',
    );
    const all = config('${emoji} ${region}${?rate: · ${rate:include1x}}');
    expect(formatNodeName({ name: '香港 1x 01', index: 1, indexWidth: 2, config: all })).toBe(
      '🇭🇰 香港 · 1x',
    );
  });

  it('missing optional components leave no duplicate separators', () => {
    const out = formatNodeName({
      name: 'foo-bar',
      index: 1,
      indexWidth: 2,
      config: config(
        '${emoji} ${region}${?route: · ${route}}${?note: · ${note}}${?index: · ${index}}',
      ),
    });
    expect(out).toBe('foo-bar · 01');
    expect(out).not.toContain('· ·');
  });

  it('region vs region_code placeholders', () => {
    const opts = { index: 1, indexWidth: 2 };
    expect(formatNodeName({ name: '香港 01', config: config('${emoji} ${region}'), ...opts })).toBe(
      '🇭🇰 香港',
    );
    expect(
      formatNodeName({ name: '香港 01', config: config('${emoji} ${region_code}'), ...opts }),
    ).toBe('🇭🇰 HK');
  });

  it('tw2cn renders the CN flag for TW nodes', () => {
    expect(
      formatNodeName({
        name: '台湾 01',
        index: 1,
        indexWidth: 2,
        config: config('${emoji} ${region}', { tw2cn: true }),
      }).startsWith('🇨🇳'),
    ).toBe(true);
    expect(
      formatNodeName({
        name: '台湾 01',
        index: 1,
        indexWidth: 2,
        config: config('${emoji} ${region}'),
      }).startsWith('🇹🇼'),
    ).toBe(true);
  });

  it('never produces an empty name — falls back to the original', () => {
    const out = formatNodeName({
      name: '原始名',
      index: 1,
      indexWidth: 2,
      config: config('${?index: · ${index}}'),
    });
    expect(out).toBe('原始名');
  });

  it('source alias + per-source index components', () => {
    const out = formatNodeName({
      name: '香港 01',
      source: { key: 'airport-a', label: '机场A' },
      index: 1,
      indexWidth: 2,
      config: config('${emoji} ${region}${?source: · ${source}}${?index: · ${index}}'),
    });
    expect(out).toBe('🇭🇰 香港 · 机场A · 01');
  });

  it('manual sourceAlias override wins over the label', () => {
    const out = formatNodeName({
      name: '香港 01',
      source: { key: 'airport-a', label: '机场A' },
      index: 1,
      indexWidth: 2,
      config: config('${region}${?source: · ${source}}', {
        sourceAliases: { 'airport-a': '改名机场' },
      }),
    });
    expect(out).toBe('香港 · 改名机场');
    expect(out).not.toContain('机场A');
  });
});

/* ─── executor ─────────────────────────────────────────────────────── */

/** Distinct node configs so identity dedup never swallows test fixtures. */
function distinctProxy(name: string, type = 'vless', seed = 0): Record<string, unknown> {
  return proxy(name, type, { uuid: `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}` });
}

describe('applyRenameTemplate', () => {
  it('renames deterministically with the default template; upstream ordinals stable', () => {
    const identityA: SourceIdentity = { key: 'a', label: '机场A' };
    const identityB: SourceIdentity = { key: 'b', label: '机场B' };
    const input = [
      withSource(distinctProxy('香港 01'), identityA),
      withSource(distinctProxy('香港 02', 'vless', 1), identityA),
      withSource(distinctProxy('日本 01', 'vless', 2), identityB),
    ];
    const { proxies, changed, collisions, deduped } = applyRenameTemplate(
      input,
      config(AGG_TEMPLATE),
    );
    expect(changed).toBe(3);
    expect(collisions).toEqual([]);
    expect(deduped).toEqual([]);
    expect(proxies.map((p) => p.name)).toEqual([
      '🇭🇰 香港 · 机场A · 01',
      '🇭🇰 香港 · 机场A · 02',
      '🇯🇵 日本 · 机场B · 01',
    ]);
  });

  it('true dedup is identity-based: same NAME + different config keeps BOTH nodes', () => {
    // Same display name, different credentials → genuinely different nodes.
    const identityA: SourceIdentity = { key: 'a', label: '机场A' };
    const identityB: SourceIdentity = { key: 'b', label: '机场B' };
    const input = [
      withSource(distinctProxy('香港 01'), identityA),
      withSource(distinctProxy('香港 01', 'vless', 1), identityB),
    ];
    const { proxies, deduped } = applyRenameTemplate(input, config(AGG_TEMPLATE));
    expect(proxies).toHaveLength(2);
    expect(deduped).toEqual([]);
    expect(proxies.map((p) => p.name)).toEqual(['🇭🇰 香港 · 机场A · 01', '🇭🇰 香港 · 机场B · 01']);
  });

  it('true dedup: same node identity with different names dedups once per source priority', () => {
    const identityA: SourceIdentity = { key: 'a', label: '机场A' };
    const input = [
      withSource(proxy('香港 01'), identityA),
      withSource(proxy('香港 02'), identityA),
    ];
    const { proxies, deduped } = applyRenameTemplate(input, config(AGG_TEMPLATE));
    expect(proxies).toHaveLength(1);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ kept: '香港 01', dropped: '香港 02', sourceKey: 'a' });
    expect(proxies[0].name).toBe('🇭🇰 香港 · 机场A · 01');
  });

  it('true dedup across sources: first source in input order wins', () => {
    const identityA: SourceIdentity = { key: 'a', label: '机场A' };
    const identityB: SourceIdentity = { key: 'b', label: '机场B' };
    const input = [
      withSource(proxy('机场A 香港 01'), identityA),
      withSource(proxy('机场B 香港 01'), identityB),
    ];
    const { proxies, deduped } = applyRenameTemplate(input, config(AGG_TEMPLATE));
    expect(proxies).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ sourceKey: 'b' });
  });

  it('per-source numbering restarts per source (no ${source} in template)', () => {
    const identityA: SourceIdentity = { key: 'a', label: '机场A' };
    const identityB: SourceIdentity = { key: 'b', label: '机场B' };
    const noSource = config('${emoji} ${region}${?index: · ${index}}');
    const { proxies } = applyRenameTemplate(
      [
        withSource(distinctProxy('香港 01'), identityA),
        withSource(distinctProxy('日本 01', 'vless', 1), identityB),
      ],
      noSource,
    );
    expect(proxies.map((p) => p.name)).toEqual(['🇭🇰 香港 · 01', '🇯🇵 日本 · 01']);
  });

  it('collision treatment: deterministic MEANINGFUL suffix (source + stable index), not #N-only', () => {
    // Two sources with the SAME label and same upstream ordinal → formatted
    // names collide → the suffix is source+index; equal labels still collide
    // and get #N on top.
    const input = [
      withSource(distinctProxy('香港 foo'), { key: 'a', label: '同源' }),
      withSource(distinctProxy('香港 foo', 'vless', 1), { key: 'b', label: '同源' }),
    ];
    const { proxies, changed, collisions } = applyRenameTemplate(input, config(AGG_TEMPLATE));
    expect(proxies.map((p) => p.name)).toEqual([
      '🇭🇰 香港 · 同源 · 01',
      '🇭🇰 香港 · 同源 · 01 · 同源-01',
    ]);
    expect(changed).toBe(2);
    expect(collisions).toEqual(['🇭🇰 香港 · 同源 · 01']);
  });

  it('collision without any source falls back to a stable #N suffix', () => {
    const cfg = config('${region}');
    const input = [distinctProxy('香港 foo'), distinctProxy('香港 foo', 'vless', 1)];
    const { proxies } = applyRenameTemplate(input, cfg);
    expect(proxies.map((p) => p.name)).toEqual(['香港', '香港 #2']);
  });

  it('changed nodes suffix against UNCHANGED names that come LATER (forward collision)', () => {
    const cfg = config('${emoji} ${region}${?note: · ${note}}');
    const input = [distinctProxy('香港 foo'), distinctProxy('🇭🇰 香港 · foo', 'vless', 1)];
    const { proxies, changed, collisions } = applyRenameTemplate(input, cfg);
    expect(proxies.map((p) => p.name)).toEqual(['🇭🇰 香港 · foo #2', '🇭🇰 香港 · foo']);
    expect(changed).toBe(1);
    expect(collisions).toEqual(['🇭🇰 香港 · foo']);
  });

  it('duplicate UNCHANGED names get a stable suffix — output is always unique', () => {
    const cfg = config('${note}');
    const input = [distinctProxy('abc'), distinctProxy('abc', 'vless', 1)];
    const { proxies, collisions, changed } = applyRenameTemplate(input, cfg);
    expect(proxies.map((p) => p.name)).toEqual(['abc', 'abc #2']);
    expect(changed).toBe(1);
    expect(collisions).toEqual(['abc']);
  });

  it('three-way duplicates suffix in input order (#2, #3)', () => {
    const { proxies } = applyRenameTemplate(
      [distinctProxy('abc'), distinctProxy('abc', 'vless', 1), distinctProxy('abc', 'vless', 2)],
      config('${note}'),
    );
    expect(proxies.map((p) => p.name)).toEqual(['abc', 'abc #2', 'abc #3']);
  });

  it('a pre-existing ` #N` name in the input is never re-taken', () => {
    const cfg = config('${note}');
    const { proxies } = applyRenameTemplate(
      [distinctProxy('abc'), distinctProxy('abc', 'vless', 1), distinctProxy('abc #2', 'vless', 2)],
      cfg,
    );
    expect(proxies.map((p) => p.name)).toEqual(['abc', 'abc #3', 'abc #2']);
    expect(new Set(proxies.map((p) => p.name)).size).toBe(3);
  });

  it('idempotent: running the pipeline over its own output changes nothing', () => {
    const cfg = config('${emoji} ${region}${?index: · ${index}}');
    const input = [
      distinctProxy('abc'),
      distinctProxy('abc', 'vless', 1),
      distinctProxy('香港 01', 'vless', 2),
      distinctProxy('香港 01', 'vless', 3),
    ];
    const first = applyRenameTemplate(input, cfg);
    expect(new Set(first.proxies.map((p) => p.name)).size).toBe(first.proxies.length);
    const second = applyRenameTemplate(first.proxies, cfg);
    expect(second.proxies.map((p) => p.name)).toEqual(first.proxies.map((p) => p.name));
    expect(second.changed).toBe(0);
    expect(second.collisions).toEqual([]);
    expect(second.deduped).toEqual([]);
  });

  it('invalid (optional-only) templates fall back to the raw name — never empty', () => {
    const input = [proxy('香港 01')];
    const { proxies, changed } = applyRenameTemplate(input, config('${?index: · ${index}}'));
    expect(proxies[0].name).toBe('香港 01');
    expect(changed).toBe(0);
  });

  it('unrecognizable names still render the required index + their residual note', () => {
    const input = [distinctProxy('!!!'), distinctProxy('香港 01', 'vless', 1)];
    const { proxies, changed } = applyRenameTemplate(input, config('${index}${?note: · ${note}}'));
    // '香港 01' has a pure-numeric residual → upstream ordinal; '!!!' keeps its note
    expect(proxies.map((p) => p.name)).toEqual(['01 · !!!', '01']);
    expect(changed).toBe(2);
  });

  it('preserves non-name fields and unknown extra keys (spread)', () => {
    const input = [{ ...distinctProxy('香港 01'), udp: true, 'skip-cert-verify': false }];
    const { proxies } = applyRenameTemplate(
      input,
      config('${emoji} ${region}${?index: · ${index}}'),
    );
    expect(proxies[0]).toMatchObject({
      name: '🇭🇰 香港 · 01',
      udp: true,
      'skip-cert-verify': false,
      server: 'edge.invalid',
    });
  });

  it('index width adapts to the largest ordinal in the source', () => {
    const identity: SourceIdentity = { key: 'a', label: '机场A' };
    const input = Array.from({ length: 12 }, (_, i) =>
      withSource(distinctProxy(`香港 ${String(i + 1).padStart(2, '0')}`, 'vless', i + 1), identity),
    );
    const { proxies } = applyRenameTemplate(input, config(AGG_TEMPLATE));
    expect(proxies[11].name).toBe('🇭🇰 香港 · 机场A · 12');
  });

  it('persisted ordinal assignments win over upstream ordinals and never churn', () => {
    const identity: SourceIdentity = { key: 'a', label: '机场A' };
    const resolver: OrdinalResolver = (_proxy, sourceKey) => (sourceKey === 'a' ? 5 : undefined);
    const input = [withSource(distinctProxy('香港 foo'), identity)];
    const { proxies } = applyRenameTemplate(input, config(AGG_TEMPLATE), undefined, resolver);
    expect(proxies[0].name).toBe('🇭🇰 香港 · 机场A · 05');
    // reordering upstream: the persisted assignment still wins → no churn
    const reordered = applyRenameTemplate(
      [withSource(distinctProxy('香港 foo'), identity)],
      config(AGG_TEMPLATE),
      undefined,
      resolver,
    );
    expect(reordered.proxies[0].name).toBe(proxies[0].name);
  });

  it('same fingerprint renders the same name regardless of display-name order (source reorder)', () => {
    const identityA: SourceIdentity = { key: 'a', label: '机场A' };
    const identityB: SourceIdentity = { key: 'b', label: '机场B' };
    const a = withSource(distinctProxy('香港 01'), identityA);
    const b = withSource(distinctProxy('日本 01', 'vless', 1), identityB);
    const first = applyRenameTemplate([a, b], config(AGG_TEMPLATE));
    const second = applyRenameTemplate([b, a], config(AGG_TEMPLATE));
    // per-node names are identical — only list order changed
    expect(second.proxies.map((p) => p.name).sort()).toEqual(
      first.proxies.map((p) => p.name).sort(),
    );
  });

  it('two raw identities that CONVERGE after set-prop still both survive (immutable raw fingerprint)', () => {
    // Delivery repro: n1 carries udp:false, n2 has NO udp field — different
    // RAW configs. set-prop udp:true makes the post-transform objects
    // IDENTICAL; without the fetch-boundary fingerprint the executor would
    // true-dedup them to one node. The immutable raw identity must keep both.
    const identity: SourceIdentity = { key: 'a', label: '机场A' };
    const n1 = withRawIdentity(
      { name: '香港 01', type: 'ss', server: 'edge.invalid', port: 443, udp: false },
      identity,
    );
    const n2 = withRawIdentity(
      { name: '香港 02', type: 'ss', server: 'edge.invalid', port: 443 },
      identity,
    );
    const { proxies } = applyOperators(
      [n1, n2] as never,
      [
        { id: 'sp', kind: 'set-prop', udp: true },
        {
          id: 'rt',
          kind: 'rename-template',
          template: '${emoji} ${region}${?index: · ${index}}',
          recognitionRules: [],
        },
      ] as never,
    );
    expect(proxies).toHaveLength(2);
    expect(proxies.map((p) => p.name)).toEqual(['🇭🇰 香港 · 01', '🇭🇰 香港 · 02']);
  });
});

/* ─── fingerprint ──────────────────────────────────────────────────── */

describe('nodeFingerprint (server-only identity)', () => {
  it('same config ⇒ same fingerprint; name is excluded', () => {
    const a = proxy('香港 01', 'vless', { uuid: '11111111-1111-4111-8111-111111111111' });
    const b = proxy('香港 02', 'vless', { uuid: '11111111-1111-4111-8111-111111111111' });
    expect(nodeFingerprint(a)).toBe(nodeFingerprint(b));
  });

  it('different credentials ⇒ different fingerprint (distinct nodes)', () => {
    const a = proxy('香港 01', 'vless', { uuid: '11111111-1111-4111-8111-111111111111' });
    const b = proxy('香港 01', 'vless', { uuid: '22222222-2222-4222-8222-222222222222' });
    expect(nodeFingerprint(a)).not.toBe(nodeFingerprint(b));
  });

  it('key order never matters (canonical serialization)', () => {
    const a = proxy('x', 'ss', { cipher: 'aes-128-gcm', password: 'p' });
    const b = { ...proxy('x', 'ss'), password: 'p', cipher: 'aes-128-gcm' };
    expect(nodeFingerprint(a)).toBe(nodeFingerprint(b));
  });

  it('nodes without a server have no fingerprint (never identity-deduped)', () => {
    expect(nodeFingerprint({ name: 'x', type: 'ss' })).toBeNull();
  });

  it('fingerprint is a fixed-width opaque hash, never endpoint plaintext', () => {
    const fp = nodeFingerprint(proxy('香港 01'));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('edge.invalid');
  });
});

/* ─── defaults ─────────────────────────────────────────────────────── */

describe('defaultTemplateFor', () => {
  it('aggregates include the member-source segment; single subs do not', () => {
    expect(defaultTemplateFor(true)).toBe(AGG_TEMPLATE);
    expect(defaultTemplateFor(false)).not.toContain('${?source:');
    expect(defaultTemplateFor(false)).toContain('${index}');
  });
});
