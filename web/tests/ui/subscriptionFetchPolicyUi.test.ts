/**
 * P-FFP v2 UI contract: the failed-no-cache disposition copy is owned by ONE
 * pure formatter and an exact four-row table (web/lib/ui/
 * subscriptionFetchHealthCopy.ts), consumed by both authed pages. The
 * disposition oracle here is DIRECT — the table and formatter are imported
 * and asserted value-by-value — never a circular source grep. Independent
 * form-label, strict-badge, and alert-structure checks remain source-level
 * (App Router pages cannot be re-exported for rendering).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SUBSCRIPTION_FETCH_FAILURE_DISPOSITION_COPY,
  SUBSCRIPTION_FETCH_FAILURE_GENERIC_COPY,
  describeFailedDisposition,
} from '@/lib/ui/subscriptionFetchHealthCopy';

const pageSource = readFileSync(
  new URL('../../app/(authed)/subscriptions/page.tsx', import.meta.url),
  'utf8',
);
const dashboardSource = readFileSync(
  new URL('../../app/(authed)/page.tsx', import.meta.url),
  'utf8',
);

describe('subscriptionFetchHealthCopy — exact I15 four-row table', () => {
  it('owns the exact four disposition sentences', () => {
    expect(SUBSCRIPTION_FETCH_FAILURE_DISPOSITION_COPY).toEqual({
      unavailable: '未找到可用缓存，本次未下发缓存',
      invalid: '缓存校验未通过，本次未下发缓存',
      'policy-blocked': '失败策略阻止使用现有缓存，本次未下发缓存',
      bypassed: '本次为强制刷新，未读取或下发缓存',
    });
  });

  it('maps each disposition value one-to-one and uses the generic fallback otherwise', () => {
    expect(describeFailedDisposition('unavailable')).toBe('未找到可用缓存，本次未下发缓存');
    expect(describeFailedDisposition('invalid')).toBe('缓存校验未通过，本次未下发缓存');
    expect(describeFailedDisposition('policy-blocked')).toBe(
      '失败策略阻止使用现有缓存，本次未下发缓存',
    );
    expect(describeFailedDisposition('bypassed')).toBe('本次为强制刷新，未读取或下发缓存');
    // Absent and malformed (e.g. 'served' on a failed-no-cache) values use
    // ONLY the generic fallback.
    expect(describeFailedDisposition(undefined)).toBe(SUBSCRIPTION_FETCH_FAILURE_GENERIC_COPY);
    expect(describeFailedDisposition('served')).toBe(SUBSCRIPTION_FETCH_FAILURE_GENERIC_COPY);
  });

  it('only unavailable says no cache was found; only invalid says validation failed; policy-blocked and bypassed never imply an unusable cache', () => {
    const copy = SUBSCRIPTION_FETCH_FAILURE_DISPOSITION_COPY;
    expect(copy.unavailable).toContain('未找到可用缓存');
    expect(copy.invalid).toContain('校验未通过');
    expect(copy['policy-blocked']).toContain('阻止使用现有缓存');
    expect(copy['policy-blocked']).not.toContain('未找到');
    expect(copy['policy-blocked']).not.toContain('未通过');
    expect(copy.bypassed).toContain('未读取或下发缓存');
    expect(copy.bypassed).not.toContain('未找到');
    expect(copy.bypassed).not.toContain('未通过');
    // Every sentence states no cache was served: three say 未下发缓存
    // outright; bypassed says the cache was not read or served.
    for (const key of ['unavailable', 'invalid', 'policy-blocked'] as const) {
      expect(copy[key]).toContain('未下发缓存');
    }
  });
});

describe('subscription page — shared formatter, exact labels, strict-only badge', () => {
  it('consumes the shared formatter and no longer carries page-local disposition copy', () => {
    expect(pageSource).toContain("from '@/lib/ui/subscriptionFetchHealthCopy'");
    // The retired page-local helper strings must not diverge anywhere.
    expect(pageSource).not.toContain('已设置失败阻断，未使用缓存');
    expect(pageSource).not.toContain('缓存已损坏，未使用');
    expect(pageSource).not.toContain('无可用缓存');
  });

  it('remote Add/Edit forms expose the exact labels 沿用缓存（默认） and 阻断聚合', () => {
    expect(pageSource).toContain('沿用缓存（默认）');
    expect(pageSource).toContain('阻断聚合');
  });

  it('the 失败时阻断 badge is conditional on fail-closed (strict) only', () => {
    expect(pageSource).toContain('失败时阻断');
    expect(pageSource).toMatch(/fetch_failure_policy\s*===\s*['"]fail-closed['"]/);
  });

  it('failed-no-cache never repeats the old false cache-serving claim', () => {
    expect(pageSource).not.toContain('以上次缓存对外下发');
    expect(pageSource).toMatch(/failed-no-cache/);
    expect(pageSource).toMatch(/沿用上次缓存/);
  });

  it('retired runtime row fields are gone from the UI (fetch_health replaces them)', () => {
    expect(pageSource).not.toContain('last_error');
    expect(pageSource).not.toContain('last_synced_at');
    expect(pageSource).not.toContain('last_traffic');
    expect(pageSource).toContain('fetch_health');
  });
});

describe('dashboard page — shared formatter, health-driven alerts, structural warnings remain', () => {
  it('consumes the shared formatter for failed-no-cache alerts', () => {
    expect(dashboardSource).toContain("from '@/lib/ui/subscriptionFetchHealthCopy'");
    expect(dashboardSource).toContain('describeFailedDisposition');
    // The retired global false claim is gone.
    expect(dashboardSource).not.toContain('且没有可用缓存下发');
  });

  it('buildAlerts reads fetch_health and maps stale-served to warning, failed-no-cache to error', () => {
    expect(dashboardSource).toContain('fetch_health');
    expect(dashboardSource).toContain("state === 'stale-served'");
    expect(dashboardSource).toContain("state === 'failed-no-cache'");
    expect(dashboardSource).toMatch(/tag: '沿用缓存'/);
    expect(dashboardSource).toMatch(/tag: '拉取失败'/);
  });

  it('the snapshot-driven fetch alert loop is retired; structural warnings are still surfaced', () => {
    expect(dashboardSource).not.toContain('snapshot?.subscriptions?.filter');
    expect(dashboardSource).not.toContain('item.error || item.stale');
    expect(dashboardSource).toContain('snapshot?.warnings');
    expect(dashboardSource).toContain('unmatchedAnchors');
  });
});
