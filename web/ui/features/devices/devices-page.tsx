'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowUpRight, CircleAlert, Layers, MonitorSmartphone, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError, errorMessage } from '@/ui/data/api';
import { refreshProfile, useDashboard, useDevices } from '@/ui/data/hooks';
import type { PublicDevice } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import {
  Button,
  Card,
  confirmAction,
  copyText,
  CopyButton,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  notify,
  Skeleton,
  Tooltip,
} from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { useScope } from '@/ui/shell/scope';
import {
  buildPresetPatch,
  chipFor,
  DEVICE_PRESETS,
  deviceLink,
  DISPLAY_NAME_MAX,
  guessPlatform,
  MAX_DEVICES_PER_PROFILE,
  nameError,
  PLATFORM_META,
  suggestSlug,
  summarizePatch,
  type DevicePreset,
} from './model';
import { DeviceGlyph, PatchSticker, QrButton, TailscaleBadge, useSubscriptionUrl } from './parts';

type PresetId = DevicePreset['id'];

const PRESET_ICON: Record<PresetId, (typeof PLATFORM_META)[keyof typeof PLATFORM_META]['icon']> = {
  phone: PLATFORM_META.phone.icon,
  desktop: PLATFORM_META.laptop.icon,
  server: PLATFORM_META.server.icon,
  custom: PLATFORM_META.generic.icon,
};

export function DevicesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { profile, profileId, path } = useScope();
  const devices = useDevices(profileId);
  const sub = useSubscriptionUrl(profile);
  const dashboard = useDashboard(sub.isTemplate ? null : profileId);
  const [dialog, setDialog] = useState<{ open: boolean; preset?: PresetId }>({ open: false });

  const wantsNew = searchParams.get('new') === '1';
  const list = devices.data ?? [];
  const atLimit = list.length >= MAX_DEVICES_PER_PROFILE;
  const open = dialog.open || wantsNew;

  const openNew = (preset?: PresetId) => setDialog({ open: true, preset });
  const close = () => {
    setDialog({ open: false });
    if (wantsNew) router.replace(path('devices'), { scroll: false });
  };

  const remove = async (device: PublicDevice) => {
    const label = device.display_name || device.name;
    const ok = await confirmAction({
      title: `删除设备「${label}」？`,
      description: '它的专属订阅链接会立即失效，客户端下次更新会失败。可以在「操作历史」里撤销。',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/profiles/${profileId}/devices/${device.id}`);
      devices.mutate((current) => (current ?? []).filter((d) => d.id !== device.id));
      refreshProfile(profileId);
      notify.success(`已删除「${label}」`);
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  const addButton = (
    <Tooltip content={atLimit ? `每份配置文件最多 ${MAX_DEVICES_PER_PROFILE} 台设备` : undefined}>
      <span className="inline-flex">
        <Button variant="primary" icon={Plus} disabled={atLimit || !devices.data} onClick={() => openNew()}>
          添加设备
        </Button>
      </span>
    </Tooltip>
  );

  return (
    <Page>
      <PageHeader
        title="设备"
        description="每台设备 = 共享配置 + 几处差异；改共享层，所有设备一起生效。"
        actions={
          <>
            {devices.data && (
              <span className="tnum text-xs text-ink-3">
                {list.length} / {MAX_DEVICES_PER_PROFILE} 台
              </span>
            )}
            {addButton}
          </>
        }
      />

      {devices.error && !devices.data ? (
        <Card className="flex items-center gap-3 px-4 py-3.5 text-sm">
          <CircleAlert size={16} className="shrink-0 text-bad" />
          <span className="min-w-0 flex-1 text-ink-2">设备列表加载失败：{errorMessage(devices.error)}</span>
          <Button size="sm" icon={RefreshCw} onClick={() => void devices.refetch()}>
            重试
          </Button>
        </Card>
      ) : !devices.data ? (
        <div className="grid gap-4 md:grid-cols-2 @4xl/main:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-xl" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
              <Skeleton className="h-20 rounded-lg" />
              <Skeleton className="h-6 w-24" />
            </Card>
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card className="animate-rise">
          <EmptyState
            icon={MonitorSmartphone}
            title="还没有设备"
            description="为每台设备生成专属订阅链接：手机关掉进程匹配、软路由打开 TUN……其余设置都跟随共享配置。选一个起点："
            actions={DEVICE_PRESETS.map((preset) => {
              const Icon = PRESET_ICON[preset.id];
              return (
                <Button key={preset.id} size="sm" icon={Icon} variant={preset.id === 'phone' ? 'primary' : 'secondary'} onClick={() => openNew(preset.id)}>
                  {preset.label}
                </Button>
              );
            })}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-2 @4xl/main:grid-cols-3">
            {list.map((device, index) => (
              <DeviceCard
                key={device.id}
                device={device}
                index={index}
                href={path(`devices/${device.id}`)}
                subscriptionUrl={sub.url}
                onEdit={() => router.push(path(`devices/${device.id}`))}
                onDelete={() => void remove(device)}
              />
            ))}
            {!atLimit && (
              <button
                type="button"
                onClick={() => openNew()}
                className="flex min-h-[188px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-sm text-ink-3 transition-colors hover:border-ink-3 hover:bg-surface-2/50 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="flex size-9 items-center justify-center rounded-full border border-line bg-surface shadow-xs">
                  <Plus size={16} />
                </span>
                添加设备
              </button>
            )}
          </div>
          {/* the shelf every device stands on */}
          <div className="dot-grid flex animate-rise flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-surface-2/60 px-4 py-3 [animation-delay:120ms]">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 shadow-xs">
              <Layers size={15} strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-ink">共享配置 · {profileTitle(profile)}</div>
              <p className="text-xs text-ink-3">
                {dashboard.data
                  ? `${dashboard.data.counts.proxyGroups} 个策略组、${dashboard.data.counts.rules} 条规则和 DNS 等设置由所有设备共用，改一次全部生效。`
                  : '策略组、规则、DNS 等设置由所有设备共用，改一次全部生效。'}
              </p>
            </div>
            <Button asChild size="sm" variant="ghost" trailingIcon={ArrowUpRight}>
              <Link href={path('base')}>基础配置</Link>
            </Button>
          </div>
        </div>
      )}

      <NewDeviceDialog
        open={open}
        onClose={close}
        initialPreset={dialog.preset}
        devices={list}
        atLimit={atLimit}
        profileId={profileId}
        profileName={profile.name}
        onCreated={(device) => {
          close();
          router.push(path(`devices/${device.id}`));
        }}
      />
    </Page>
  );
}

/* ─── card ───────────────────────────────────────────────────────────── */

function DeviceCard({
  device,
  index,
  href,
  subscriptionUrl,
  onEdit,
  onDelete,
}: {
  device: PublicDevice;
  index: number;
  href: string;
  subscriptionUrl: string | null;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const label = device.display_name || device.name;
  const chips = summarizePatch(device.base_patch);
  const link = subscriptionUrl ? deviceLink(subscriptionUrl, device.name) : null;
  return (
    <Card
      as="article"
      interactive
      className="relative flex animate-rise flex-col gap-3 p-4"
    >
      <span className="sr-only">{`第 ${index + 1} 台`}</span>
      <div className="flex items-start gap-3">
        <DeviceGlyph name={device.name} displayName={device.display_name} />
        <div className="min-w-0 flex-1">
          <Link
            href={href}
            className="block truncate text-sm font-semibold text-ink outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:shadow-[var(--ring)]"
          >
            {label}
          </Link>
          <div className="truncate font-mono text-[11px] text-ink-3">{device.name}</div>
        </div>
        <div className="relative z-10">
          <Menu
            items={[
              { label: '编辑', icon: Pencil, onSelect: onEdit },
              ...(link
                ? [
                    {
                      label: '复制链接',
                      icon: ArrowUpRight,
                      onSelect: () => void copyText(link).then((ok) => ok && notify.success(`已复制「${label}」的订阅链接`)),
                    },
                  ]
                : []),
              'separator' as const,
              { label: '删除', icon: Trash2, tone: 'danger' as const, onSelect: onDelete },
            ]}
            trigger={<Button variant="ghost" size="sm" iconOnly icon={MoreHorizontal} aria-label={`${label} 的更多操作`} />}
          />
        </div>
      </div>
      {device.notes && <p className="-mt-1 truncate text-xs text-ink-3">{device.notes}</p>}

      <div className="rounded-lg bg-surface-2/70 p-2.5">
        {chips.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {chips.slice(0, 6).map((chip) => (
              <PatchSticker key={chip.key} chip={chip} />
            ))}
            {chips.length > 6 && <span className="self-center text-xs text-ink-3">+{chips.length - 6}</span>}
          </div>
        ) : (
          <p className="py-1 text-xs text-ink-3">没有差异，完全跟随共享配置</p>
        )}
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-dashed border-line-strong pt-2 text-2xs text-ink-3">
          <Layers size={11} />
          叠加在共享配置之上
        </div>
      </div>

      <div className="mt-auto flex items-center gap-1.5">
        {device.features.tailscale && <TailscaleBadge hostname={device.features.tailscale.hostname} />}
        <span className="flex-1" />
        {link && (
          <div className="relative z-10 flex items-center">
            <CopyButton text={link} label="复制订阅链接" message={`已复制「${label}」的订阅链接`} />
            <QrButton subscriptionUrl={subscriptionUrl!} name={device.name} label={label} />
          </div>
        )}
      </div>
    </Card>
  );
}

/* ─── new device dialog ──────────────────────────────────────────────── */

interface NewForm {
  displayName: string;
  name: string;
  nameTouched: boolean;
  notes: string;
  preset: PresetId;
  presetTouched: boolean;
  tried: boolean;
}

const initialForm = (preset?: PresetId): NewForm => ({
  displayName: '',
  name: '',
  nameTouched: false,
  notes: '',
  preset: preset ?? 'custom',
  presetTouched: !!preset,
  tried: false,
});

function NewDeviceDialog({
  open,
  onClose,
  initialPreset,
  devices,
  atLimit,
  profileId,
  profileName,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  initialPreset?: PresetId;
  devices: PublicDevice[];
  atLimit: boolean;
  profileId: string;
  profileName: string;
  onCreated: (device: PublicDevice) => void;
}) {
  const [form, setForm] = useState<NewForm>(() => initialForm(initialPreset));
  const [wasOpen, setWasOpen] = useState(open);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm(initialForm(initialPreset));
      setConflict(null);
    }
  }

  const taken = useMemo(() => new Set(devices.map((d) => d.name)), [devices]);
  const name = form.nameTouched ? form.name : form.displayName.trim() ? suggestSlug(form.displayName, taken) : '';
  const error = conflict ?? (form.tried || form.nameTouched ? nameError(name, taken) : null);
  const displayError = form.displayName.length > DISPLAY_NAME_MAX ? `最多 ${DISPLAY_NAME_MAX} 个字` : null;

  const setDisplayName = (displayName: string) => {
    setForm((current) => {
      let preset = current.preset;
      if (!current.presetTouched) {
        const platform = guessPlatform(displayName);
        if (platform === 'phone' || platform === 'tablet') preset = 'phone';
        else if (platform === 'laptop' || platform === 'desktop') preset = 'desktop';
      }
      return { ...current, displayName, preset };
    });
  };

  const submit = async () => {
    setForm((current) => ({ ...current, tried: true }));
    if (nameError(name, taken) || displayError || atLimit) return;
    const preset = DEVICE_PRESETS.find((p) => p.id === form.preset) ?? DEVICE_PRESETS[3];
    setBusy(true);
    try {
      const created = await api.post<PublicDevice>(`/profiles/${profileId}/devices`, {
        name,
        ...(form.displayName.trim() ? { display_name: form.displayName.trim() } : {}),
        ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
        base_patch: buildPresetPatch(preset),
      });
      refreshProfile(profileId);
      notify.success(`已添加设备「${created.display_name || created.name}」`, '复制它的订阅链接，导入到这台设备的客户端即可。');
      onCreated(created);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflict('这份配置里已有同名设备');
      notify.error(err, '添加失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="添加设备"
      description="设备会继承这份配置的全部设置，只额外记录它自己的几处差异。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={atLimit} onClick={() => void submit()}>
            添加设备
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {atLimit && (
          <p className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
            已达到上限：每份配置文件最多 {MAX_DEVICES_PER_PROFILE} 台设备。
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="显示名称" error={displayError} hint="客户端里看到的名字">
            {(id) => (
              <Input
                id={id}
                data-autofocus
                value={form.displayName}
                placeholder="例如：iPhone 16、书房 NAS"
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
          </Field>
          <Field label="链接名" error={error} hint={<span className="font-mono">…/{profileName}/{name || 'name'}</span>}>
            {(id) => (
              <Input
                id={id}
                mono
                value={name}
                invalid={!!error}
                placeholder="iphone"
                onChange={(e) => {
                  setConflict(null);
                  setForm((current) => ({ ...current, name: e.target.value.toLowerCase(), nameTouched: true }));
                }}
              />
            )}
          </Field>
        </div>
        <Field label="备注" optional>
          {(id) => (
            <Input id={id} value={form.notes} placeholder="例如：工作电脑" onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          )}
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">从哪种设备开始</span>
          <div role="radiogroup" aria-label="预设" className="grid gap-2 sm:grid-cols-2">
            {DEVICE_PRESETS.map((preset) => {
              const Icon = PRESET_ICON[preset.id];
              const active = form.preset === preset.id;
              const chips = Object.entries(preset.patch).map(([k, v]) => chipFor(k, v));
              if (preset.needsSecret) chips.push({ ...chipFor('secret', 'x'), value: '随机生成' });
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setForm({ ...form, preset: preset.id, presetTouched: true })}
                  className={cn(
                    'flex flex-col gap-2 rounded-xl border p-3 text-left transition-[border-color,background-color,box-shadow]',
                    active ? 'border-accent-line bg-accent-soft/50 shadow-[var(--ring)]' : 'border-line hover:border-line-strong hover:bg-surface-2/50',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-ink">
                    <Icon size={15} strokeWidth={1.75} className={active ? 'text-accent' : 'text-ink-3'} />
                    {preset.label}
                  </span>
                  <span className="text-xs leading-relaxed text-ink-3">{preset.blurb}</span>
                  {chips.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {chips.map((chip) => (
                        <PatchSticker key={chip.key} chip={chip} className="h-5 px-1.5 text-[11px]" />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <button type="submit" hidden aria-hidden />
      </form>
    </Dialog>
  );
}
