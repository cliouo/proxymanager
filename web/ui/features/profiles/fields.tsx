'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AlertTriangle, Info, Layers, LayoutTemplate, Unplug, RadioTower, Boxes } from 'lucide-react';
import { TEMPLATE_TAGLINE } from '@/lib/profiles/kind';
import { usePools, useSources } from '@/ui/data/hooks';
import type { ProfileKind } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Field, SegmentedControl, Select, Skeleton } from '@/ui/primitives';
import type { SourceDraft, SourceMode } from './model';

/* ─── callout ────────────────────────────────────────────────────────── */

export function Callout({
  tone = 'info',
  children,
  className,
}: {
  tone?: 'info' | 'warn';
  children: ReactNode;
  className?: string;
}) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
        tone === 'warn' ? 'border-warn/25 bg-warn-soft/70 text-ink-2' : 'border-line bg-surface-2/70 text-ink-2',
        className,
      )}
    >
      <Icon size={13} className={cn('mt-0.5 shrink-0', tone === 'warn' ? 'text-warn' : 'text-ink-3')} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/* ─── node source ────────────────────────────────────────────────────── */

const SOURCE_HINT: Record<SourceMode, string> = {
  none: '不注入订阅节点。策略组只能用直连、拦截或基础配置里手写的节点。',
  subscription: '只用这一个订阅源的节点。',
  collection: '合并聚合订阅里所有订阅源的节点。想同时用多个机场，就绑定聚合订阅。',
};

export function SourceField({
  value,
  onChange,
  showError,
}: {
  value: SourceDraft;
  onChange: (next: SourceDraft) => void;
  /** Show "pick one" once the user tried to submit. */
  showError?: boolean;
}) {
  const sources = useSources();
  const pools = usePools();
  const missing = value.mode !== 'none' && !value.id;

  const list =
    value.mode === 'subscription'
      ? (sources.data ?? []).map((s) => ({
          value: s.id,
          label: s.display_name || s.name,
          description: `${s.name} · ${!s.enabled ? '已停用' : s.kind === 'local' ? '本地节点' : '远程订阅'}`,
        }))
      : (pools.data ?? []).map((p) => ({
          value: p.id,
          label: p.name,
          description: `${p.slug ?? p.id.slice(0, 8)} · ${p.subscription_ids.length} 个订阅源${
            p.subscription_tags.length ? ` + ${p.subscription_tags.length} 个标签` : ''
          }`,
        }));
  const loading = value.mode === 'subscription' ? sources.isLoading : pools.isLoading;

  return (
    <Field
      label="节点来源"
      error={showError && missing ? (value.mode === 'subscription' ? '请选择一个订阅源' : '请选择一个聚合订阅') : undefined}
      hint={SOURCE_HINT[value.mode]}
    >
      {(id) => (
        <div className="flex flex-col gap-2">
          <SegmentedControl<SourceMode>
            stretch
            value={value.mode}
            onChange={(mode) => onChange({ mode, id: mode === value.mode ? value.id : null })}
            options={[
              { value: 'none', label: '不绑定', icon: Unplug },
              { value: 'subscription', label: '订阅源', icon: RadioTower },
              { value: 'collection', label: '聚合订阅', icon: Boxes },
            ]}
          />
          {value.mode !== 'none' &&
            (loading ? (
              <Skeleton className="h-8 rounded-md" />
            ) : list.length === 0 ? (
              <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-line-strong px-3 py-2 text-xs text-ink-3">
                {value.mode === 'subscription' ? '还没有订阅源' : '还没有聚合订阅'}
                <Link href={value.mode === 'subscription' ? '/sources?new=1' : '/sources'} className="font-medium text-accent hover:underline">
                  {value.mode === 'subscription' ? '去添加' : '去创建'}
                </Link>
              </div>
            ) : (
              <Select
                id={id}
                value={value.id ?? undefined}
                onValueChange={(next) => onChange({ mode: value.mode, id: next })}
                placeholder={value.mode === 'subscription' ? '选择一个订阅源' : '选择一个聚合订阅'}
                invalid={showError && missing}
                options={list}
              />
            ))}
        </div>
      )}
    </Field>
  );
}

/* ─── kind ───────────────────────────────────────────────────────────── */

export function KindField({
  value,
  onChange,
  initial,
}: {
  value: ProfileKind;
  onChange: (next: ProfileKind) => void;
  /** Current stored kind when editing — consequences are spelled out on change. */
  initial?: ProfileKind;
}) {
  return (
    <Field label="类型">
      {() => (
        <div className="flex flex-col gap-2">
          <SegmentedControl<ProfileKind>
            stretch
            value={value}
            onChange={onChange}
            options={[
              { value: 'normal', label: '配置文件', icon: Layers },
              { value: 'template', label: '模版', icon: LayoutTemplate },
            ]}
          />
          <p className="text-xs leading-relaxed text-ink-3">
            {value === 'template'
              ? '模版不对外分发，订阅链接会返回 404。新建配置文件时可以从它拷贝一份。'
              : '拥有自己的订阅链接，可以分发给客户端和设备。'}
            <span className="mt-0.5 block text-ink-4">{TEMPLATE_TAGLINE}</span>
          </p>
          {initial === 'normal' && value === 'template' && (
            <Callout tone="warn">转为模版后，这份配置的订阅链接和所有设备链接会立即失效。内容本身不会变。</Callout>
          )}
          {initial === 'template' && value === 'normal' && (
            <Callout>转为普通配置文件后，它会获得可以分发的订阅链接。内容本身不会变。</Callout>
          )}
        </div>
      )}
    </Field>
  );
}
