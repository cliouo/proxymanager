'use client';

import { useState } from 'react';
import { ExternalLink, KeyRound, Network, QrCode } from 'lucide-react';
import { useDashboard } from '@/ui/data/hooks';
import type { Profile } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Popover, SegmentedControl } from '@/ui/primitives';
import { QrImage } from '@/ui/shell/share-dialog';
import { deviceLink, guessPlatform, PLATFORM_META, type PatchChip } from './model';

/* ─── glyph ──────────────────────────────────────────────────────────── */

/** The device's "hardware": a tile with a platform icon guessed from its names. */
export function DeviceGlyph({
  name,
  displayName,
  size = 40,
  className,
}: {
  name: string;
  displayName?: string | null;
  size?: number;
  className?: string;
}) {
  const platform = guessPlatform(displayName, name);
  const { icon: Icon, label } = PLATFORM_META[platform];
  return (
    <span
      title={label}
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-[30%] border border-line-strong/70 bg-gradient-to-b from-surface to-surface-2 text-ink-2 shadow-sm',
        className,
      )}
    >
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.6} />
    </span>
  );
}

/* ─── stickers ───────────────────────────────────────────────────────── */

/** One difference, styled as a small sticker sitting on the shared base. */
export function PatchSticker({ chip, className }: { chip: PatchChip; className?: string }) {
  return (
    <span
      title={chip.key}
      className={cn(
        'inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border bg-surface px-2 text-xs shadow-sm',
        chip.tone === 'remove' ? 'border-bad/25 text-bad' : 'border-line text-ink-2',
        className,
      )}
    >
      {chip.tone === 'secret' && <KeyRound size={11} strokeWidth={2} className="shrink-0 text-ink-3" />}
      <span className={cn('truncate', chip.tone === 'remove' && 'line-through decoration-bad/50')}>{chip.label}</span>
      {chip.value && (
        <span
          className={cn(
            'shrink-0 font-mono text-[11px]',
            chip.tone === 'remove' ? 'text-bad' : chip.tone === 'secret' ? 'text-ink-3' : 'text-ink',
          )}
        >
          {chip.value}
        </span>
      )}
    </span>
  );
}

/**
 * `hostname` is the original slot; `extra` counts additional instances, so a
 * device with two extras reads "Tailscale +2".
 */
export function TailscaleBadge({ hostname, extra = 0 }: { hostname?: string; extra?: number }) {
  const title = hostname
    ? `Tailscale · ${hostname}${extra > 0 ? ` + ${extra} 个附加实例` : ''}`
    : `Tailscale${extra > 0 ? ` · ${extra} 个附加实例` : ''}`;
  return (
    <Badge tone="accent" icon={Network} title={title}>
      Tailscale{extra > 0 ? ` +${extra}` : ''}
    </Badge>
  );
}

/* ─── links ──────────────────────────────────────────────────────────── */

/** The profile's scoped subscription URL (dashboard meta). Templates are never distributed. */
export function useSubscriptionUrl(profile: Profile) {
  const isTemplate = profile.kind === 'template';
  const dashboard = useDashboard(isTemplate ? null : profile.id);
  return {
    url: dashboard.data?.meta.subscriptionUrl ?? null,
    loading: dashboard.isLoading,
    error: dashboard.error,
    isTemplate,
  };
}

/** QR code for a device link, in a popover. */
export function QrButton({
  subscriptionUrl,
  name,
  label,
  size = 'sm',
  variant = 'ghost',
}: {
  subscriptionUrl: string;
  name: string;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
}) {
  const [format, setFormat] = useState<'clash' | 'base64'>('clash');
  const url = deviceLink(subscriptionUrl, name, format);
  return (
    <Popover
      align="end"
      className="w-[244px] p-3"
      trigger={
        <Button
          variant={variant}
          size={size}
          iconOnly
          icon={QrCode}
          title="订阅二维码"
          aria-label={`显示「${label}」的订阅二维码`}
          className="relative z-10"
        />
      }
    >
      <div className="flex flex-col items-center gap-3">
        <SegmentedControl
          size="sm"
          stretch
          value={format}
          onChange={setFormat}
          options={[
            { value: 'clash', label: 'Clash 配置' },
            { value: 'base64', label: '仅节点' },
          ]}
        />
        <QrImage text={url} size={196} />
        <p className="text-center text-xs leading-relaxed text-ink-3">
          用客户端扫码导入 · <span className="text-ink-2">{label}</span>
        </p>
        {format === 'clash' && (
          <a
            href={`clash://install-config?url=${encodeURIComponent(url)}&name=${encodeURIComponent(label)}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink-2 shadow-xs hover:border-line-strong hover:text-ink"
          >
            <ExternalLink size={12} /> 在 Clash 客户端中打开
          </a>
        )}
      </div>
    </Popover>
  );
}
