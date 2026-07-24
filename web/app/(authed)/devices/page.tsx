'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { NavIcon } from '@/components/NavIcon';
import { useProfiles } from '@/components/profile/ProfileContext';
import { useToast } from '@/components/ui/Toast';
import { NewDeviceModal, type DeviceRecord } from '@/components/devices';
import { COMMON_PATCH_KEYS } from '@/lib/profiles/devicePresets';
import { TEMPLATE_NOT_DISTRIBUTABLE, isTemplateProfile } from '@/lib/profiles/kind';
import styles from './devices.module.css';

const TOKEN_MASK = '••••••••';
const PATCH_LABELS = new Map(COMMON_PATCH_KEYS.map((item) => [item.key, item.label]));

interface LegacyTailscale {
  nodes: Array<{ name: string; hostname?: string }>;
  groups: Array<{ id: string }>;
  rules: Array<{ id: string }>;
}

type TailscaleState = {
  label: string;
  detail: string;
  tone: 'idle' | 'warn' | 'ok';
};

function tailscaleState(device: DeviceRecord, isTemplate: boolean): TailscaleState {
  const feature = device.features?.tailscale;
  if (isTemplate) {
    return {
      label: '模版不配置',
      detail: '从模版新建普通配置后再启用',
      tone: 'idle',
    };
  }
  if (!feature) {
    return {
      label: '未配置',
      detail: '需要时可让这台设备接入 Tailnet',
      tone: 'idle',
    };
  }
  if (!feature.hasAuthKey) {
    return {
      label: '待完成',
      detail: `${feature.hostname} · 还没有认证密钥`,
      tone: 'warn',
    };
  }
  return {
    label: '已启用',
    detail: `${feature.hostname} · 可以加入 Tailnet`,
    tone: 'ok',
  };
}

function patchLabels(device: DeviceRecord): string[] {
  return Object.keys(device.base_patch ?? {}).map((key) => PATCH_LABELS.get(key) ?? key);
}

export default function DevicesPage() {
  const { activeProfile, loaded: profilesLoaded } = useProfiles();
  const toast = useToast();

  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [legacy, setLegacy] = useState<LegacyTailscale | null>(null);
  const [subBase, setSubBase] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reveal, setReveal] = useState(false);
  const requestSequence = useRef(0);

  const isTemplate = isTemplateProfile(activeProfile);

  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    if (!activeProfile) {
      setDevices([]);
      setLegacy(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [list, meta, summary] = await Promise.all([
        api<{ data: DeviceRecord[] }>(`/api/v1/profiles/${activeProfile.id}/devices`),
        api<{ data: { subBase: string } }>('/api/v1/meta').catch(() => null),
        api<{ data: { legacy: LegacyTailscale } }>(
          `/api/v1/scenarios/tailscale?profile=${encodeURIComponent(activeProfile.name)}`,
        ).catch(() => null),
      ]);
      if (requestId !== requestSequence.current) return;
      setDevices(list.data);
      setSubBase(meta?.data.subBase ?? null);
      setLegacy(summary?.data.legacy ?? null);
    } catch (cause) {
      if (requestId !== requestSequence.current) return;
      setError(cause instanceof ApiError ? cause.message : '设备加载失败');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => {
    setDevices([]);
    setLegacy(null);
    setReveal(false);
    setError(null);
  }, [activeProfile?.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { sharedRealUrl, sharedShownUrl } = useMemo(() => {
    if (!activeProfile) return { sharedRealUrl: '', sharedShownUrl: '' };
    const path = `/${encodeURIComponent(activeProfile.name)}`;
    if (!subBase) return { sharedRealUrl: '', sharedShownUrl: `…/api/sub/${TOKEN_MASK}${path}` };
    const real = `${subBase}${path}`;
    if (reveal) return { sharedRealUrl: real, sharedShownUrl: real };
    const cut = subBase.lastIndexOf('/');
    return { sharedRealUrl: real, sharedShownUrl: `${subBase.slice(0, cut)}/${TOKEN_MASK}${path}` };
  }, [activeProfile, reveal, subBase]);

  const deviceUrl = useCallback(
    (device: DeviceRecord) =>
      subBase && activeProfile
        ? `${subBase}/${encodeURIComponent(activeProfile.name)}/${encodeURIComponent(device.name)}`
        : '',
    [activeProfile, subBase],
  );

  const copyDeviceUrl = useCallback(
    async (device: DeviceRecord) => {
      const url = deviceUrl(device);
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast(`已复制设备「${device.display_name || device.name}」的订阅链接`);
      } catch {
        toast('复制失败');
      }
    },
    [deviceUrl, toast],
  );

  const copySharedUrl = useCallback(async () => {
    if (!sharedRealUrl) return;
    try {
      await navigator.clipboard.writeText(sharedRealUrl);
      toast('已复制共享订阅链接');
    } catch {
      toast('复制失败，请显示链接后手动复制');
    }
  }, [sharedRealUrl, toast]);

  const tailscaleCount = devices.filter((device) => device.features?.tailscale).length;

  return (
    <>
      <PageTopbar contentMaxWidth={1120}>
        <h1>设备</h1>
        <ScopePill />
        {!loading && devices.length > 0 && (
          <span className="crumb">
            {devices.length} 台{tailscaleCount > 0 ? ` · Tailscale ${tailscaleCount}` : ''}
          </span>
        )}
        {isTemplate && <span className="pill acc plain">{TEMPLATE_NOT_DISTRIBUTABLE}</span>}
        <div className="grow" />
        <button
          type="button"
          className="btn primary"
          onClick={() => setCreating(true)}
          disabled={!activeProfile || loading || (!!error && devices.length === 0)}
        >
          ＋ 添加设备
        </button>
      </PageTopbar>

      <div className={styles.page}>
        <header className={styles.orientation}>
          <div>
            <span className="eyebrow">设备工作台</span>
            <h2>共享一套配置，只记录每台设备不同的地方</h2>
            <p>
              所有设备都从共享配置开始。没有差异时会自动跟随共享配置，设备自己的功能只作用于它的订阅。
            </p>
          </div>
          <div className={styles.equation} aria-label="设备订阅的组成">
            <span>共享配置</span>
            <b>＋</b>
            <span>设备差异</span>
            <b>＋</b>
            <span>设备功能</span>
            <b>＝</b>
            <strong>设备订阅</strong>
          </div>
        </header>

        {!profilesLoaded ? (
          <div className={styles.loadingBlock}>正在读取当前配置…</div>
        ) : !activeProfile ? (
          <section className={styles.emptyState}>
            <span className={styles.emptyMark}>
              <NavIcon name="devices" size={22} />
            </span>
            <div>
              <h2>先选择一个配置文件</h2>
              <p>设备需要挂在具体配置文件下面，才能继承它的基础配置、代理策略和分流规则。</p>
            </div>
          </section>
        ) : (
          <>
            <section className={styles.sharedCard} aria-labelledby="shared-config-title">
              <div className={styles.sharedMain}>
                <span className={styles.sharedMark}>
                  <NavIcon name="config" size={21} />
                </span>
                <div className={styles.sharedCopy}>
                  <span className={styles.sharedEyebrow}>所有设备的起点</span>
                  <h2 id="shared-config-title">共享配置</h2>
                  <p>
                    基础配置、代理策略、分流规则和链式代理都在这里维护，修改一次会同步影响所有设备。
                  </p>
                </div>
                <div className={styles.sharedMetric}>
                  <b>{loading ? '…' : error && devices.length === 0 ? '—' : devices.length}</b>
                  <span>台设备继承</span>
                </div>
                <div className={styles.sharedActions}>
                  <Link className="btn" href="/base">
                    编辑共享配置
                  </Link>
                  {!isTemplate && (
                    <button
                      type="button"
                      className="btn"
                      disabled={!sharedRealUrl}
                      onClick={() => void copySharedUrl()}
                    >
                      复制共享链接
                    </button>
                  )}
                </div>
              </div>

              {isTemplate ? (
                <div className={styles.templateNote}>
                  模版不直接分发。这里的共享配置和设备差异会复制到新配置文件，再由新配置文件生成链接。
                </div>
              ) : (
                <div className={styles.sharedDistribution}>
                  <div>
                    <span>共享订阅链接</span>
                    <small>只包含共享配置，不含任何设备差异或 Tailscale</small>
                  </div>
                  <code>{sharedShownUrl}</code>
                  <button type="button" onClick={() => setReveal((value) => !value)}>
                    {reveal ? '隐藏' : '显示'}
                  </button>
                </div>
              )}
            </section>

            <div className={styles.inheritanceLine}>
              <span aria-hidden="true" />
              <p>下面每台设备都继承共享配置，卡片只展示它不同的部分。</p>
            </div>

            {legacy && legacy.nodes.length > 0 && (
              <aside className={styles.legacyNotice} role="status">
                <span className={styles.legacyIcon}>
                  <NavIcon name="tailscale" size={18} />
                </span>
                <div>
                  <b>{isTemplate ? '模版中发现旧版共享 Tailscale' : '发现旧版共享 Tailscale'}</b>
                  {isTemplate ? (
                    <p>
                      请先用这个模版建立普通配置，再到普通配置的设备页执行迁移。模版本身不保存
                      Tailscale 设备身份。
                    </p>
                  ) : (
                    <p>
                      共享配置里仍有 {legacy.nodes.length}{' '}
                      个旧节点。需要先迁移到具体设备，才能使用新的设备级 Tailscale。
                    </p>
                  )}
                </div>
                {!isTemplate && <code>migrate:tailscale-device</code>}
              </aside>
            )}

            {error && (
              <div className={styles.errorBanner} role="alert">
                <div>
                  <b>设备列表加载失败</b>
                  <span>{error}</span>
                </div>
                <button type="button" className="btn sm" onClick={() => void reload()}>
                  重试
                </button>
              </div>
            )}

            {!(error && devices.length === 0) && (
              <section className={styles.devicesSection} aria-labelledby="device-list-title">
                <div className={styles.sectionHeading}>
                  <div>
                    <h2 id="device-list-title">设备</h2>
                    <p>为某台设备设置少量差异，或启用只属于它的 Tailscale。</p>
                  </div>
                  {!loading && !error && <span>{devices.length} / 16</span>}
                </div>

                {loading && devices.length === 0 && !error ? (
                  <div className={styles.deviceGrid} aria-label="正在加载设备">
                    <div className={styles.skeletonCard} />
                    <div className={styles.skeletonCard} />
                  </div>
                ) : devices.length === 0 && !error ? (
                  <div className={styles.emptyState}>
                    <span className={styles.emptyMark}>
                      <NavIcon name="devices" size={22} />
                    </span>
                    <div>
                      <h3>还没有设备</h3>
                      <p>
                        如果同一份配置要给手机、电脑或服务器使用，只需给它们建立名字，并记录不同的端口、密钥或设备功能。
                      </p>
                    </div>
                    <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                      添加第一台设备
                    </button>
                  </div>
                ) : (
                  <div className={styles.deviceGrid}>
                    {devices.map((device) => (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        profileId={activeProfile.id}
                        isTemplate={isTemplate}
                        canCopy={!!deviceUrl(device)}
                        onCopy={copyDeviceUrl}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      {creating && activeProfile && (
        <NewDeviceModal
          profileId={activeProfile.id}
          profileName={activeProfile.name}
          existing={devices}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

function DeviceCard({
  device,
  profileId,
  isTemplate,
  canCopy,
  onCopy,
}: {
  device: DeviceRecord;
  profileId: string;
  isTemplate: boolean;
  canCopy: boolean;
  onCopy: (device: DeviceRecord) => Promise<void>;
}) {
  const displayName = device.display_name || device.name;
  const labels = patchLabels(device);
  const tailscale = tailscaleState(device, isTemplate);
  const detailHref = `/profiles/${profileId}/devices/${device.id}`;

  return (
    <article className={styles.deviceCard}>
      <header className={styles.deviceHeader}>
        <span className={styles.deviceMark}>{displayName.slice(0, 1).toUpperCase()}</span>
        <div className={styles.deviceIdentity}>
          <h3 className={device.display_name ? undefined : styles.monoName}>{displayName}</h3>
          {device.display_name && <code>{device.name}</code>}
          {device.notes && <p>{device.notes}</p>}
        </div>
        <span className={styles.inheritBadge}>继承共享配置</span>
      </header>

      <div className={styles.capabilities}>
        <Link className={styles.capabilityRow} href={`${detailHref}#differences`}>
          <span className={styles.capabilityIcon}>
            <NavIcon name="base" size={17} />
          </span>
          <span className={styles.capabilityCopy}>
            <span>配置差异</span>
            <strong>{labels.length === 0 ? '无差异' : `${labels.length} 项差异`}</strong>
            <small>
              {labels.length === 0
                ? '完全跟随共享配置'
                : `${labels.slice(0, 3).join('、')}${labels.length > 3 ? ` 等 ${labels.length} 项` : ''}`}
            </small>
          </span>
          <span className={styles.rowArrow} aria-hidden="true">
            ›
          </span>
        </Link>

        <Link className={styles.capabilityRow} href={`${detailHref}#tailscale`}>
          <span className={`${styles.capabilityIcon} ${styles[tailscale.tone]}`}>
            <NavIcon name="tailscale" size={17} />
          </span>
          <span className={styles.capabilityCopy}>
            <span>Tailscale</span>
            <strong>{tailscale.label}</strong>
            <small>{tailscale.detail}</small>
          </span>
          <span className={styles.rowArrow} aria-hidden="true">
            ›
          </span>
        </Link>
      </div>

      <footer className={styles.deviceFooter}>
        {isTemplate ? (
          <span>模版设备不生成订阅链接</span>
        ) : (
          <button
            type="button"
            className="btn ghost sm"
            disabled={!canCopy}
            onClick={() => void onCopy(device)}
          >
            复制订阅链接
          </button>
        )}
        <Link className="btn sm" href={detailHref}>
          查看设备
        </Link>
      </footer>
    </article>
  );
}
