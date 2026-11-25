'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Code2, Compass, FileCode2, ListChecks, MoreHorizontal, RefreshCw, Smartphone, Trash2 } from 'lucide-react';
import { ApiError, api, errorMessage, type ConfigIssue } from '@/ui/data/api';
import { keys, refreshProfile, useDevice, useDevicePreview, useDevices } from '@/ui/data/hooks';
import { setQueryData } from '@/ui/data/query';
import type { DeviceUpdate, PublicDevice } from '@/ui/data/types';
import { CodeEditor } from '@/ui/editor/code-editor';
import { DataView } from '@/ui/agent';
import {
  Button,
  Card,
  CardHeader,
  confirmAction,
  EmptyState,
  Field,
  Input,
  Menu,
  notify,
  SegmentedControl,
  Skeleton,
  Textarea,
} from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { Page, PageHeader, SaveBar } from '@/ui/shell/page';
import { useScope } from '@/ui/shell/scope';
import { LinkRow, QrImage } from '@/ui/shell/share-dialog';
import {
  deviceLink,
  DISPLAY_NAME_MAX,
  nameError,
  parsePatchText,
  parseShared,
  samePatch,
  toYaml,
  validatePatch,
  type DeviceLinkVariant,
  type Patch,
} from './model';
import { DeviceGlyph, DeviceShareButton, TailscaleBadge, useSubscriptionUrl } from './parts';
import type { ShadowrocketRuleIssue } from '@/lib/engine/shadowrocketCompatibility';
import { describeShadowrocketIssueLocation } from '@/lib/engine/shadowrocketIssueFormat';
import { SHADOWROCKET_HINT, SubscriptionPurpose } from './subscription-purpose';
import { recheckShadowrocket } from './subscriptionCheck';
import { AddDifference, PatchForm } from './patch-editor';
import { PreviewPanel } from './preview-panel';
import { TailscaleCard } from './tailscale-card';

export function DeviceEditor({ deviceId }: { deviceId: string }) {
  const { profileId, path } = useScope();
  const device = useDevice(profileId, deviceId);

  if (!device.data) {
    if (device.error) {
      const missing = device.error instanceof ApiError && device.error.status === 404;
      return (
        <Page>
          <EmptyState
            className="pt-24"
            icon={missing ? Compass : RefreshCw}
            title={missing ? '找不到这台设备' : '设备加载失败'}
            description={missing ? '它可能已被删除。' : errorMessage(device.error)}
            actions={
              missing ? (
                <Button asChild variant="primary">
                  <Link href={path('devices')}>返回设备列表</Link>
                </Button>
              ) : (
                <Button variant="primary" icon={RefreshCw} onClick={() => void device.refetch()}>
                  重试
                </Button>
              )
            }
          />
        </Page>
      );
    }
    return (
      <Page width="wide">
        <div className="flex flex-col gap-3 pt-10">
          <Skeleton className="h-3 w-16" />
          <div className="flex items-center gap-3">
            <Skeleton className="size-11 rounded-xl" />
            <Skeleton className="h-8 w-56" />
          </div>
          <div className="mt-6 grid gap-6 @3xl/main:grid-cols-2">
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
          </div>
        </div>
      </Page>
    );
  }
  return <Workbench key={device.data.id} device={device.data} />;
}

interface Info {
  display_name: string;
  name: string;
  notes: string;
}

const infoOf = (d: PublicDevice): Info => ({ display_name: d.display_name ?? '', name: d.name, notes: d.notes ?? '' });

function Workbench({ device }: { device: PublicDevice }) {
  const router = useRouter();
  const { profile, profileId, path } = useScope();
  const devices = useDevices(profileId);
  const preview = useDevicePreview(profileId, device.id);
  const sub = useSubscriptionUrl(profile);

  const [baseline, setBaseline] = useState(device);
  const [mode, setMode] = useState<'form' | 'source'>('form');
  const [draft, setDraft] = useState<Patch>(device.base_patch);
  const [sourceText, setSourceText] = useState('');
  const [info, setInfo] = useState<Info>(() => infoOf(device));
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverIssues, setServerIssues] = useState<ConfigIssue[]>([]);

  const source = useMemo(() => (mode === 'source' ? parsePatchText(sourceText) : null), [mode, sourceText]);
  const patch: Patch | null = mode === 'source' ? (source?.patch ?? null) : draft;
  const problems = useMemo(() => (patch ? validatePatch(patch) : []), [patch]);
  const rowErrorList = mode === 'form' ? Object.values(rowErrors) : [];
  const taken = useMemo(
    () => new Set((devices.data ?? []).filter((d) => d.id !== device.id).map((d) => d.name)),
    [devices.data, device.id],
  );
  const infoError = {
    name: nameError(info.name.trim(), taken),
    display_name: info.display_name.length > DISPLAY_NAME_MAX ? `最多 ${DISPLAY_NAME_MAX} 个字` : null,
  };

  const patchDirty = patch ? !samePatch(patch, baseline.base_patch) : true;
  const infoDirty = JSON.stringify({ ...info, display_name: info.display_name.trim(), notes: info.notes.trim(), name: info.name.trim() }) !==
    JSON.stringify(infoOf(baseline));
  const dirty = patchDirty || infoDirty;
  const blocker =
    source?.error ?? problems[0]?.message ?? rowErrorList[0] ?? infoError.name ?? infoError.display_name ?? null;

  const resetTo = (next: PublicDevice) => {
    setBaseline(next);
    setDraft(next.base_patch);
    setSourceText(toYaml(next.base_patch));
    setInfo(infoOf(next));
    setRowErrors({});
    setRevision((r) => r + 1);
    setServerIssues([]);
  };

  // A newer server copy (refetch, another tab) replaces a clean form.
  if (device.updated_at !== baseline.updated_at && !dirty) resetTo(device);

  const sharedRoot = useMemo(() => parseShared(preview.data?.shared), [preview.data?.shared]);
  const label = baseline.display_name || baseline.name;

  const switchMode = (next: 'form' | 'source') => {
    if (next === mode) return;
    if (next === 'source') {
      setSourceText(toYaml(draft));
      setRowErrors({});
      setMode('source');
      return;
    }
    const parsed = parsePatchText(sourceText);
    if (!parsed.patch) {
      notify.warn('YAML 有误，修正后才能切回表单', parsed.error ?? undefined);
      return;
    }
    setDraft(parsed.patch);
    setRevision((r) => r + 1);
    setMode('form');
  };

  const save = async () => {
    if (!dirty || saving) return;
    if (blocker || !patch) {
      notify.warn('还有问题没解决', blocker ?? undefined);
      return;
    }
    const body: DeviceUpdate = {};
    if (patchDirty) body.base_patch = patch;
    const nextName = info.name.trim();
    if (nextName !== baseline.name) {
      const ok = await confirmAction({
        title: '修改链接名？',
        description: `订阅链接会从 …/${baseline.name} 变成 …/${nextName}。已经导入旧链接的客户端需要重新导入，否则更新订阅会失败。`,
        confirmText: '修改并保存',
        confirmHint: '修改链接名后客户端需重新导入订阅链接',
      });
      if (!ok) return;
      body.name = nextName;
    }
    if (info.display_name.trim() !== (baseline.display_name ?? '')) body.display_name = info.display_name.trim() || null;
    if (info.notes.trim() !== (baseline.notes ?? '')) body.notes = info.notes.trim() || null;
    setSaving(true);
    setServerIssues([]);
    try {
      const updated = await api.patch<PublicDevice>(`/profiles/${profileId}/devices/${baseline.id}`, body);
      setQueryData(keys.scoped(profileId, `device:${updated.id}`), updated);
      refreshProfile(profileId);
      resetTo(updated);
      notify.success('已保存', '客户端下次更新订阅时生效');
    } catch (error) {
      if (error instanceof ApiError) setServerIssues(error.issues.length ? error.issues : [{ message: errorMessage(error) }]);
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  useHotkey('mod+s', () => void save(), { enabled: dirty });

  const remove = async () => {
    const ok = await confirmAction({
      title: `删除设备「${label}」？`,
      description: '它的专属订阅链接会立即失效，客户端下次更新会失败。可以在「操作历史」里撤销。',
      confirmText: '确认删除',
      confirmHint: '删除后该设备的专属订阅链接会立即失效',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.del(`/profiles/${profileId}/devices/${baseline.id}`);
      refreshProfile(profileId);
      notify.success(`已删除「${label}」`);
      router.push(path('devices'));
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  const count = Object.keys(patch ?? {}).length;

  return (
    <Page width="wide">
      <PageHeader
        back={{ href: path('devices'), label: '设备' }}
        documentTitle={`${label} · 设备`}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <DeviceGlyph name={baseline.name} displayName={baseline.display_name} size={44} />
            <span className="truncate">{label}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs text-ink-3">{baseline.name}</span>
            {baseline.notes && <span className="text-ink-3">· {baseline.notes}</span>}
            {(baseline.features.tailscale ||
              (baseline.features.tailscaleInstances?.length ?? 0) > 0) && (
              <TailscaleBadge
                hostname={baseline.features.tailscale?.hostname}
                extra={baseline.features.tailscaleInstances?.length ?? 0}
              />
            )}
          </span>
        }
        actions={
          <>
            {sub.url && (
              <DeviceShareButton subscriptionUrl={sub.url} name={baseline.name} label={label} size="md" variant="secondary" />
            )}
            <Menu
              items={[{ label: '删除设备', icon: Trash2, tone: 'danger', onSelect: () => void remove() }]}
              trigger={<Button iconOnly icon={MoreHorizontal} aria-label="更多操作" />}
            />
          </>
        }
      />

      <div className="grid items-start gap-6 @3xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Card className="animate-rise">
            <CardHeader
              title={count ? `差异 · ${count} 项` : '差异'}
              description="只写这台设备和共享配置不同的地方，其余全部跟随共享配置"
              actions={
                <SegmentedControl
                  size="sm"
                  label="差异编辑模式"
                  value={mode}
                  onChange={switchMode}
                  options={[
                    { value: 'form', label: '表单', icon: ListChecks },
                    { value: 'source', label: '源码', icon: Code2 },
                  ]}
                />
              }
            />
            <div className="border-t border-line px-4 pb-4 pt-3">
              {serverIssues.length > 0 && (
                <ul className="mb-3 flex flex-col gap-1.5 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2.5 text-xs text-bad">
                  <li className="font-medium">保存被拒绝：</li>
                  {serverIssues.map((issue, i) => (
                    <li key={i}>{issue.message}</li>
                  ))}
                </ul>
              )}
              {mode === 'form' ? (
                <>
                  <PatchForm
                    draft={draft}
                    onChange={setDraft}
                    shared={sharedRoot}
                    revision={revision}
                    focusKey={focusKey}
                    rowErrors={rowErrors}
                    onRowError={(key, error) =>
                      setRowErrors((current) => {
                        const next = { ...current };
                        if (error) next[key] = error;
                        else delete next[key];
                        return next;
                      })
                    }
                    problems={problems}
                  />
                  {count === 0 && (
                    <div className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-line-strong px-4 py-6 text-center">
                      <Smartphone size={18} className="text-ink-4" />
                      <p className="text-sm font-medium text-ink">完全跟随共享配置</p>
                      <p className="text-xs text-ink-3">比如给手机关掉进程匹配、给软路由打开 TUN —— 只加需要不同的那几项。</p>
                    </div>
                  )}
                  {problems.filter((p) => !p.key).map((p) => (
                    <p key={p.message} className="mt-2 text-xs text-bad">
                      {p.message}
                    </p>
                  ))}
                  <div className="mt-3 flex items-center gap-2">
                    <AddDifference
                      draft={draft}
                      shared={sharedRoot}
                      onAdd={(key, value) => {
                        setDraft((current) => ({ ...current, [key]: value }));
                        setFocusKey(key);
                      }}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="overflow-hidden rounded-lg border border-line bg-surface-2/40 focus-within:border-accent">
                    <CodeEditor
                      label="设备差异 YAML"
                      value={sourceText}
                      onChange={setSourceText}
                      height="320px"
                      placeholder={'# 例如\nmixed-port: 7891\nallow-lan: true'}
                    />
                  </div>
                  {source?.error ? (
                    <p className="mt-2 text-xs text-bad">{source.error}</p>
                  ) : (
                    problems.map((p) => (
                      <p key={p.message} className="mt-2 text-xs text-bad">
                        {p.message}
                      </p>
                    ))
                  )}
                  <p className="mt-2 text-xs text-ink-3">
                    整份差异按 JSON Merge Patch 合并：对象逐项合并，列表与数值整体替换，写 <span className="font-mono">null</span>{' '}
                    删除共享配置里的该项。
                  </p>
                </>
              )}
            </div>
          </Card>

          <TailscaleCard profileId={profileId} device={baseline} isTemplate={sub.isTemplate} />

          <Card className="animate-rise [animation-delay:160ms]">
            <CardHeader title="基本信息" description="名称只影响显示；链接名会出现在订阅链接里" />
            <div className="grid gap-4 border-t border-line px-4 py-4 sm:grid-cols-2">
              <Field label="显示名称" optional error={infoError.display_name}>
                {(id) => (
                  <Input
                    id={id}
                    value={info.display_name}
                    placeholder={baseline.name}
                    onChange={(e) => setInfo({ ...info, display_name: e.target.value })}
                  />
                )}
              </Field>
              <Field label="链接名" error={info.name.trim() !== baseline.name ? infoError.name : null} hint="小写字母、数字和中划线">
                {(id) => (
                  <Input
                    id={id}
                    mono
                    value={info.name}
                    invalid={!!infoError.name && info.name.trim() !== baseline.name}
                    onChange={(e) => setInfo({ ...info, name: e.target.value.toLowerCase() })}
                  />
                )}
              </Field>
              <Field label="备注" optional className="sm:col-span-2">
                {(id) => (
                  <Textarea
                    id={id}
                    rows={2}
                    className="min-h-[60px]"
                    value={info.notes}
                    placeholder="例如：书房 NAS，只跑下载"
                    onChange={(e) => setInfo({ ...info, notes: e.target.value })}
                  />
                )}
              </Field>
            </div>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-6 @3xl/main:sticky @3xl/main:top-4">
          <PreviewPanel
            profileId={profileId}
            deviceId={baseline.id}
            draft={patch && problems.length === 0 && rowErrorList.length === 0 ? patch : null}
            dirty={patchDirty}
            hasTailscale={
              !!baseline.features.tailscale ||
              (baseline.features.tailscaleInstances?.length ?? 0) > 0
            }
          />
          <LinksCard updatedAt={baseline.updated_at} shared={preview.data?.shared} url={sub.url} loading={sub.loading} isTemplate={sub.isTemplate} name={baseline.name} label={label} renamed={info.name.trim() !== baseline.name} />
        </div>
      </div>

      <SaveBar visible={dirty} onSave={() => void save()} onDiscard={() => resetTo(baseline)} saving={saving} />
    </Page>
  );
}

function LinksCard({
  updatedAt,
  shared,
  url,
  loading,
  isTemplate,
  name,
  label,
  renamed,
}: {
  shared: string | undefined;
  url: string | null;
  loading: boolean;
  isTemplate: boolean;
  name: string;
  label: string;
  renamed: boolean;
  updatedAt: number;
}) {
  const [active, setActive] = useState<DeviceLinkVariant>('clash');
  const current = url ? deviceLink(url, name, active) : null;
  return (
    <Card className="animate-rise [animation-delay:120ms]">
      <CardHeader title="订阅链接" description="粘贴到客户端，或用手机扫码导入；链接含访问令牌，请勿公开" />
      <div className="border-t border-line px-4 py-4">
        {isTemplate ? (
          <p className="text-xs text-ink-3">模版不对外分发。从模版新建配置文件后，那份配置里的设备才有订阅链接。</p>
        ) : loading || !current ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : (
          <div role="region" aria-label="设备订阅链接" className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="flex min-w-0 flex-col gap-2">
              <SubscriptionPurpose value={active} onChange={setActive} />
              <LinkRow label={label} url={current} icon={active === 'base64' ? Smartphone : FileCode2} />
              {renamed && <p className="text-xs text-ink-3">链接名已修改：保存后链接会变，客户端需要重新导入。</p>}
              <p className="text-[11px] leading-relaxed text-ink-3">
                {active === 'clash'
                  ? '完整配置 = 共享配置 + 这台设备的差异，包含分流规则。'
                  : active === 'shadowrocket' ? SHADOWROCKET_HINT : 'Base64 只含节点。'}
              </p>
              {active === 'shadowrocket' && (
                <SubscriptionCheck key={`${current}:${updatedAt}`} url={current} revision={shared ?? ''} />
              )}
            </div>
            <div className="flex flex-col items-center gap-2">
              <QrImage key={current} text={current} size={148} />
              <span className="text-[11px] text-ink-3">扫码 · {label}</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function SubscriptionCheck({ url, revision }: { url: string; revision: string }) {
  const request = useRef<AbortController | null>(null);
  const [visibleCount, setVisibleCount] = useState(50);
  const [result, setResult] = useState<string | ShadowrocketRuleIssue[]>('');
  useEffect(() => () => request.current?.abort(), []);

  // The saved shared config can change without touching this device's URL or
  // updated_at. A refreshed preview is the existing change signal, so discard
  // the old verdict and ignore a request that only finishes afterwards.
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setVisibleCount(50);
    setResult('');
  }, [revision]);

  async function check() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setVisibleCount(50);
    setResult('正在检查已保存的设备配置…');
    try {
      const issues = await recheckShadowrocket(url, controller.signal);
      if (request.current === controller && !controller.signal.aborted)
        setResult(issues.length ? issues : '检查通过');
    } catch (error) {
      if (request.current === controller && !controller.signal.aborted)
        setResult(errorMessage(error));
    }
  }
  // Mirrors the link's own gate: only known-incompatible findings refuse the download.
  const blocked = Array.isArray(result)
    ? result.filter((issue) => issue.status === 'incompatible').length
    : 0;
  return (
    <div className="space-y-2">
      <Button size="sm" icon={RefreshCw} onClick={() => void check()}>重新检查</Button>
      <DataView
        label="Shadowrocket 兼容性检查"
        summary={
          typeof result === 'string'
            ? result || '未检查'
            : blocked
              ? `${blocked} 项不兼容，共 ${result.length} 项`
              : `${result.length} 项待验证`
        }
        items={
          typeof result === 'string'
            ? (result ? [{ value: 'status', label: result }] : [])
            : result.slice(0, 50).map((issue, i) => ({
                value: String(i),
                label: `${issue.status === 'incompatible' ? '不兼容' : '待验证'} · ${describeShadowrocketIssueLocation(issue)}：${issue.reason}`,
              }))
        }
      >
        <div role="status" className="space-y-1 text-xs text-ink-2">
          {Array.isArray(result) && (
            <p className="font-medium text-ink">
              {blocked
                ? `Shadowrocket 无法下载此链接：${blocked} 项已知不兼容。`
                : `Shadowrocket 可以下载此链接；${result.length} 项分流行为尚未验证，导入后可能与预期不同。`}
            </p>
          )}
          {typeof result === 'string' ? result : result.slice(0, visibleCount).map((issue, index) => (
            <p key={`${issue.listener ?? ''}:${issue.table ?? ''}:${issue.field ?? ''}:${issue.mode ?? ''}:${issue.ruleNumber ?? ''}:${index}`}>
              {issue.status === 'incompatible' ? '已知不兼容' : '待验证'} · {describeShadowrocketIssueLocation(issue)}
              {issue.member ? ` · 成员 ${issue.member}${issue.option ? `（${issue.option}）` : ''}` : issue.option ? ` · 选项 ${issue.option}` : ''}
              {issue.reference && !issue.field && !issue.mode ? `（关联：${issue.reference}）` : ''}：{issue.reason}
            </p>
          ))}
        </div>
      </DataView>
      {Array.isArray(result) && result.length > visibleCount && (
        <Button size="sm" aria-label="显示更多诊断" onClick={() => setVisibleCount((n) => n + 50)}>
          显示更多诊断（已显示 {visibleCount} / {result.length}）
        </Button>
      )}
    </div>
  );
}
