import { describe, expect, it } from 'vitest';
import {
  compileTemplate,
  DEFAULT_NAMING_TEMPLATE,
  defaultTemplateFor,
  formatNodeName,
  LEGACY_BALANCED_TEMPLATE,
  MAX_TEMPLATE_NESTING,
  renderTemplate,
  templateFromLegacyConfig,
  validateTemplate,
  type RenameTemplateConfig,
} from '@/lib/proxies/naming';

function config(template: string): RenameTemplateConfig {
  return { template };
}

/* ─── the approved default template ────────────────────────────────── */

describe('default template (approved example)', () => {
  it('renders the intended flag-region block and optional segments', () => {
    const tokens = compileTemplate(DEFAULT_NAMING_TEMPLATE);
    const out = renderTemplate(tokens, {
      emoji: '🇭🇰',
      region: '香港',
      route: '中转',
      source: 'IMM',
      index: '01',
      rate: '2x',
    });
    expect(out).toBe('🇭🇰 香港 · 中转 · IMM · 01 · 2x');
  });

  it('flag + region are ONE visual block with a normal space', () => {
    const tokens = compileTemplate(DEFAULT_NAMING_TEMPLATE);
    expect(renderTemplate(tokens, { emoji: '🇭🇰', region: '香港' })).toBe('🇭🇰 香港');
  });

  it('missing fields remove their complete optional segment — no doubled/dangling separators', () => {
    const tokens = compileTemplate(DEFAULT_NAMING_TEMPLATE);
    // every optional segment empty ⇒ only the required block remains
    expect(renderTemplate(tokens, { emoji: '🇭🇰', region: '香港' })).toBe('🇭🇰 香港');
    // region present, everything else missing
    expect(renderTemplate(tokens, { emoji: '🇭🇰', region: '香港', route: '中转' })).toBe(
      '🇭🇰 香港 · 中转',
    );
    // no region at all ⇒ no stray separators, no empty block
    expect(renderTemplate(tokens, { index: '01' })).toBe('01');
  });

  it('single-subscription default omits the source segment; collections keep it', () => {
    const single = defaultTemplateFor(false);
    const aggregate = defaultTemplateFor(true);
    expect(aggregate).toBe(DEFAULT_NAMING_TEMPLATE);
    expect(single).toContain('${region}');
    expect(single).not.toContain('${?source:');
    expect(compileTemplate(single)).toBeTruthy();
  });
});

/* ─── parser: literals, escapes, nesting ───────────────────────────── */

describe('DSL parser', () => {
  it('accepts the fully optional-segmented default (nested placeholder inside optional)', () => {
    const tokens = compileTemplate(DEFAULT_NAMING_TEMPLATE);
    expect(tokens).toContainEqual({ type: 'field', field: 'emoji' });
    expect(tokens).toContainEqual({ type: 'field', field: 'region' });
    expect(tokens).toContainEqual({
      type: 'optional',
      field: 'route',
      children: [
        { type: 'literal', text: ' · ' },
        { type: 'field', field: 'route' },
      ],
    });
  });

  it('$$ is the literal escape: $${ renders ${', () => {
    const tokens = compileTemplate('价格 $${rate} 起');
    expect(renderTemplate(tokens, {})).toBe('价格 ${rate} 起');
  });

  it('a lone $ is literal text', () => {
    expect(renderTemplate(compileTemplate('$5 折扣'), {})).toBe('$5 折扣');
  });

  it('rejects unknown placeholders', () => {
    expect(validateTemplate('${foo}').ok).toBe(false);
    expect(validateTemplate('${?bar: ${region}}').ok).toBe(false);
  });

  it('rejects unclosed placeholders and empty optional content', () => {
    expect(validateTemplate('${region').ok).toBe(false);
    expect(validateTemplate('${?region: }').ok).toBe(false);
    expect(validateTemplate('${?region').ok).toBe(false);
  });

  it('rejects unsupported modifiers and empty modifier bodies', () => {
    expect(validateTemplate('${emoji:upper}').ok).toBe(false);
    expect(validateTemplate('${region:}').ok).toBe(false);
    expect(validateTemplate('${rate:upper}').ok).toBe(false);
    expect(validateTemplate('${protocol:shout}').ok).toBe(false);
  });

  it('accepts the bounded modifiers: index width, rate include1x, protocol casing', () => {
    expect(validateTemplate('${index:03}').ok).toBe(true);
    expect(validateTemplate('${index:1}').ok).toBe(true);
    expect(validateTemplate('${rate:include1x}').ok).toBe(true);
    expect(validateTemplate('${protocol:upper}').ok).toBe(true);
    expect(validateTemplate('${protocol:lower}').ok).toBe(true);
    expect(validateTemplate('${index:12345}').ok).toBe(false);
  });

  it('bounds the index width modifier to 1..4 at every boundary', () => {
    // 0, out-of-range, and huge widths all reject
    for (const bad of ['0', '5', '00', '9999', '123456']) {
      expect(validateTemplate(`\${index:${bad}}`).ok, `\${index:${bad}}`).toBe(false);
    }
    for (const good of ['1', '2', '3', '4', '01', '04']) {
      expect(validateTemplate(`\${index:${good}}`).ok, `\${index:${good}}`).toBe(true);
    }
    // rendering never allocates attacker-sized output even from a corrupted row
    const out = renderTemplate(compileTemplate('${index:4}'), { index: '7' });
    expect(out).toBe('0007');
    expect(out.length).toBeLessThanOrEqual(4);
  });

  it('rejects excessive nesting beyond the bound', () => {
    expect(MAX_TEMPLATE_NESTING).toBe(2);
    // depth 3 (optional inside optional inside optional) is rejected
    expect(validateTemplate('${index}${?region: ${?route: ${?vendor: x}}}').ok).toBe(false);
    // depth 2 is allowed
    expect(validateTemplate('${index}${?region: ${?route: ${route}}}').ok).toBe(true);
  });

  it('rejects over-long templates', () => {
    const long = 'x'.repeat(513);
    expect(validateTemplate(`${long}`).ok).toBe(false);
    expect(validateTemplate(`${'x'.repeat(512)}`).ok).toBe(true);
  });

  it('rejects templates with no required content (could render empty)', () => {
    expect(validateTemplate('${?region: ${region}}').ok).toBe(false);
    expect(validateTemplate('   ').ok).toBe(false);
    expect(validateTemplate('${?route: · ${route}}${?index: · ${index}}').ok).toBe(false);
  });

  it('rejects unsafe constructs (no eval / loops / arbitrary code shapes)', () => {
    for (const evil of [
      '${note:${process}}',
      '${note:${eval}}',
      '${?note: ${note:include1x}}', // modifier on the wrong field
      '${index:${region}}', // non-numeric modifier
    ]) {
      expect(validateTemplate(evil).ok).toBe(false);
    }
  });

  it('keeps literal text between fields verbatim', () => {
    const tokens = compileTemplate('节点 ${region}（${region_code}）');
    expect(renderTemplate(tokens, { region: '香港', regionCode: 'HK' })).toBe('节点 香港（HK）');
  });
});

/* ─── renderer: modifiers + tidy ───────────────────────────────────── */

describe('DSL renderer', () => {
  it('${index:N} zero-pads to the requested width', () => {
    expect(renderTemplate(compileTemplate('${index:03}'), { index: '7' })).toBe('007');
    expect(renderTemplate(compileTemplate('${index:03}'), { index: '123' })).toBe('123');
  });

  it('${rate} omits 1x; ${rate:include1x} renders it; other rates always render', () => {
    expect(renderTemplate(compileTemplate('${rate}'), { rate: '1x' })).toBe('');
    expect(renderTemplate(compileTemplate('${rate:include1x}'), { rate: '1x' })).toBe('1x');
    expect(renderTemplate(compileTemplate('${rate}'), { rate: '2x' })).toBe('2x');
    expect(renderTemplate(compileTemplate('${rate:include1x}'), { rate: '0.5x' })).toBe('0.5x');
  });

  it('${protocol:upper} / ${protocol:lower} control casing', () => {
    expect(renderTemplate(compileTemplate('${protocol:upper}'), { protocol: 'vless' })).toBe(
      'VLESS',
    );
    expect(renderTemplate(compileTemplate('${protocol:lower}'), { protocol: 'VLESS' })).toBe(
      'vless',
    );
    expect(renderTemplate(compileTemplate('${protocol}'), { protocol: 'vless' })).toBe('vless');
  });

  it('trims stray separators at both ends when a required field is missing', () => {
    const tokens = compileTemplate('${emoji} ${region}${?route: · ${route}}');
    expect(renderTemplate(tokens, { route: '中转' })).toBe('中转');
    expect(renderTemplate(tokens, { emoji: '🇭🇰' })).toBe('🇭🇰');
  });

  it('collapses whitespace runs to a single space', () => {
    expect(renderTemplate(compileTemplate('a   b'), {})).toBe('a b');
  });
});

/* ─── formatNodeName end-to-end via the template ───────────────────── */

describe('formatNodeName with templates', () => {
  it('manual acceptance: template renders the flag-region block + segments', () => {
    const out = formatNodeName({
      name: '香港 中转 2x 01',
      type: 'vless',
      source: { key: 'imm', label: 'IMM' },
      index: 1,
      indexWidth: 2,
      config: config(DEFAULT_NAMING_TEMPLATE),
    });
    expect(out).toBe('🇭🇰 香港 · 中转 · IMM · 01 · 2x');
  });

  it('anime-style residual names are omitted (no ${note}) while region survives', () => {
    const out = formatNodeName({
      name: '🇭🇰 香港 初音未来',
      index: 1,
      indexWidth: 2,
      config: config(DEFAULT_NAMING_TEMPLATE),
    });
    expect(out).toBe('🇭🇰 香港 · 01');
  });

  it('${?note: · ${note}} keeps meaningful residuals when the user asks for them', () => {
    const withNote = '${emoji} ${region}${?note: · ${note}}';
    const out = formatNodeName({
      name: '香港 东京 初音',
      index: 1,
      indexWidth: 2,
      config: config(withNote),
    });
    expect(out).toBe('🇭🇰 香港 · 东京 初音');
  });

  it('${region_code} renders the alpha-2 code instead of the zh label', () => {
    const out = formatNodeName({
      name: '香港 01',
      index: 1,
      indexWidth: 2,
      config: config('${emoji} ${region_code}${?index: · ${index}}'),
    });
    expect(out).toBe('🇭🇰 HK · 01');
  });

  it('never emits an empty name — falls back to the original', () => {
    const out = formatNodeName({
      name: '原始名',
      index: 1,
      indexWidth: 2,
      config: config('${?index: · ${index}}'),
    });
    expect(out).toBe('原始名');
  });

  it('tw2cn renders the CN flag for TW nodes', () => {
    expect(
      formatNodeName({
        name: '台湾 01',
        index: 1,
        indexWidth: 2,
        config: { ...config('${emoji} ${region}'), tw2cn: true },
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

  it('source alias override wins over the label', () => {
    const out = formatNodeName({
      name: '香港 01',
      source: { key: 'airport-a', label: '机场A' },
      index: 1,
      indexWidth: 2,
      config: {
        template: '${region}${?source: · ${source}}',
        sourceAliases: { 'airport-a': '改名机场' },
      },
    });
    expect(out).toBe('香港 · 改名机场');
  });
});

/* ─── legacy compatibility projection ──────────────────────────────── */

describe('templateFromLegacyConfig', () => {
  it('projects the legacy balanced preset deterministically', () => {
    expect(LEGACY_BALANCED_TEMPLATE).toBe(
      '${emoji} ${region}${?route: · ${route}}${?rate: · ${rate}}${?note: · ${note}}${?index: · ${index}}',
    );
    // the projection must itself be a valid template
    expect(validateTemplate(LEGACY_BALANCED_TEMPLATE).ok).toBe(true);
  });

  it('preserves the legacy separator between components', () => {
    const t = templateFromLegacyConfig({
      preset: 'custom',
      components: {
        flag: true,
        region: true,
        route: true,
        vendor: false,
        protocol: true,
        rate: true,
        source: true,
        index: true,
      },
      regionLabel: 'zh',
      rateDisplay: 'all',
      separator: ' | ',
    });
    expect(t).toBe(
      '${emoji} ${region}${?route: | ${route}}${?protocol: | ${protocol}}${?rate: | ${rate:include1x}}${?note: | ${note}}${?source: | ${source}}${?index: | ${index}}',
    );
  });

  it('regionLabel=code projects ${region_code}; the legacy note segment is always projected', () => {
    const t = templateFromLegacyConfig({
      preset: 'custom',
      components: {
        flag: true,
        region: true,
        route: false,
        vendor: false,
        protocol: false,
        rate: false,
        source: false,
        index: false,
      },
      regionLabel: 'code',
      rateDisplay: 'omit-1x',
      separator: ' ',
    });
    expect(t).toBe('${emoji} ${region_code}${?note: ${note}}');
  });

  it('components off ⇒ no required block, but the legacy note segment stays optional', () => {
    const t = templateFromLegacyConfig({
      preset: 'custom',
      components: {
        flag: false,
        region: false,
        route: false,
        vendor: false,
        protocol: false,
        rate: false,
        source: false,
        index: false,
      },
      regionLabel: 'zh',
      rateDisplay: 'omit-1x',
      separator: ' · ',
    });
    // A VALID legacy row must stay ACTIVE: all components off means legacy
    // composed only the residual base — projected to the required ${note}
    // placeholder (never an optional-only string that would disable the step).
    expect(t).toBe('${note}');
    expect(validateTemplate(t).ok).toBe(true);
  });

  it('route-only legacy config projects with a REQUIRED route anchor (active)', () => {
    const t = templateFromLegacyConfig({
      preset: 'custom',
      components: {
        flag: false,
        region: false,
        route: true,
        vendor: false,
        protocol: false,
        rate: false,
        source: false,
        index: false,
      },
      regionLabel: 'zh',
      rateDisplay: 'omit-1x',
      separator: ' · ',
    });
    expect(t).toBe('${route}${?note: · ${note}}');
    expect(validateTemplate(t).ok).toBe(true);
  });
});
