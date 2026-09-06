import type { BrowserContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
const origin = 'http://127.0.0.1:3127';
export const profiles = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'default',
    source: { type: 'none' },
    kind: 'normal',
    updated_at: 1,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'office',
    source: { type: 'none' },
    kind: 'normal',
    updated_at: 1,
  },
];
export const sub = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'audit-source',
  display_name: '审计模拟订阅',
  kind: 'remote',
  enabled: true,
  tags: [],
  operators: [],
  ttl_ms: 60000,
  url: 'https://example.invalid/sub',
  updated_at: 1,
};
const ruleSets = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'set-a',
    source: 'local',
    format: 'yaml',
    behavior: 'domain',
    content: 'payload:\n  - example.com\n',
    updated_at: 1,
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'set-b',
    source: 'local',
    format: 'yaml',
    behavior: 'domain',
    content: 'payload:\n  - second.example\n',
    updated_at: 1,
  },
];
export const initialBase = 'mixed-port: 7890\nmode: rule\n# @anchor manual\nrules: []\n';
const status = {
  state: 'configured',
  can_bootstrap: false,
  revision: 1,
  starter_version: 'starter-v1',
  reason_codes: [],
  diagnostics: [],
  provenance: null,
  inventory: {
    profiles_total: 2,
    profiles_valid: 2,
    profiles_invalid: 0,
    default_profile_id: profiles[0].id,
    has_base: true,
    base_content_present: true,
    base_meta_present: true,
    proxy_groups_total: 2,
    proxy_groups_invalid: 0,
    rules_total: 501,
    rules_invalid: 0,
    source_type: 'none',
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
};

export async function mockWorkspace(context: BrowserContext) {
  const localProfiles = structuredClone(profiles);
  const requests: {
    path: string;
    query: string;
    method: string;
    scope: string | null;
    body: string | null;
  }[] = [];
  const bases: Record<string, string> = Object.fromEntries(
    profiles.map((p) => [p.id, initialBase]),
  );
  const controls = { delaySave: 0, failPreview: 0, failProfiles: false, ruleCount: 1001 };
  await context.addInitScript(() =>
    sessionStorage.setItem('proxymanager.admin_key', 'synthetic-test-key'),
  );
  await context.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const scope = url.searchParams.get('profileId');
    requests.push({ path, method, scope, query: url.search, body: req.postData() });
    const ok = (data: unknown) => route.fulfill({ json: data });
    if (path === '/api/v1/setup/status') return ok({ data: status });
    if (path === '/api/v1/profiles') {
      await new Promise((r) => setTimeout(r, 80));
      return controls.failProfiles
        ? route.fulfill({ status: 503, json: { title: 'Profile read unavailable' } })
        : ok({ data: localProfiles });
    }
    if (path === '/api/v1/meta')
      return ok({
        data: {
          capabilities: { profileIdScope: true },
          subBase: origin + '/api/sub/synthetic-token',
          subscriptionUrl: origin + '/api/sub/synthetic-token/default',
          hasBase: true,
          buildId: 'test-build',
        },
      });
    if (path === '/api/v1/base') {
      if (!scope)
        return route.fulfill({
          status: 400,
          json: { title: 'Explicit profileId required in browser tests' },
        });
      if (method === 'PUT') {
        await new Promise((r) => setTimeout(r, controls.delaySave));
        bases[scope] = req.postDataJSON().content;
      }
      return ok({
        data: {
          content: bases[scope],
          etag: method === 'PUT' ? 'saved-etag' : 'same-etag',
          anchors: ['manual'],
          policies: ['DIRECT', 'REJECT'],
          updated_at: 1,
        },
      });
    }
    if (path.endsWith('/usage'))
      return ok({
        data: {
          profiles: [{ id: profiles[0].id, name: 'default' }],
          collections: [{ id: 'collection-test', name: 'combined' }],
        },
      });
    if (path === '/api/v1/anchors') return ok({ data: ['manual'] });
    if (path === '/api/v1/policies') return ok({ data: ['DIRECT', 'REJECT'] });
    if (path === '/api/v1/rule-sets') return ok({ data: ruleSets });
    if (path.startsWith('/api/v1/rule-sets/'))
      return ok({ data: ruleSets.find((s) => path.endsWith(s.id)) });
    if (path === '/api/v1/subscriptions') return ok({ data: [sub] });
    if (path.startsWith('/api/v1/subscriptions/')) return ok({ data: sub });
    if (path === '/api/v1/rules/summary')
      return ok({
        data: {
          total: controls.ruleCount,
          active: controls.ruleCount,
          disabled: 0,
          policies: { DIRECT: controls.ruleCount },
          ruleSets: {},
          anchors: { manual: { total: controls.ruleCount, active: controls.ruleCount } },
        },
      });
    if (path === '/api/v1/rules' && method === 'GET') {
      const all = Array.from({ length: controls.ruleCount }, (_, i) => ({
        id: `rule-${i}`,
        anchor: 'manual',
        type: 'DOMAIN-SUFFIX',
        value: `domain-${i}.example`,
        policy: 'DIRECT',
        rank: i * 10,
        source: 'manual',
        added_at: 1,
        updated_at: 1,
      }));
      const filtered = all.filter(
        (r) => !url.searchParams.get('q') || r.value.includes(url.searchParams.get('q')!),
      );
      const offset = Number(url.searchParams.get('offset') || 0),
        limit = Number(url.searchParams.get('limit') || 100);
      return ok({
        data: filtered.slice(offset, offset + limit),
        meta: { total: filtered.length, offset, limit, configVersion: 7 },
      });
    }
    if (path.startsWith('/api/v1/preview/'))
      return controls.failPreview
        ? route.fulfill({ status: controls.failPreview, json: { title: 'Latest preview failed' } })
        : ok({
            data: {
              content: initialBase,
              build_id: 'test-build',
              anchors_applied: [],
              unmatched_anchors: [],
            },
          });
    if (path.endsWith('/devices')) return ok({ data: [], meta: { total: 0 } });
    if (path.startsWith('/api/v1/profiles/')) {
      const profile = localProfiles.find((p) => path.endsWith(p.id));
      if (profile && method === 'PATCH') Object.assign(profile, req.postDataJSON());
      return ok({ data: profile });
    }
    if (path === '/api/v1/assistant/config') return ok({ data: { mode: 'disabled' } });
    return ok({ data: [], meta: { total: 0, configVersion: 7 } });
  });
  return { requests, bases, controls, localProfiles };
}
export async function openBase(page: Page) {
  await page.goto('/base');
  await expect(page.locator('.cm-content')).toContainText('mixed-port');
}
