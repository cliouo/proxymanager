import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { resolveConfig } from '@/lib/engine/resolve';
import {
  buildStarterBlueprint,
  STARTER_BASE_CONTENT,
  STARTER_BLUEPRINT_VERSION,
} from '@/lib/setup/starterBlueprint';

describe('starter blueprint', () => {
  it('is a versioned minimal safe asset without opt-in subsystems', () => {
    const starter = buildStarterBlueprint(1_700_000_000);
    const base = parse(starter.baseContent) as Record<string, unknown>;

    expect(starter.version).toBe(STARTER_BLUEPRINT_VERSION);
    expect(base).toMatchObject({
      mode: 'rule',
      'allow-lan': false,
      'log-level': 'info',
      rules: null,
    });
    expect(STARTER_BASE_CONTENT).toContain('# === PROXY-GROUPS ===');
    expect(STARTER_BASE_CONTENT).toContain('# === RULE-PROVIDERS ===');
    expect(STARTER_BASE_CONTENT).toContain('# === ANCHOR: late ===');
    expect(base).not.toHaveProperty('dns');
    expect(base).not.toHaveProperty('tun');
    expect(base).not.toHaveProperty('sniffer');
    expect(base).not.toHaveProperty('proxies');
    expect(base).not.toHaveProperty('rule-providers');
    expect(base).not.toHaveProperty('proxy-groups');
    expect(base).not.toHaveProperty('mixed-port');
    expect(base).not.toHaveProperty('port');
    expect(base).not.toHaveProperty('socks-port');
    expect(starter.rules).toEqual([
      expect.objectContaining({ type: 'MATCH', policy: '默认', anchor: 'late' }),
    ]);
    expect(starter.proxyGroups).toEqual([
      expect.objectContaining({
        name: '自动选择',
        type: 'url-test',
        'include-all-proxies': true,
        'empty-fallback': 'DIRECT',
        interval: 600,
        notes: 'setup-bootstrap:starter-v1',
      }),
      expect.objectContaining({
        name: '默认',
        type: 'select',
        proxies: ['自动选择', 'DIRECT'],
        notes: 'setup-bootstrap:starter-v1',
      }),
    ]);
    expect(starter.rules[0]).toMatchObject({
      rank: 1_000_000,
      enabled: true,
      note: 'setup-bootstrap:starter-v1',
    });
  });

  it('leaves listener ports to the importing proxy client', () => {
    const starter = buildStarterBlueprint(1_700_000_000);

    expect(starter.baseContent).not.toMatch(/^(?:mixed-port|port|socks-port):/mu);
    expect(starter.baseContent).toContain('allow-lan: false');
    expect(starter.baseContent).not.toMatch(/\b(?:dns|tun|sniffer):/u);
  });

  it('renders and validates the exact final config with zero proxy nodes', async () => {
    const starter = buildStarterBlueprint(1_700_000_000);
    const rendered = await resolveConfig(
      starter.baseContent,
      starter.rules,
      [],
      starter.proxyGroups,
      [],
      {
        boundSource: starter.profile.source,
        persistSnapshot: false,
      },
    );
    const final = parse(rendered.content) as {
      rules: string[];
      'proxy-groups': Array<Record<string, unknown>>;
    };

    expect(final.rules).toEqual(['MATCH,默认']);
    expect(final['proxy-groups']).toEqual([
      expect.objectContaining({ name: '自动选择', 'empty-fallback': 'DIRECT' }),
      expect.objectContaining({ name: '默认', proxies: ['自动选择', 'DIRECT'] }),
    ]);
    expect(rendered.unmatchedAnchors).toEqual([]);
  });
});
