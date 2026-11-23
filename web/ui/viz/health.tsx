'use client';

import { motion } from 'motion/react';
import type { SubscriptionAdminView, SubscriptionFetchHealth, SubscriptionTraffic } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { daysUntil, formatBytes, formatDate, relativeTime } from '@/ui/lib/format';
import { StatusDot, type Tone } from '@/ui/primitives';

export const FAILURE_LABEL: Record<string, string> = {
  network: '网络错误',
  timeout: '请求超时',
  http: 'HTTP 错误',
  'response-encoding': '响应编码异常',
  'response-content-format': '内容格式无法识别',
  'proxy-node': '节点解析失败',
};

/** What the server did with the cache when a fetch failed and nothing was served. */
export const DISPOSITION_COPY: Record<string, string> = {
  unavailable: '没有找到可用的缓存，这个源暂时没有节点。',
  invalid: '找到的缓存未通过校验，已拒绝使用。',
  'policy-blocked': '该源设为「失败时阻断」，按策略不使用缓存。',
  bypassed: '这次是强制刷新，按要求绕过了缓存。',
};

export interface HealthView {
  tone: 'ok' | 'warn' | 'bad' | 'idle' | 'accent';
  badge: Tone;
  label: string;
  detail: string;
}

export function sourceHealth(source: Pick<SubscriptionAdminView, 'kind' | 'enabled' | 'fetch_health' | 'refresh_mode' | 'manual_snapshot'>): HealthView {
  if (!source.enabled) return { tone: 'idle', badge: 'neutral', label: '已停用', detail: '停用的源不会被拉取，也不会提供节点。' };
  if (source.kind === 'local') return { tone: 'ok', badge: 'neutral', label: '本地', detail: '节点内容保存在本平台，无需拉取。' };
  if (source.refresh_mode === 'manual') {
    const snap = source.manual_snapshot;
    if (!snap) return { tone: 'bad', badge: 'bad', label: '待导入', detail: '手动维护的源还没有导入内容。' };
    return {
      tone: snap.source_changed ? 'warn' : 'ok',
      badge: snap.source_changed ? 'warn' : 'accent',
      label: '手动维护',
      detail: `${relativeTime(snap.updated_at)}通过${snap.origin === 'extension' ? '浏览器扩展' : '网页'}导入 · ${snap.proxy_count} 个节点${snap.source_changed ? ' · 订阅地址已变更，建议重新导入' : ''}`,
    };
  }
  return fetchHealthView(source.fetch_health ?? null);
}

export function fetchHealthView(health: SubscriptionFetchHealth | null): HealthView {
  if (!health) return { tone: 'idle', badge: 'neutral', label: '未拉取', detail: '还没有拉取记录，首次使用时会自动拉取。' };
  if (health.state === 'fresh') {
    return {
      tone: 'ok',
      badge: 'ok',
      label: '正常',
      detail: `${relativeTime(health.fresh_at)}拉取成功 · ${health.proxy_count} 个节点`,
    };
  }
  if (health.state === 'stale-served') {
    return {
      tone: 'warn',
      badge: 'warn',
      label: '使用缓存',
      detail: `最近一次拉取失败（${FAILURE_LABEL[health.failure_category] ?? health.failure_category}），正在使用${relativeTime(health.fresh_at)}的缓存。`,
    };
  }
  return {
    tone: 'bad',
    badge: 'bad',
    label: '拉取失败',
    detail: `${FAILURE_LABEL[health.failure_category] ?? '拉取失败'}：${DISPOSITION_COPY[health.cache_disposition] ?? '没有可用的节点。'}`,
  };
}

export function HealthPill({ view, className }: { view: HealthView; className?: string }) {
  return (
    <span
      title={view.detail}
      className={cn(
        'inline-flex h-5 items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[11px] font-medium text-ink-2',
        className,
      )}
    >
      <StatusDot tone={view.tone} size={6} pulse={view.tone === 'bad'} />
      {view.label}
    </span>
  );
}

export function trafficOf(health: SubscriptionFetchHealth | null | undefined): SubscriptionTraffic | null {
  if (!health || health.state === 'failed-no-cache') return null;
  return health.traffic ?? null;
}

/** Used / total bar with expiry, for airport subscriptions that report usage. */
export function TrafficMeter({
  traffic,
  className,
  compact,
}: {
  traffic: SubscriptionTraffic;
  className?: string;
  compact?: boolean;
}) {
  const used = traffic.upload + traffic.download;
  const unlimited = traffic.total <= 0;
  const showBar = !unlimited && traffic.remaining === undefined && !traffic.expiry_only;
  const ratio = showBar ? Math.min(1, used / traffic.total) : 0;
  const days = traffic.expire > 0 ? daysUntil(traffic.expire) : null;
  const barColor = ratio > 0.9 ? 'var(--bad)' : ratio > 0.75 ? 'var(--warn)' : 'var(--ink)';
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        {!traffic.expiry_only && (
          <span className="tnum text-ink-2">
            <span className="font-medium text-ink">{formatBytes(traffic.remaining ?? used)}</span>
            {traffic.remaining !== undefined ? (
              <span className="text-ink-3"> 剩余</span>
            ) : !unlimited ? (
              <span className="text-ink-3"> / {formatBytes(traffic.total)}</span>
            ) : (
              <span className="text-ink-3">{traffic.total_unknown ? ' 已用' : ' 已用 · 不限量'}</span>
            )}
          </span>
        )}
        {days !== null && (
          <span
            className={cn('tnum shrink-0', days < 0 ? 'text-bad' : days <= 7 ? 'text-warn' : 'text-ink-3')}
            title={`到期：${formatDate(traffic.expire)}`}
          >
            {days < 0 ? '已过期' : days === 0 ? '今天到期' : `剩 ${days} 天`}
          </span>
        )}
      </div>
      {showBar && (
        <div className={cn('relative overflow-hidden rounded-full bg-surface-3', compact ? 'h-1' : 'h-1.5')}>
          <motion.div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ background: barColor }}
            initial={{ width: 0 }}
            animate={{ width: `${Math.max(ratio * 100, 1.5)}%` }}
            transition={{ type: 'spring', bounce: 0, duration: 0.9 }}
          />
        </div>
      )}
    </div>
  );
}
