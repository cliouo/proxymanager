'use client';

import { useState } from 'react';
import { ExternalLink, KeyRound, Network, QrCode } from 'lucide-react';
import { useDashboard } from '@/ui/data/hooks';
import type { Profile } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, CopyButton, Popover } from '@/ui/primitives';
import { QrImage } from '@/ui/shell/share-dialog';
import { deviceLink, guessPlatform, PLATFORM_META, type DeviceLinkVariant, type PatchChip } from './model';

import { SHADOWROCKET_HINT, SubscriptionPurpose } from './subscription-purpose';

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
    url: dashboard.data?.meta?.subscriptionUrl ?? null,
    loading: dashboard.isLoading,
    error: dashboard.error,
    isTemplate,
  };
}

/** QR code for a device link, in a popover. */
export function DeviceShareButton({
  subscriptionUrl,
  name,
  label,
  size = 'sm',
  variant = 'ghost',
  open,
  onOpenChange,
}: {
  subscriptionUrl: string;
  name: string;
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [format, setFormat] = useState<DeviceLinkVariant>('clash');
  const url = deviceLink(subscriptionUrl, name, format);
  return (
    <Popover
      align="end"
      open={open}
      onOpenChange={onOpenChange}
      className="w-[244px] p-3"
      trigger={
        <Button
          variant={variant}
          size={size}
          icon={QrCode}
          aria-label={`复制或扫码 · ${label}`}
          className="relative z-10"
        >复制或扫码</Button>
      }
    >
      <div className="flex flex-col items-center gap-3">
        <SubscriptionPurpose value={format} onChange={setFormat} />
        <QrImage key={url} text={url} size={196} />
        <p className="text-center text-xs leading-relaxed text-ink-3">
          {format === 'shadowrocket' ? SHADOWROCKET_HINT : `用客户端扫码导入 · ${label}`}
        </p>
        <CopyButton text={url} label="复制链接" showLabel />
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
