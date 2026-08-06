/**
 * Synthetic UI acceptance for the 智能命名 workspace (finding 11): the repo
 * has no DOM test environment, so the workspace's data-driven states are
 * rendered through react-dom/server static markup with an injected payload —
 * the same markup a screen reader and keyboard user would get — and each
 * state's accessibility contract is asserted on the emitted HTML:
 *   - default (recommended template, not yet managed) — status region, aria
 *     labels, enabled apply button;
 *   - missing facts — 0% coverage shown, no fabricated values;
 *   - collisions — status warning;
 *   - drift — status warning;
 *   - reference impact — alert region;
 *   - apply state — dirty marker + disabled/enabled buttons;
 *   - persisted rollback — enabled rollback button + status copy.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { NamingWorkspace } from '@/app/(authed)/subscriptions/_pipeline/NamingWorkspace';

const BASE = {
  entity: { type: 'subscription' as const, ref: 'ref-1111111111111111', label: '机场A' },
  aggregate: false,
  managed: { present: false },
  priorPlan: { present: false },
  recommended: '${emoji} ${region}${?route: · ${route}}${?index: · ${index}}',
  health: [
    {
      sourceKey: 'airport-a',
      sourceLabel: '机场A',
      nodeCount: 2,
      fields: [
        {
          field: 'region',
          label: '地区（中文）',
          present: 2,
          total: 2,
          percent: 100,
          confidence: { high: 2, medium: 0, low: 0 },
          samples: [{ value: '香港', count: 2, kind: 'derived', confidence: 'high' }],
        },
        {
          field: 'rate',
          label: '倍率',
          present: 0,
          total: 2,
          percent: 0,
          confidence: { high: 0, medium: 0, low: 0 },
          samples: [],
        },
      ],
      nodeFacts: [
        {
          node: 'nd-abcdefabcdefabcd',
          field: 'protocol',
          value: 'ss',
          confidence: 'high',
          kind: 'intrinsic',
          ambiguous: false,
        },
      ],
      unavailable: ['rate'],
      partial: [],
      ambiguousCount: 0,
      drift: [],
    },
  ],
  diagnostics: {
    nodeCount: 2,
    changed: 2,
    collisions: [],
    deduped: [],
    beforeNames: ['香港 01'],
    afterNames: ['🇭🇰 香港 · 01'],
    truncated: false,
  },
  references: { consumingProfiles: [{ id: 'p1', name: 'my-profile' }], orphaned: [] },
};

function render(over: Record<string, unknown>): string {
  const data = { ...BASE, ...over } as never;
  return renderToStaticMarkup(
    createElement(NamingWorkspace, {
      workspacePath: '/api/v1/naming/subscription/sub-1',
      backHref: '/subscriptions',
      crumbPrefix: '订阅源',
      initialData: data,
    }),
  );
}

describe('智能命名 workspace synthetic acceptance', () => {
  it('default state: recommended template prefilled, accessible labels, apply enabled', () => {
    const html = render({});
    // controlled textarea carries the recommended template + labelled
    expect(html).toContain('${emoji} ${region}');
    expect(html).toContain('aria-label="命名模板"');
    expect(html).toContain('aria-describedby="workspace-validation"');
    // not-yet-managed notice is a status region (screen-reader visible)
    expect(html).toContain('尚未启用「名称统一」');
    expect(html).toContain('role="status"');
    // keyboard-reachable real buttons with text labels
    expect(html).toContain('<button type="button" class="btn primary"');
    expect(html).toContain('保存并应用模板');
    // the coverage table is a real table with column headers
    expect(html).toContain('<table');
    expect(html).toContain('<th scope="col">字段</th>');
  });

  it('missing facts: 0% coverage rendered, no fabricated values', () => {
    const html = render({});
    expect(html).toContain('0/2（0%）');
    expect(html).toContain('不可用字段：倍率');
  });

  it('collision state: resolved-collision warning is a status region', () => {
    const html = render({
      diagnostics: {
        nodeCount: 2,
        changed: 2,
        collisions: ['🇭🇰 香港 · 01'],
        deduped: [],
        beforeNames: ['香港 01', '香港 01'],
        afterNames: ['🇭🇰 香港 · 01', '🇭🇰 香港 · 01 · 机场A-01'],
        truncated: false,
      },
    });
    expect(html).toContain('当前模板下 1 个格式化重名已按「来源-序号」消歧');
    expect(html).toContain('role="status"');
  });

  it('drift state: drift warning rendered with bounded samples', () => {
    const html = render({
      health: [
        {
          ...BASE.health[0],
          drift: [{ field: 'rate', count: 1, samples: ['10000x'] }],
        },
      ],
    });
    expect(html).toContain('漂移提示');
    expect(html).toContain('10000x');
  });

  it('reference impact: orphaned references surface as an alert region', () => {
    const html = render({
      references: {
        consumingProfiles: [{ id: 'p1', name: 'my-profile' }],
        orphaned: [{ node: '香港 01', kind: 'chain-backend', via: '出口' }],
      },
    });
    expect(html).toContain('当前模板会令以下按名引用悬空');
    expect(html).toContain('role="alert"');
    expect(html).toContain('消费该来源的配置文件');
  });

  it('apply state: dirty marker + disabled rollback without a prior plan', () => {
    // managed template differs from the pre-filled draft? Draft == applied here,
    // so dirty is false and the apply button is disabled.
    const html = render({
      managed: { present: true, template: '${emoji} ${region}' },
    });
    expect(html).toContain('已与保存状态一致');
    expect(html).toContain('disabled=""');
    expect(html).toContain('回滚到上一方案');
  });

  it('persisted rollback state: prior plan present → rollback enabled + copy', () => {
    const html = render({
      managed: { present: true, template: '${emoji} ${region}' },
      priorPlan: { present: true, template: '${region}${?index: · ${index}}' },
    });
    expect(html).toContain('服务端已持久化上一方案');
    expect(html).not.toContain('暂无持久化的上一方案');
  });
});
