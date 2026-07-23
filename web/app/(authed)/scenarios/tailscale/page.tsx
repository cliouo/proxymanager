'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { useProfiles } from '@/components/profile/ProfileContext';
import { ApiError, api } from '@/lib/client/api';
import type { PublicDeviceFeatures } from '@/schemas';

interface LegacySummary {
  initialized: boolean;
  nodes: Array<{ name: string; hostname?: string; hasAuthKey: boolean }>;
  groups: Array<{ id: string; name: string; managedShape: boolean }>;
  rules: Array<{ id: string; value: string; policy: string; enabled?: boolean }>;
}

interface DeviceSummary {
  id: string;
  name: string;
  display_name?: string;
  basePatchCount: number;
  features: PublicDeviceFeatures;
}

interface Summary {
  profile: { id: string; name: string; kind: 'normal' | 'template' };
  legacy: LegacySummary;
  devices: DeviceSummary[];
}

export default function TailscalePage() {
  const { activeProfile, loaded: profilesLoaded } = useProfiles();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    if (!activeProfile) {
      setSummary(null);
      setLoading(false);
      return;
    }
    setSummary((current) => (current?.profile.id === activeProfile.id ? current : null));
    setLoading(true);
    setError(null);
    try {
      const result = await api<{ data: Summary }>(
        `/api/v1/scenarios/tailscale?profile=${encodeURIComponent(activeProfile.name)}`,
      );
      if (requestId !== requestSequence.current) return;
      setSummary(result.data);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(cause instanceof ApiError ? cause.message : 'Tailscale 状态加载失败');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const configured = useMemo(
    () => summary?.devices.filter((device) => device.features.tailscale) ?? [],
    [summary],
  );

  return (
    <>
      <PageTopbar>
        <h1>Tailscale</h1>
        <ScopePill />
        {summary && (
          <span className="crumb">
            {configured.length}/{summary.devices.length} 台已配置
          </span>
        )}
        <div className="grow" />
        <button type="button" className="btn sm" onClick={() => void reload()} disabled={loading}>
          {loading ? '刷新中 …' : '刷新状态'}
        </button>
      </PageTopbar>

      <div className="grid max-w-5xl gap-[18px]">
        <section className="panel">
          <div className="panel-body">
            <div className="grid gap-5 md:grid-cols-[1.4fr_0.6fr] md:items-center">
              <div>
                <p className="m-0 text-[11px] font-medium uppercase tracking-[0.12em] text-[var(--accent)]">
                  Device-scoped extension
                </p>
                <h2 className="mt-2 text-[22px] font-medium tracking-[-0.02em] text-[var(--fg)]">
                  每台设备一份独立的 Tailscale 身份
                </h2>
                <p className="mt-2 max-w-2xl text-[13px] leading-6 text-[var(--muted)]">
                  共享规则、策略组和节点来源仍由配置文件统一维护。Tailscale 的 hostname、 auth key
                  和 state dir 则挂在具体设备上，只在该设备的订阅产物中注入。
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Metric label="设备" value={String(summary?.devices.length ?? 0)} />
                <Metric label="已配置" value={String(configured.length)} accent />
              </div>
            </div>
          </div>
        </section>

        {error && (
          <div
            role="alert"
            className="rounded-xl border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[var(--danger-dim)] px-4 py-3 text-[12.5px] text-[var(--danger)]"
          >
            {error}
          </div>
        )}

        {summary?.legacy.nodes.length ? (
          <section className="panel">
            <div className="panel-head">
              <h2>发现旧版共享接入</h2>
              <span className="pill warn">待迁移</span>
            </div>
            <div className="panel-body">
              <p className="m-0 text-[12.5px] leading-6 text-[var(--muted)]">
                当前共享 base 仍含 {summary.legacy.nodes.length} 个 Tailscale 节点，并关联{' '}
                {summary.legacy.groups.length} 个策略组、{summary.legacy.rules.length} 条规则。
                为避免同一份配置同时出现两套 Tailscale 产物，设备级接入会被预检拦截。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {summary.legacy.nodes.map((node) => (
                  <span key={node.name} className="pill warn plain">
                    {node.name}
                    {node.hostname ? ` · ${node.hostname}` : ''}
                  </span>
                ))}
              </div>
              <p className="mb-0 mt-3 text-[11.5px] leading-5 text-[var(--faint)]">
                使用 migrate:tailscale-device 明确指定目标配置文件与设备，先 dry-run
                核对，再原子迁移。迁移不会在页面后台自动发生。
              </p>
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-head">
            <h2>设备接入矩阵</h2>
            {summary?.profile.kind === 'template' && (
              <span className="pill acc plain">模版不可分发</span>
            )}
            <div className="grow" />
            {summary && (
              <Link className="btn sm" href={`/profiles/${summary.profile.id}`}>
                管理设备
              </Link>
            )}
          </div>
          <div className="panel-body">
            {!profilesLoaded || (loading && !summary) ? (
              <p className="m-0 text-[12.5px] text-[var(--muted)]">正在读取设备接入状态…</p>
            ) : !activeProfile ? (
              <p className="m-0 text-[12.5px] text-[var(--muted)]">尚未选择配置文件。</p>
            ) : summary?.devices.length === 0 ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-5">
                <p className="m-0 text-[13px] text-[var(--fg-2)]">这份配置还没有设备。</p>
                <p className="mb-4 mt-1 text-[12px] leading-5 text-[var(--muted)]">
                  先建立手机、电脑或服务器设备，再为需要接入 tailnet 的那几台单独启用。
                </p>
                <Link className="btn primary sm" href={`/profiles/${summary.profile.id}`}>
                  添加第一台设备
                </Link>
              </div>
            ) : (
              <div className="grid gap-2">
                {summary?.devices.map((device) => {
                  const tailscale = device.features.tailscale;
                  return (
                    <article
                      key={device.id}
                      className="grid gap-3 rounded-lg border border-[var(--border)] px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,0.8fr)_auto] sm:items-center"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <b className="font-mono text-[13px] text-[var(--fg)]">{device.name}</b>
                          <span className={`pill ${tailscale?.hasAuthKey ? 'ok' : 'idle'}`}>
                            {summary.profile.kind === 'template'
                              ? '不适用'
                              : tailscale?.hasAuthKey
                                ? '已配置'
                                : tailscale
                                  ? '未提供密钥'
                                  : '未配置'}
                          </span>
                        </div>
                        <p className="mb-0 mt-1 truncate text-[11.5px] text-[var(--faint)]">
                          {device.display_name ?? '未设置显示名'} · {device.basePatchCount}{' '}
                          项基础差异
                        </p>
                      </div>
                      <div className="min-w-0 text-[11.5px] leading-5 text-[var(--muted)]">
                        {summary.profile.kind === 'template' ? (
                          <span>从模版新建后，在具体设备上配置</span>
                        ) : tailscale ? (
                          <>
                            <span className="block truncate font-mono text-[var(--fg-2)]">
                              {tailscale.hostname}
                            </span>
                            <span>
                              {tailscale.hasAuthKey ? '密钥已保存' : '无密钥'} ·{' '}
                              {tailscale.extraCidrs.length
                                ? `${tailscale.extraCidrs.length + 1} 个网段`
                                : 'tailnet 网段'}
                            </span>
                          </>
                        ) : (
                          <span>只使用共享配置与基础差异</span>
                        )}
                      </div>
                      <Link
                        className={`btn sm ${tailscale || summary.profile.kind === 'template' ? '' : 'primary'}`}
                        href={`/profiles/${summary.profile.id}/devices/${device.id}#tailscale`}
                      >
                        {summary.profile.kind === 'template'
                          ? '查看设备'
                          : tailscale
                            ? '查看配置'
                            : '去配置'}
                      </Link>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3 text-[11.5px] leading-5 text-[var(--muted)]">
          <b className="text-[var(--fg-2)]">分发边界：</b>
          配置文件的共享订阅链接不会包含任何设备功能。客户端必须使用对应设备的订阅链接，
          才能取得该设备的 Tailscale 实例。
        </div>
      </div>
    </>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
      <span className="block text-[10.5px] text-[var(--faint)]">{label}</span>
      <b
        className={`mt-0.5 block font-mono text-[22px] font-medium ${accent ? 'text-[var(--accent)]' : 'text-[var(--fg)]'}`}
      >
        {value}
      </b>
    </div>
  );
}
