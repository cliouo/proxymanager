'use client';

import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { useTheme } from 'next-themes';
import { CircleAlert, ExternalLink, FileCode2, LayoutTemplate, MonitorSmartphone, QrCode, RefreshCw, Share2, Smartphone } from 'lucide-react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { errorMessage } from '@/ui/data/api';
import { useDashboard, useDevices } from '@/ui/data/hooks';
import { cn } from '@/ui/lib/cn';
import { Button, CopyButton, Dialog, Skeleton } from '@/ui/primitives';
import { deviceLink, type DeviceLinkVariant } from '@/ui/features/devices/model';
import { SubscriptionPurpose, SHADOWROCKET_HINT } from '@/ui/features/devices/subscription-purpose';
import { useActiveProfile } from './scope';
import { setUi, useUi } from './state';
import { profileTitle } from './profile-switcher';

export function QrImage({ text, size = 176, className }: { text: string; size?: number; className?: string }) {
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(text, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: resolvedTheme === 'dark' ? '#ededef' : '#18181b', light: '#00000000' },
    }).then((value) => {
      if (!cancelled) setSvg(value);
    });
    return () => {
      cancelled = true;
    };
  }, [text, resolvedTheme]);
  return (
    <div
      className={cn('shrink-0 rounded-xl border border-line bg-surface p-3 shadow-xs [&_svg]:h-full [&_svg]:w-full', className)}
      style={{ width: size, height: size }}
      aria-label="订阅链接二维码"
      role="img"
      // qrcode generates a self-contained, script-free SVG string.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

function withFormat(url: string, variant: 'clash' | 'base64') {
  return variant === 'base64' ? `${url}${url.includes('?') ? '&' : '?'}format=base64` : url;
}

export function LinkRow({ label, url, hint, icon: Icon, active, onShowQr }: {
  label: string;
  url: string;
  hint?: string;
  icon: typeof Smartphone;
  active?: boolean;
  onShowQr?: () => void;
}) {
  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors',
        active ? 'border-accent-line bg-accent-soft/50' : 'border-line bg-surface hover:border-line-strong',
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-ink-2">
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          {label}
          {hint && <span className="text-[11px] font-normal text-ink-3">{hint}</span>}
        </div>
        <div className="truncate font-mono text-[11px] text-ink-3" title={url} data-agent-secret>
          {url}
        </div>
      </div>
      {onShowQr && (
        <UiButton
          onClick={onShowQr}
          aria-label={`显示「${label}」二维码`}
          className={cn(
            'flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink',
            active && 'text-accent',
          )}
        >
          <QrCode size={14} />
        </UiButton>
      )}
      <CopyButton text={url} message={`已复制「${label}」`} />
    </div>
  );
}

export function ShareDialog() {
  const open = useUi((s) => s.shareOpen);
  const profile = useActiveProfile();
  const pid = open ? (profile?.id ?? null) : null;
  const { data: dashboard, isLoading: dashboardLoading } = useDashboard(pid);
  const { data: devices, isLoading: devicesLoading, error: devicesError, refetch: refetchDevices } = useDevices(pid);
  const [variant, setVariant] = useState<DeviceLinkVariant>('clash');
  const [qrKey, setQrKey] = useState<string>('profile');

  const base = dashboard?.meta.subscriptionUrl ?? '';
  const links = useMemo(() => {
    if (!base) return [];
    return [
      ...(variant === 'shadowrocket' ? [] : [{ key: 'profile', label: '共享配置', hint: '所有设备通用', url: withFormat(base, variant), icon: FileCode2 }]),
      ...(variant === 'base64' ? [{ key: 'shadowrocket', label: 'Shadowrocket 分流配置', hint: '先将共享节点订阅备注设为 ProxyManager-Nodes，再从「配置」导入此链接', url: `${base}${base.includes('?') ? '&' : '?'}format=shadowrocket`, icon: FileCode2 }] : []),
      ...(devices ?? []).map((device) => ({
        key: device.id,
        label: device.display_name || device.name,
        hint: `设备 · ${device.name}`,
        url: deviceLink(base, device.name, variant),
        icon: MonitorSmartphone,
      })),
    ];
  }, [base, devices, variant]);

  const qrLink = links.find((l) => l.key === qrKey) ?? links[0];
  const isTemplate = profile?.kind === 'template';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => setUi({ shareOpen: next })}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Share2 size={16} className="text-ink-3" />
          订阅链接{profile ? ` · ${profileTitle(profile)}` : ''}
        </span>
      }
      description="把链接粘贴到 Clash Verge、Mihomo Party、Stash 等客户端，或用手机扫码导入。链接内含访问令牌，请勿公开分享。"
    >
      {isTemplate ? (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 p-4 text-sm text-ink-2">
          <LayoutTemplate size={18} className="mt-0.5 shrink-0 text-ink-3" />
          <div>
            <div className="font-medium text-ink">模版不对外分发</div>
            <p className="mt-1 text-xs leading-relaxed">模版只用来派生新配置文件。请先在「配置文件」页从它新建一份配置，再分发新配置的链接。</p>
          </div>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-[1fr_auto]">
          <div className="flex min-w-0 flex-col gap-3">
            <SubscriptionPurpose value={variant} onChange={setVariant} />
            {dashboardLoading || !base ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {links.map((link) => (
                  <LinkRow
                    key={link.key}
                    label={link.label}
                    hint={link.hint}
                    url={link.url}
                    icon={link.icon}
                    active={qrLink?.key === link.key}
                    onShowQr={() => setQrKey(link.key)}
                  />
                ))}
                {devicesLoading && (
                  <div aria-label="设备链接加载中" className="flex flex-col gap-2">
                    <Skeleton className="h-14" />
                    <Skeleton className="h-14" />
                  </div>
                )}
                {!devicesLoading && devicesError != null && (
                  <div role="alert" className="flex items-center gap-3 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2.5 text-xs text-bad">
                    <CircleAlert size={15} className="shrink-0" />
                    <span className="min-w-0 flex-1">设备链接加载失败：{errorMessage(devicesError)}</span>
                    <Button size="sm" icon={RefreshCw} onClick={() => void refetchDevices()}>重试</Button>
                  </div>
                )}
                {!devicesLoading && !devicesError && devices?.length === 0 && (
                  <p className="text-sm text-ink-2">
                    {variant === 'shadowrocket' ? '请先添加设备，再获取专用链接。' : '还没有设备，当前只有共享配置链接。'}
                  </p>
                )}
              </div>
            )}
            <p className="text-[11px] leading-relaxed text-ink-3">
              {variant === 'clash'
                ? '完整配置包含策略组、规则与 DNS 等全部设置；设备链接会在共享配置之上叠加该设备的差异。'
                : variant === 'shadowrocket' ? SHADOWROCKET_HINT : 'Base64 订阅只含节点（ss:// vless:// …），适合 Shadowrocket、v2rayN 等非 Clash 客户端，不含分流规则。'}
            </p>
          </div>
          {qrLink && (
            <div className="flex flex-col items-center gap-3">
              <QrImage key={qrLink.url} text={qrLink.url} size={196} />
              <div className="max-w-[196px] text-center text-xs text-ink-3">
                扫码导入 · <span className="text-ink-2">{qrLink.label}</span>
              </div>
              {variant === 'clash' && (
                <a
                  href={`clash://install-config?url=${encodeURIComponent(qrLink.url)}&name=${encodeURIComponent(qrLink.label)}`}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink-2 shadow-xs hover:border-line-strong hover:text-ink"
                >
                  <ExternalLink size={12} /> 在 Clash 客户端中打开
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
