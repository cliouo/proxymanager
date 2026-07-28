import { describe, expect, it } from 'vitest';
import { deriveDashboardReadiness } from '@/lib/client/readiness';

describe('dashboard readiness', () => {
  it('does not call a base-only instance render healthy', () => {
    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'subscription',
        hasSnapshot: false,
        snapshotError: false,
        warningCount: 0,
      }),
    ).toMatchObject({
      label: '基础配置已就绪',
      supportingLabel: '尚未生成渲染记录',
      actionHref: '/config',
    });
  });

  it('checks missing render evidence before considering an unbound source', () => {
    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'none',
        hasSnapshot: false,
        snapshotError: false,
        warningCount: 0,
      }),
    ).toMatchObject({
      label: '基础配置已就绪',
      supportingLabel: '尚未生成渲染记录',
      actionHref: '/config',
    });
  });

  it('checks snapshot read failure before source:none and never infers starter', () => {
    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'none',
        hasSnapshot: false,
        snapshotError: true,
        warningCount: 0,
      }),
    ).toMatchObject({
      label: '基础配置已就绪',
      supportingLabel: '渲染状态读取失败',
      actionHref: '/config',
    });
  });

  it('states only known facts for an unbound rendered config without provenance', () => {
    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'none',
        hasSnapshot: true,
        snapshotError: false,
        warningCount: 0,
        starterProvenance: false,
      }),
    ).toMatchObject({
      label: '最近一次渲染正常',
      supportingLabel: '未绑定节点来源',
      actionHref: '/subscriptions',
    });
  });

  it('names starter only with exact provenance and successful render evidence', () => {
    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'none',
        hasSnapshot: true,
        snapshotError: false,
        warningCount: 0,
        starterProvenance: true,
      }),
    ).toMatchObject({
      label: 'starter 已就绪',
      supportingLabel: '未绑定节点来源',
      actionHref: '/subscriptions',
    });
  });

  it('requires snapshot evidence before reporting a healthy render', () => {
    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'collection',
        hasSnapshot: true,
        snapshotError: false,
        warningCount: 0,
      }),
    ).toMatchObject({
      tone: 'ok',
      label: '最近一次渲染正常',
    });

    expect(
      deriveDashboardReadiness({
        hasBase: true,
        sourceType: 'collection',
        hasSnapshot: true,
        snapshotError: false,
        warningCount: 2,
      }),
    ).toMatchObject({
      tone: 'warn',
      label: '最近一次渲染需检查',
      supportingLabel: '2 项提示',
    });
  });
});
