export type ReadinessTone = 'ok' | 'warn' | 'idle';

export interface DashboardReadinessInput {
  hasBase: boolean;
  sourceType: 'none' | 'subscription' | 'collection' | null;
  hasSnapshot: boolean;
  snapshotError: boolean;
  warningCount: number;
  starterProvenance?: boolean;
}

export interface DashboardReadiness {
  tone: ReadinessTone;
  label: string;
  supportingLabel: string | null;
  detail: string;
  actionHref: '/setup' | '/subscriptions' | '/config';
  actionLabel: string;
}

export function deriveDashboardReadiness(input: DashboardReadinessInput): DashboardReadiness {
  if (!input.hasBase) {
    return {
      tone: 'warn',
      label: '尚未完成首次设置',
      supportingLabel: null,
      detail: '先创建可渲染的基础配置，再继续绑定节点和分发。',
      actionHref: '/setup',
      actionLabel: '开始首次设置',
    };
  }

  if (input.snapshotError) {
    return {
      tone: 'warn',
      label: '基础配置已就绪',
      supportingLabel: '渲染状态读取失败',
      detail: '无法读取最近一次渲染摘要，这不代表配置本身有问题。',
      actionHref: '/config',
      actionLabel: '检查配置',
    };
  }

  if (!input.hasSnapshot) {
    return {
      tone: 'idle',
      label: '基础配置已就绪',
      supportingLabel: '尚未生成渲染记录',
      detail: '打开配置预览可执行一次新鲜渲染并生成状态摘要。',
      actionHref: '/config',
      actionLabel: '生成配置预览',
    };
  }

  if (input.warningCount > 0) {
    return {
      tone: 'warn',
      label: '最近一次渲染需检查',
      supportingLabel: `${input.warningCount} 项提示`,
      detail: '基础配置存在，但最近一次渲染记录包含告警或未匹配项。',
      actionHref: '/config',
      actionLabel: '查看渲染结果',
    };
  }

  if (input.sourceType === 'none') {
    return input.starterProvenance
      ? {
          tone: 'warn',
          label: 'starter 已就绪',
          supportingLabel: '未绑定节点来源',
          detail: '精确 starter 记录与最近一次成功渲染均已确认，当前没有代理节点。',
          actionHref: '/subscriptions',
          actionLabel: '添加节点订阅',
        }
      : {
          tone: 'warn',
          label: '最近一次渲染正常',
          supportingLabel: '未绑定节点来源',
          detail: '基础配置存在且有成功渲染记录，但没有证据表明它来自首次部署 starter。',
          actionHref: '/subscriptions',
          actionLabel: '添加节点订阅',
        };
  }

  return {
    tone: 'ok',
    label: '最近一次渲染正常',
    supportingLabel: null,
    detail: '状态来自最近一次成功渲染的只读摘要。',
    actionHref: '/config',
    actionLabel: '查看渲染结果',
  };
}
