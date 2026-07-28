import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import SetupPage from '@/app/(authed)/setup/page';
import { SetupWizard, StarterSummary } from '@/components/setup/SetupWizard';
import {
  encodeSetupDraft,
  restoreSetupDraft,
  setupCanRun,
  setupNeedsAttention,
  setupNeedsRepair,
  STARTER_SUMMARY,
} from '@/lib/client/setup';
import { buildStarterBlueprint } from '@/lib/setup/starterBlueprint';
import {
  SetupBootstrapRequestSchema,
  SetupBootstrapResponseSchema,
  type SetupApiStatus,
} from '@/schemas/setup';

function status(overrides: Partial<SetupApiStatus> = {}): SetupApiStatus {
  return {
    state: 'empty',
    can_bootstrap: true,
    revision: 7,
    starter_version: 'starter-v1',
    reason_codes: [],
    inventory: {
      profiles_total: 0,
      profiles_valid: 0,
      profiles_invalid: 0,
      default_profile_id: null,
      has_base: false,
      base_content_present: false,
      base_meta_present: false,
      proxy_groups_total: 0,
      proxy_groups_invalid: 0,
      rules_total: 0,
      rules_invalid: 0,
      source_type: null,
    },
    starter: {
      profile_name: 'default',
      listener_ports: 'client-managed',
      allow_lan: false,
      mode: 'rule',
      log_level: 'info',
      dns_enabled: false,
      tun_enabled: false,
      sniffer_enabled: false,
      rule_sets_total: 0,
      proxy_groups: [
        { name: '自动选择', type: 'url-test' },
        { name: '默认', type: 'select' },
      ],
      final_rule: 'MATCH,默认',
    },
    provenance: null,
    diagnostics: [],
    ...overrides,
  };
}

describe('setup UI state contract', () => {
  it('routes empty, recoverable, and blocked states to setup while allowing configured instances', () => {
    expect(setupNeedsAttention(status())).toBe(true);
    expect(setupCanRun(status())).toBe(true);

    const repairable = status({
      state: 'recoverable',
      can_bootstrap: true,
    });
    expect(setupNeedsAttention(repairable)).toBe(true);
    expect(setupNeedsRepair(repairable)).toBe(true);
    expect(setupCanRun(repairable)).toBe(true);

    const blocked = status({
      state: 'blocked',
      can_bootstrap: false,
    });
    expect(setupCanRun(blocked)).toBe(false);

    const ready = status({
      state: 'configured',
      can_bootstrap: false,
      reason_codes: ['proxy_group_schema_invalid', 'already_configured'],
      diagnostics: [
        {
          code: 'proxy_group_schema_invalid',
          component: 'proxy-groups',
          message: 'One or more proxy-group records cannot be parsed safely.',
          repairable: false,
        },
      ],
    });
    expect(setupNeedsAttention(ready)).toBe(false);
    expect(setupCanRun(ready)).toBe(false);
  });

  it('restores the review step only from the same starter revision', () => {
    const current = status();
    const draft = encodeSetupDraft('review', current);

    expect(restoreSetupDraft(draft, current)).toEqual({ step: 'review' });
    expect(restoreSetupDraft(draft, status({ revision: 8 }))).toEqual({ step: 'welcome' });
    expect(restoreSetupDraft('{', current)).toEqual({ step: 'welcome' });
    expect(JSON.parse(draft)).toEqual({
      step: 'review',
      revision: 7,
      starter_version: 'starter-v1',
    });
  });

  it('renders the fixed safe starter summary from the implemented blueprint', () => {
    const html = renderToStaticMarkup(createElement(StarterSummary));

    expect(html).toContain('由代理客户端管理');
    expect(html).toContain('starter 不写入');
    expect(html).not.toContain('mixed-port 7890');
    expect(html).toContain('allow-lan');
    expect(html).toContain('自动选择');
    expect(html).toContain('MATCH,默认');
    expect(html).toContain('DNS、TUN、sniffer、rule-set');
  });

  it('keeps the revision-only request, receipt, and uncertain result semantics visible', () => {
    const source = readFileSync(
      new URL('../../components/setup/SetupWizard.tsx', import.meta.url),
      'utf8',
    );

    expect(source).not.toContain('name="mixed_port"');
    expect(source).not.toContain('mixed_port:');
    expect(source).toContain('expected_revision: status.revision');
    expect(source).toContain('starter_version: status.starter_version');
    expect(source).toContain('监听端口由客户端管理');
    expect(source).toContain('receipt.resources.base_etag');
    expect(source).toContain('receipt.readiness.config_renderable');
    expect(source).toContain('实例已配置');
    expect(source).toContain('不能证明本标签页的 starter');
  });

  it('keeps desktop width bounded and the 375px flow single-column with reachable actions', () => {
    const css = readFileSync(
      new URL('../../app/(authed)/setup/setup.module.css', import.meta.url),
      'utf8',
    );

    expect(css).toContain('width: min(760px, 100%)');
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('grid-template-columns: 1fr');
    expect(css).toContain('position: sticky');
    expect(css).toContain('min-height: 44px');
  });

  it('keeps the UI summary aligned with the server-owned starter blueprint', () => {
    const blueprint = buildStarterBlueprint(1_700_000_000);
    const auto = blueprint.proxyGroups.find((group) => group.name === '自动选择');
    const fallback = blueprint.proxyGroups.find((group) => group.name === '默认');

    expect(blueprint.profile.name).toBe(STARTER_SUMMARY.profileName);
    expect(blueprint.baseContent).not.toMatch(/^(?:mixed-port|port|socks-port):/mu);
    expect(blueprint.baseContent).toContain(`mode: ${STARTER_SUMMARY.mode}`);
    expect(blueprint.baseContent).toContain(`allow-lan: ${STARTER_SUMMARY.allowLan}`);
    expect(blueprint.baseContent).toContain(`log-level: ${STARTER_SUMMARY.logLevel}`);
    expect(auto).toMatchObject({
      name: STARTER_SUMMARY.autoGroup.name,
      type: STARTER_SUMMARY.autoGroup.type,
      'empty-fallback': STARTER_SUMMARY.autoGroup.fallback,
      interval: STARTER_SUMMARY.autoGroup.interval,
    });
    expect(fallback).toMatchObject({
      name: STARTER_SUMMARY.defaultGroup.name,
      type: STARTER_SUMMARY.defaultGroup.type,
      proxies: [...STARTER_SUMMARY.defaultGroup.members],
    });
    expect(blueprint.rules).toContainEqual(
      expect.objectContaining({ type: 'MATCH', policy: STARTER_SUMMARY.defaultGroup.name }),
    );
  });

  it('exposes /setup as the setup wizard route', () => {
    const element = SetupPage();
    expect(element.type).toBe(SetupWizard);
  });
});

describe('setup API type contract consumed by the UI', () => {
  it('accepts only the strict revision and starter version request', () => {
    expect(
      SetupBootstrapRequestSchema.parse({
        expected_revision: 7,
        starter_version: 'starter-v1',
      }),
    ).toEqual({
      expected_revision: 7,
      starter_version: 'starter-v1',
    });
    expect(() =>
      SetupBootstrapRequestSchema.parse({
        expected_revision: 7,
        starter_version: 'starter-v1',
        repair: true,
      }),
    ).toThrow();
  });

  it('accepts the credential-free bootstrap completion receipt', () => {
    const result = SetupBootstrapResponseSchema.parse({
      state: 'configured',
      created: true,
      revision: 8,
      starter_version: 'starter-v1',
      profile: {
        id: '35000000-0000-4000-8000-000000000001',
        name: 'default',
        source: { type: 'none' },
      },
      provenance: {
        starter_version: 'starter-v1',
        expected_revision: 7,
        completed_revision: 8,
        created: true,
        profile_id: '35000000-0000-4000-8000-000000000001',
        base_etag: '0123456789abcdef',
        build_id: 'abcdef12',
        proxy_group_ids: [
          '35000000-0000-4000-8000-000000000002',
          '35000000-0000-4000-8000-000000000003',
        ],
        rule_ids: ['35000000-0000-4000-8000-000000000004'],
        audit_event_id: '35000000-0000-4000-8000-000000000099',
      },
      resources: {
        base_etag: '0123456789abcdef',
        build_id: 'abcdef12',
        proxy_group_ids: [
          '35000000-0000-4000-8000-000000000002',
          '35000000-0000-4000-8000-000000000003',
        ],
        rule_ids: ['35000000-0000-4000-8000-000000000004'],
      },
      readiness: {
        config_renderable: true,
        source: 'unbound',
        distribution_available: true,
      },
    });

    expect(result).toMatchObject({
      state: 'configured',
      provenance: { completed_revision: 8 },
      resources: { build_id: 'abcdef12' },
      readiness: { config_renderable: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/token|url|password/iu);
  });
});
