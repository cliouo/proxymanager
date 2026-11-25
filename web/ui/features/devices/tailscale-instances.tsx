'use client';

/**
 * Shared editing surface for Tailscale service routes and additional instances.
 *
 * `ServiceRouteEditor` is used twice: by the legacy slot (which may switch
 * between CIDR and service mode) and by each additional instance editor (which
 * only ever offers service mode). `AdditionalInstances` lists the extra
 * instances of one device and opens the per-instance editor.
 */

import { useState } from 'react';
import { CircleAlert, Plus, Server, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/ui/data/api';
import { keys, refreshProfile } from '@/ui/data/hooks';
import { useQuery } from '@/ui/data/query';
import type { PublicTailscaleDeviceFeature } from '@/ui/data/types';
import { ipLiteralFamily } from '@/lib/net/ipLiteral';
import { DataView } from '@/ui/agent';
import {
  Badge,
  Button,
  confirmAction,
  Dialog,
  Field,
  Input,
  notify,
  Skeleton,
  Switch,
} from '@/ui/primitives';
import {
  EMPTY_ROUTE,
  draftsToRoutes,
  formatServiceRoute,
  routeDraftError,
  routeSetError,
  routeToDraft,
  type ServiceRouteDraft,
} from './tailscale-model';

export interface InstanceSummary {
  instances: PublicTailscaleDeviceFeature[];
  warnings: string[];
}

interface InstanceForm {
  hostname: string;
  authKey: string;
  authMode: 'keep' | 'set' | 'clear';
  controlUrl: string;
  stateDir: string;
  ephemeral: boolean;
  acceptRoutes: boolean;
  udp: boolean;
  exitNode: string;
  exitNodeAllowLanAccess: boolean;
  routes: ServiceRouteDraft[];
  nodeName: string;
  groupName: string;
}

const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function fromInstance(
  instance: PublicTailscaleDeviceFeature | null,
  deviceName: string,
  index: number,
): InstanceForm {
  return {
    hostname: instance?.hostname ?? `${deviceName}-${index}`.slice(0, 63),
    authKey: '',
    authMode: instance?.hasAuthKey ? 'keep' : 'set',
    controlUrl: instance?.controlUrl ?? '',
    stateDir: instance?.stateDir ?? '',
    ephemeral: instance?.ephemeral ?? false,
    acceptRoutes: instance?.acceptRoutes ?? true,
    udp: instance?.udp ?? true,
    exitNode: instance?.exitNode ?? '',
    exitNodeAllowLanAccess: instance?.exitNodeAllowLanAccess ?? false,
    routes:
      instance?.serviceRoutes && instance.serviceRoutes.length > 0
        ? instance.serviceRoutes.map(routeToDraft)
        : [EMPTY_ROUTE],
    nodeName: instance?.nodeName ?? '',
    groupName: instance?.groupName ?? '',
  };
}

function instancePayload(form: InstanceForm) {
  const opt = (value: string) => (value.trim() ? value.trim() : undefined);
  return {
    hostname: form.hostname.trim(),
    serviceRoutes: draftsToRoutes(form.routes),
    controlUrl: opt(form.controlUrl),
    stateDir: opt(form.stateDir),
    ephemeral: form.ephemeral,
    acceptRoutes: form.acceptRoutes,
    udp: form.udp,
    exitNode: opt(form.exitNode),
    exitNodeAllowLanAccess: form.exitNodeAllowLanAccess,
    nodeName: opt(form.nodeName),
    groupName: opt(form.groupName),
    ...(form.authMode === 'set' && form.authKey.trim()
      ? { authKey: form.authKey.trim() }
      : form.authMode === 'clear'
        ? { authKey: null }
        : {}),
  };
}

/**
 * Row editor for `IP + port` pairs.
 *
 * Empty trailing rows are ignored so typing never fights the user; a row with
 * only one of the two values is a blocking error rather than a silent drop.
 */
export function ServiceRouteEditor({
  routes,
  onChange,
  disabled,
  error,
}: {
  routes: ServiceRouteDraft[];
  onChange: (routes: ServiceRouteDraft[]) => void;
  disabled?: boolean;
  error?: string;
}) {
  const update = (index: number, patch: Partial<ServiceRouteDraft>) =>
    onChange(
      routes.map((route, position) => (position === index ? { ...route, ...patch } : route)),
    );

  return (
    <div className="flex flex-col gap-2">
      {routes.map((route, index) => {
        const rowError = routeDraftError(route);
        return (
          <div key={index} className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <Input
                mono
                value={route.ip}
                disabled={disabled}
                invalid={!!rowError}
                placeholder={index === 0 ? '100.100.1.2 或 fd7a:115c:a1e0::1' : '目标 IP'}
                aria-label={`目标 IP #${index + 1}`}
                onChange={(event) => update(index, { ip: event.target.value })}
              />
            </div>
            <div className="w-28 shrink-0">
              <Input
                mono
                inputMode="numeric"
                value={route.port}
                disabled={disabled}
                invalid={!!rowError}
                placeholder="端口"
                aria-label={`目标端口 #${index + 1}`}
                onChange={(event) => update(index, { port: event.target.value })}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              disabled={disabled || routes.length === 1}
              aria-label="删除这条路由"
              onClick={() => onChange(routes.filter((_, position) => position !== index))}
            />
            {rowError && <p className="w-full text-xs text-bad">{rowError}</p>}
          </div>
        );
      })}
      {error && <p className="text-xs text-bad">{error}</p>}
      <div>
        <Button
          size="xs"
          variant="ghost"
          icon={Plus}
          disabled={disabled}
          onClick={() => onChange([...routes, EMPTY_ROUTE])}
        >
          再加一条
        </Button>
      </div>
    </div>
  );
}

function InstanceEditor({
  profileId,
  deviceId,
  deviceName,
  instance,
  nextIndex,
  open,
  onOpenChange,
  onSaved,
}: {
  profileId: string;
  deviceId: string;
  deviceName: string;
  instance: PublicTailscaleDeviceFeature | null;
  nextIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<InstanceForm>(() =>
    fromInstance(instance, deviceName, nextIndex),
  );
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  // Re-seed whenever the dialog opens for a different instance, so one
  // instance's key state can never leak into another instance's form.
  const [seed, setSeed] = useState(`${instance?.id ?? 'new'}:${open}`);
  const currentSeed = `${instance?.id ?? 'new'}:${open}`;
  if (seed !== currentSeed) {
    setSeed(currentSeed);
    setForm(fromInstance(instance, deviceName, nextIndex));
    setTried(false);
  }

  const update = (patch: Partial<InstanceForm>) => setForm((current) => ({ ...current, ...patch }));
  const hostnameError =
    !form.hostname.trim() ||
    form.hostname.trim().length > 63 ||
    !HOSTNAME_RE.test(form.hostname.trim())
      ? '只能含字母、数字和中划线，且不能以中划线开头或结尾'
      : undefined;
  const routesError = routeSetError(form.routes);
  const authError =
    form.authMode === 'set' && /\s/.test(form.authKey.trim()) ? '密钥不能包含空白' : undefined;
  const hasErrors = !!hostnameError || !!routesError || !!authError;

  const save = async () => {
    setTried(true);
    if (hasErrors) return;
    setBusy(true);
    try {
      const base = `/profiles/${profileId}/devices/${deviceId}/features/tailscale/instances`;
      if (instance?.id) {
        await api.put(`${base}/${instance.id}`, instancePayload(form));
        notify.success('已更新 Tailscale 实例', '客户端下次更新订阅时生效');
      } else {
        await api.post(base, instancePayload(form));
        notify.success('已新增 Tailscale 实例', '客户端下次更新订阅时生效');
      }
      onSaved();
      onOpenChange(false);
    } catch (error) {
      notify.error(error, instance ? '保存实例失败' : '新增实例失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={instance ? `编辑实例 · ${instance.hostname}` : '新增 Tailscale 实例'}
      description="每个附加实例是一条独立的内嵌 Tailscale：它有各自的 auth key、状态目录与策略组，只接管下面列出的「目标 IP + 端口」。"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            data-agent-confirm={
              instance
                ? `保存 Tailscale 附加实例「${form.hostname}」`
                : `新增 Tailscale 附加实例「${form.hostname}」`
            }
            onClick={() => void save()}
          >
            {instance ? '保存实例' : '新增实例'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 pb-5">
        <Field
          label="主机名 hostname"
          hint="该实例在 tailnet 内显示的名字；同一设备内不能重复"
          error={tried ? hostnameError : undefined}
        >
          {(id) => (
            <Input
              id={id}
              mono
              value={form.hostname}
              invalid={tried && !!hostnameError}
              onChange={(event) => update({ hostname: event.target.value })}
            />
          )}
        </Field>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-ink">目标 IP + 端口</p>
          <p className="text-xs text-ink-3">
            只有这些具体服务走这个实例；同一设备上同一对地址和端口不能属于两个实例。
          </p>
          <ServiceRouteEditor
            routes={form.routes}
            onChange={(routes) => update({ routes })}
            disabled={busy}
            error={tried ? (routesError ?? undefined) : undefined}
          />
        </div>

        <Field label="认证密钥" hint="只写不读；留空保持原样" error={tried ? authError : undefined}>
          {(id) =>
            form.authMode === 'keep' ? (
              <div className="flex h-8 items-center gap-2">
                <Badge tone="ok">已设置</Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => update({ authMode: 'set', authKey: '' })}
                >
                  更换
                </Button>
                <Button
                  size="xs"
                  variant="danger-ghost"
                  onClick={() => update({ authMode: 'clear' })}
                >
                  清除
                </Button>
              </div>
            ) : form.authMode === 'clear' ? (
              <div className="flex h-8 items-center gap-2 text-xs text-bad">
                保存后清除密钥
                <Button size="xs" variant="ghost" onClick={() => update({ authMode: 'keep' })}>
                  撤销
                </Button>
              </div>
            ) : (
              <Input
                id={id}
                mono
                type="password"
                autoComplete="off"
                data-agent-secret
                placeholder={instance?.hasAuthKey ? '输入新密钥以替换' : 'tskey-auth-…'}
                value={form.authKey}
                onChange={(event) => update({ authKey: event.target.value })}
              />
            )
          }
        </Field>

        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {(
            [
              ['acceptRoutes', '接受子网路由'],
              ['udp', 'UDP 转发'],
              ['ephemeral', '临时节点'],
              ['exitNodeAllowLanAccess', '出口节点下仍可访问局域网'],
            ] as const
          ).map(([field, label]) => (
            <label key={field} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm text-ink">{label}</span>
              <Switch
                checked={form[field]}
                onCheckedChange={(checked) => update({ [field]: checked })}
                label={label}
              />
            </label>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="控制服务器" optional hint="自建 Headscale 时填写">
            {(id) => (
              <Input
                id={id}
                mono
                value={form.controlUrl}
                placeholder="https://controlplane.tailscale.com"
                onChange={(event) => update({ controlUrl: event.target.value })}
              />
            )}
          </Field>
          <Field label="出口节点" optional hint="tailnet 中某台设备的名字">
            {(id) => (
              <Input
                id={id}
                mono
                value={form.exitNode}
                onChange={(event) => update({ exitNode: event.target.value })}
              />
            )}
          </Field>
          <Field label="状态目录" optional hint="留空则按实例 id 生成稳定默认值">
            {(id) => (
              <Input
                id={id}
                mono
                value={form.stateDir}
                placeholder="自动生成"
                onChange={(event) => update({ stateDir: event.target.value })}
              />
            )}
          </Field>
          <Field label="策略组名" optional hint="留空则按实例 id 生成">
            {(id) => (
              <Input
                id={id}
                mono
                value={form.groupName}
                placeholder="自动生成"
                onChange={(event) => update({ groupName: event.target.value })}
              />
            )}
          </Field>
          <Field label="节点名" optional hint="留空则用 ts-<hostname>">
            {(id) => (
              <Input
                id={id}
                mono
                value={form.nodeName}
                placeholder="自动生成"
                onChange={(event) => update({ nodeName: event.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Additional instances of one device: list, add, edit, delete. */
export function AdditionalInstances({
  profileId,
  device,
  isTemplate,
}: {
  profileId: string;
  device: { id: string; name: string };
  isTemplate: boolean;
}) {
  const key = keys.scoped(profileId, `device-ts-instances:${device.id}`);
  const query = useQuery<InstanceSummary>(key, () =>
    api.get<InstanceSummary>(
      `/profiles/${profileId}/devices/${device.id}/features/tailscale/instances`,
    ),
  );
  const [editing, setEditing] = useState<{ instance: PublicTailscaleDeviceFeature | null } | null>(
    null,
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const instances = query.data?.instances ?? [];

  const reload = () => {
    void query.refetch();
    refreshProfile(profileId);
  };

  const remove = async (instance: PublicTailscaleDeviceFeature) => {
    if (!instance.id) return;
    const ok = await confirmAction({
      title: `删除 Tailscale 实例「${instance.hostname}」？`,
      description:
        '它的节点、策略组与「目标 IP + 端口」规则会从这台设备的配置中移除；原实例和其它附加实例不受影响。密钥一并删除且不可恢复。',
      confirmText: '确认删除',
      confirmHint: '删除该附加 Tailscale 实例及其密钥',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyId(instance.id);
    try {
      await api.del(
        `/profiles/${profileId}/devices/${device.id}/features/tailscale/instances/${instance.id}`,
      );
      notify.success('已删除 Tailscale 实例');
      reload();
    } catch (error) {
      notify.error(error, '删除实例失败');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">附加实例</p>
          <p className="text-xs leading-relaxed text-ink-3">
            同一台设备可以再接多个内嵌 Tailscale，各自接管不同的「目标 IP +
            端口」。原实例始终单独管理，不会被替换。
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          icon={Plus}
          disabled={isTemplate || query.isLoading}
          onClick={() => setEditing({ instance: null })}
        >
          新增实例
        </Button>
      </div>

      {isTemplate ? (
        <p className="text-xs text-ink-3">模版不保存 Tailscale 身份。</p>
      ) : query.error && !query.data ? (
        <div className="flex items-center gap-2 text-xs text-bad">
          <CircleAlert size={14} />
          <span className="min-w-0 flex-1">{errorMessage(query.error)}</span>
        </div>
      ) : !query.data ? (
        <Skeleton className="h-14" />
      ) : instances.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line-strong px-3 py-3 text-xs text-ink-3">
          还没有附加实例。
        </p>
      ) : (
        <DataView
          label="Tailscale 附加实例"
          summary={`共 ${instances.length} 个附加实例`}
          items={instances.map((i) => ({
            value: i.id ?? i.hostname,
            label: `${i.hostname} · ${i.hasAuthKey ? '密钥已设置' : '无密钥'}${(i.serviceRoutes?.length ?? 0) > 0 ? ` · ${(i.serviceRoutes ?? []).map(formatServiceRoute).join(', ')}` : ''}`,
          }))}
        >
          <ul className="flex flex-col gap-2">
            {instances.map((instance) => (
              <li
                key={instance.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-2/60 px-3 py-2"
              >
                <Server size={13} className="shrink-0 text-ink-3" />
                <span className="font-mono text-xs text-ink">{instance.hostname}</span>
                {instance.hasAuthKey ? (
                  <Badge tone="ok">密钥已设置</Badge>
                ) : (
                  <Badge tone="warn">无密钥</Badge>
                )}
                <div className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {(instance.serviceRoutes ?? []).map((route) => (
                    <Badge key={`${route.ip}:${route.port}`} mono tone="outline">
                      {formatServiceRoute(route)}
                    </Badge>
                  ))}
                </div>
                <Button size="xs" variant="ghost" onClick={() => setEditing({ instance })}>
                  编辑
                </Button>
                <Button
                  size="xs"
                  variant="danger-ghost"
                  icon={Trash2}
                  loading={busyId === instance.id}
                  aria-label={`删除实例 ${instance.hostname}`}
                  onClick={() => void remove(instance)}
                />
              </li>
            ))}
          </ul>
        </DataView>
      )}

      {(query.data?.warnings ?? []).map((warning) => (
        <p
          key={warning}
          className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn"
        >
          {warning}
        </p>
      ))}

      {editing && (
        <InstanceEditor
          profileId={profileId}
          deviceId={device.id}
          deviceName={device.name}
          instance={editing.instance}
          nextIndex={instances.length + 1}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={reload}
        />
      )}
    </div>
  );
}

/** Human-readable hint for a route's address family, used in the legacy switch. */
export function routeFamilyLabel(value: string): string {
  const family = ipLiteralFamily(value);
  return family === 4 ? 'IPv4' : family === 6 ? 'IPv6' : '未知';
}
