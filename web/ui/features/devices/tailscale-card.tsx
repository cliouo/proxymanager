'use client';

import { useState } from 'react';
import { ChevronDown, CircleAlert, KeyRound, Network, RefreshCw, Trash2 } from 'lucide-react';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@ui-sdk/react/collapsible';
import { api, errorMessage } from '@/ui/data/api';
import { keys, refreshProfile } from '@/ui/data/hooks';
import { useQuery } from '@/ui/data/query';
import type { PublicDevice, PublicTailscaleDeviceFeature, TailscaleDeviceFeatureUpdate } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  confirmAction,
  Field,
  Input,
  notify,
  SegmentedControl,
  Skeleton,
  Switch,
  TagInput,
} from '@/ui/primitives';
import { AdditionalInstances, ServiceRouteEditor } from './tailscale-instances';
import {
  EMPTY_ROUTE,
  draftsToRoutes,
  routeSetError,
  routeToDraft,
  type ServiceRouteDraft,
} from './tailscale-model';

interface TailscaleResult {
  feature: PublicTailscaleDeviceFeature | null;
  warnings: string[];
}

interface Form {
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
  extraCidrs: string[];
  nodeName: string;
  groupName: string;
  /** `cidr` routes the whole tailnet; `service` routes only the listed pairs. */
  routeMode: 'cidr' | 'service';
  routes: ServiceRouteDraft[];
}

const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

function fromFeature(feature: PublicTailscaleDeviceFeature | null, deviceName: string): Form {
  return {
    hostname: feature?.hostname ?? deviceName.slice(0, 63),
    authKey: '',
    authMode: feature?.hasAuthKey ? 'keep' : 'set',
    controlUrl: feature?.controlUrl ?? '',
    stateDir: feature?.stateDir ?? '',
    ephemeral: feature?.ephemeral ?? false,
    acceptRoutes: feature?.acceptRoutes ?? true,
    udp: feature?.udp ?? true,
    exitNode: feature?.exitNode ?? '',
    exitNodeAllowLanAccess: feature?.exitNodeAllowLanAccess ?? false,
    extraCidrs: feature?.extraCidrs ?? [],
    nodeName: feature?.nodeName ?? '',
    groupName: feature?.groupName ?? '',
    routeMode: feature?.routeMode === 'service' ? 'service' : 'cidr',
    routes:
      feature?.serviceRoutes && feature.serviceRoutes.length > 0
        ? feature.serviceRoutes.map(routeToDraft)
        : [EMPTY_ROUTE],
  };
}

function toPayload(form: Form): TailscaleDeviceFeatureUpdate {
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return {
    hostname: form.hostname.trim(),
    controlUrl: opt(form.controlUrl),
    stateDir: opt(form.stateDir),
    ephemeral: form.ephemeral,
    acceptRoutes: form.acceptRoutes,
    udp: form.udp,
    exitNode: opt(form.exitNode),
    exitNodeAllowLanAccess: form.exitNodeAllowLanAccess,
    // Switching back to CIDR is an explicit `null`, never an empty list: the
    // server must never widen routing just because a list became empty.
    ...(form.routeMode === 'service'
      ? { serviceRoutes: draftsToRoutes(form.routes) }
      : { serviceRoutes: null, extraCidrs: form.extraCidrs }),
    nodeName: opt(form.nodeName),
    groupName: opt(form.groupName),
    ...(form.authMode === 'set' && form.authKey.trim()
      ? { authKey: form.authKey.trim() }
      : form.authMode === 'clear'
        ? { authKey: null }
        : {}),
  };
}

export function cidrError(value: string): string | null {
  const [ip, prefix, ...rest] = value.split('/');
  if (rest.length || prefix === undefined || !/^\d{1,3}$/.test(prefix)) return '格式应为 地址/前缀，例如 192.168.1.0/24';
  const bits = Number(prefix);
  if (ip.includes(':')) {
    if (!/^[0-9a-fA-F:]+$/.test(ip) || bits > 128) return '不是合法的 IPv6 网段';
    return null;
  }
  const octets = ip.split('.');
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255) || bits > 32) {
    return '不是合法的 IPv4 网段';
  }
  return null;
}

function formErrors(form: Form) {
  const errors: Partial<Record<keyof Form, string>> = {};
  if (!form.hostname.trim()) errors.hostname = '请填写 hostname';
  else if (form.hostname.trim().length > 63 || !HOSTNAME_RE.test(form.hostname.trim())) {
    errors.hostname = '只能含字母、数字和中划线，且不能以中划线开头或结尾';
  }
  if (form.controlUrl.trim()) {
    try {
      const url = new URL(form.controlUrl.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') errors.controlUrl = '只支持 http 或 https';
    } catch {
      errors.controlUrl = '不是合法的网址';
    }
  }
  if (form.authMode === 'set' && /\s/.test(form.authKey.trim())) errors.authKey = '密钥不能包含空白';
  return errors;
}

/** Route-set level error (empty list / duplicate destination) for the service mode. */
function serviceRoutesError(form: Form): string | null {
  return form.routeMode === 'service' ? routeSetError(form.routes) : null;
}

export function TailscaleCard({
  profileId,
  device,
  isTemplate,
}: {
  profileId: string;
  device: PublicDevice;
  isTemplate: boolean;
}) {
  const key = keys.scoped(profileId, `device-ts:${device.id}`);
  const query = useQuery<TailscaleResult>(key, () =>
    api.get<TailscaleResult>(`/profiles/${profileId}/devices/${device.id}/features/tailscale`),
  );
  const feature = query.data?.feature ?? null;
  const [form, setForm] = useState<Form | null>(null);
  const [synced, setSynced] = useState<PublicTailscaleDeviceFeature | null | undefined>(undefined);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [tried, setTried] = useState(false);

  // Follow the server copy until the user starts editing.
  if (query.data && feature !== synced) {
    setSynced(feature);
    setForm(feature ? fromFeature(feature, device.name) : null);
    setTried(false);
  }

  const baseline = feature ? fromFeature(feature, device.name) : null;
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(baseline);
  const errors = form ? formErrors(form) : {};
  const routesError = form ? serviceRoutesError(form) : null;
  const hasErrors = Object.keys(errors).length > 0 || !!routesError;
  const update = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const save = async () => {
    if (!form) return;
    setTried(true);
    if (hasErrors) return;
    setBusy('save');
    try {
      const result = await api.put<TailscaleResult>(
        `/profiles/${profileId}/devices/${device.id}/features/tailscale`,
        toPayload(form),
      );
      query.mutate(result);
      refreshProfile(profileId);
      notify.success(feature ? '已更新 Tailscale' : '已启用 Tailscale', '客户端下次更新订阅时生效');
      for (const warning of result.warnings) notify.warn('请留意', warning);
    } catch (error) {
      notify.error(error, '保存 Tailscale 失败');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: '移除这台设备的 Tailscale？',
      description: '移除后它的配置里不再包含 Tailscale 节点、策略组和 tailnet 路由规则。密钥也会一并删除。',
      confirmText: '确认移除',
      confirmHint: '移除后配置中不再包含 Tailscale 节点和路由规则',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.del(`/profiles/${profileId}/devices/${device.id}/features/tailscale`);
      query.mutate({ feature: null, warnings: [] });
      refreshProfile(profileId);
      notify.success('已移除 Tailscale');
    } catch (error) {
      notify.error(error, '移除失败');
    } finally {
      setBusy(null);
    }
  };

  const shownError = (field: keyof Form) => (tried || field === 'hostname' ? errors[field] : undefined);

  return (
    <Card className="animate-rise [animation-delay:120ms]">
      <CardHeader
        icon={Network}
        title="Tailscale"
        description="让这台设备经由 Tailscale 访问你的私有网络（tailnet）"
        actions={feature ? <Badge tone="accent">已启用 · {feature.hostname}</Badge> : form ? <Badge tone="warn">未保存</Badge> : null}
      />
      <div className="border-t border-line px-4 py-4">
        {isTemplate ? (
          <p className="text-xs leading-relaxed text-ink-3">模版不保存设备身份。请从模版新建配置文件后，再在具体设备上启用 Tailscale。</p>
        ) : query.error && !query.data ? (
          <div className="flex items-center gap-2 text-xs text-bad">
            <CircleAlert size={14} />
            <span className="min-w-0 flex-1">{errorMessage(query.error)}</span>
            <Button size="sm" icon={RefreshCw} onClick={() => void query.refetch()}>
              重试
            </Button>
          </div>
        ) : !query.data ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-8" />
          </div>
        ) : !form ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-sm text-xs leading-relaxed text-ink-3">
              启用后，这台设备的配置会多出一个 Tailscale 节点和对应策略组，访问 tailnet 地址的流量自动走它。
            </p>
            <Button size="sm" icon={Network} onClick={() => setForm(fromFeature(null, device.name))}>
              启用 Tailscale
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {(query.data.warnings ?? []).map((warning) => (
              <p key={warning} className="rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
                {warning}
              </p>
            ))}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="主机名 hostname" hint="在 tailnet 里显示的设备名" error={shownError('hostname')}>
                {(id) => (
                  <Input
                    id={id}
                    mono
                    value={form.hostname}
                    invalid={!!shownError('hostname')}
                    onChange={(e) => update({ hostname: e.target.value })}
                  />
                )}
              </Field>
              <Field label="认证密钥" hint="只写不读；留空保持原样" error={shownError('authKey')}>
                {(id) =>
                  form.authMode === 'keep' ? (
                    <div className="flex h-8 items-center gap-2">
                      <Badge tone="ok" icon={KeyRound}>
                        已设置
                      </Badge>
                      <Button size="xs" variant="ghost" onClick={() => update({ authMode: 'set', authKey: '' })}>
                        更换
                      </Button>
                      <Button size="xs" variant="danger-ghost" onClick={() => update({ authMode: 'clear' })}>
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
                      placeholder={feature?.hasAuthKey ? '输入新密钥以替换' : 'tskey-auth-…'}
                      value={form.authKey}
                      onChange={(e) => update({ authKey: e.target.value })}
                    />
                  )
                }
              </Field>
            </div>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {(
                [
                  ['acceptRoutes', '接受子网路由', '使用 tailnet 里其他设备广播的网段'],
                  ['udp', 'UDP 转发', '允许 UDP 流量经由 Tailscale'],
                  ['ephemeral', '临时节点', '断开后自动从 tailnet 移除'],
                  ['exitNodeAllowLanAccess', '出口节点下仍可访问局域网', '使用出口节点时保留本地网络'],
                ] as const
              ).map(([field, label, hint]) => (
                <label key={field} className="flex items-start justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-sm text-ink">{label}</span>
                    <span className="block text-xs text-ink-3">{hint}</span>
                  </span>
                  <Switch checked={form[field]} onCheckedChange={(checked) => update({ [field]: checked })} label={label} />
                </label>
              ))}
            </div>
            <Field label="出口节点" optional hint="tailnet 中某台设备的 IP 或名称；所有流量从它出去">
              {(id) => (
                <Input id={id} mono value={form.exitNode} placeholder="100.64.0.1" onChange={(e) => update({ exitNode: e.target.value })} />
              )}
            </Field>
            <div className="flex flex-col gap-2">
              <SegmentedControl
                size="sm"
                label="Tailscale 路由模式"
                value={form.routeMode}
                onChange={(routeMode) => update({ routeMode })}
                options={[
                  { value: 'cidr', label: '整个 tailnet' },
                  { value: 'service', label: '只分流指定服务' },
                ]}
              />
              <p className="text-xs leading-relaxed text-ink-3">
                「整个 tailnet」把 100.64.0.0/10（外加下面的网段）都交给这个实例；「只分流指定服务」只接管列出的「目标 IP + 端口」，其余流量沿用共享规则。
              </p>
            </div>
            {form.routeMode === 'cidr' ? (
              <Field label="额外路由网段" optional hint="除 100.64.0.0/10 外，还要经由 Tailscale 访问的网段">
                {() => (
                  <TagInput
                    mono
                    value={form.extraCidrs}
                    onChange={(extraCidrs) => update({ extraCidrs })}
                    validate={cidrError}
                    placeholder="192.168.10.0/24，回车添加"
                  />
                )}
              </Field>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-ink">目标 IP + 端口</p>
                <p className="text-xs text-ink-3">
                  只有这些具体服务走这个实例；清空后需要显式切回「整个 tailnet」，不会自动恢复大范围分流。
                </p>
                <ServiceRouteEditor
                  routes={form.routes}
                  onChange={(routes) => update({ routes })}
                  disabled={busy === 'save'}
                  error={tried ? (routesError ?? undefined) : undefined}
                />
              </div>
            )}
            <Collapsible open={advanced} onOpenChange={setAdvanced}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink">
                <ChevronDown size={13} className={cn('transition-transform', !advanced && '-rotate-90')} />
                高级设置
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="mt-3 grid animate-rise gap-4 sm:grid-cols-2">
                  <Field label="控制服务器" optional hint="自建 Headscale 时填写" error={shownError('controlUrl')}>
                    {(id) => (
                      <Input
                        id={id}
                        mono
                        value={form.controlUrl}
                        invalid={!!shownError('controlUrl')}
                        placeholder="https://controlplane.tailscale.com"
                        onChange={(e) => update({ controlUrl: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="状态目录" optional>
                    {(id) => (
                      <Input
                        id={id}
                        mono
                        value={form.stateDir}
                        placeholder={`./ts-${form.hostname || 'hostname'}`}
                        onChange={(e) => update({ stateDir: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="节点名" optional>
                    {(id) => (
                      <Input
                        id={id}
                        value={form.nodeName}
                        placeholder={`ts-${form.hostname || 'hostname'}`}
                        onChange={(e) => update({ nodeName: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="策略组名" optional>
                    {(id) => (
                      <Input id={id} value={form.groupName} placeholder="Tailscale" onChange={(e) => update({ groupName: e.target.value })} />
                    )}
                  </Field>
                </div>
              </CollapsiblePanel>
            </Collapsible>
            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              {feature ? (
                <Button variant="danger-ghost" size="sm" icon={Trash2} loading={busy === 'delete'} onClick={() => void remove()}>
                  移除 Tailscale
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setForm(null)}>
                  取消
                </Button>
              )}
              <div className="flex-1" />
              {dirty && feature && (
                <Button variant="ghost" size="sm" onClick={() => setForm(baseline)}>
                  放弃修改
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                variant={dirty || !feature ? 'primary' : 'secondary'}
                disabled={!!feature && !dirty}
                loading={busy === 'save'}
                data-agent-confirm
              >
                {feature ? '保存 Tailscale' : '启用并保存'}
              </Button>
            </div>
          </form>
        )}
        {!isTemplate && (
          <div className="mt-4">
            <AdditionalInstances
              profileId={profileId}
              device={{ id: device.id, name: device.name }}
              isTemplate={isTemplate}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
