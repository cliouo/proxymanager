'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { useProfiles } from '@/components/profile/ProfileContext';
import { useToast } from '@/components/ui/Toast';
import { NewDeviceModal, diffCountLabel, type DeviceRecord } from '@/components/devices';
import { TEMPLATE_NOT_DISTRIBUTABLE, isTemplateProfile } from '@/lib/profiles/kind';
import styles from '../profiles/profiles.module.css';

/**
 * 设备页 —— 当前配置文件的设备工作台(作用域与 /base、/rules 一致)。
 *
 * 心智模型:配置文件是底,每台设备 = 底 + 几张差异贴纸。这里管列表、新建、
 * 删除与订阅链接;单台设备的差异与 Tailscale 在它的详情页编辑。
 * 旧版共享 base 里的 Tailscale 遗留在此提示迁移(原 /scenarios/tailscale 页并入)。
 */

const TOKEN_MASK = '••••••••';

interface LegacyTailscale {
  nodes: Array<{ name: string; hostname?: string }>;
  groups: Array<{ id: string }>;
  rules: Array<{ id: string }>;
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
  const [busyId, setBusyId] = useState<string | null>(null);
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
        // 仅为「旧版共享 Tailscale 待迁移」提示;拉不到就不提示,不挡页面。
        api<{ data: { legacy: LegacyTailscale } }>(
          `/api/v1/scenarios/tailscale?profile=${encodeURIComponent(activeProfile.name)}`,
        ).catch(() => null),
      ]);
      if (requestId !== requestSequence.current) return;
      setDevices(list.data);
      setSubBase(meta?.data.subBase ?? null);
      setLegacy(summary?.data.legacy ?? null);
    } catch (e) {
      if (requestId !== requestSequence.current) return;
      setError(e instanceof ApiError ? e.message : '设备加载失败');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = useCallback(
    async (device: DeviceRecord) => {
      if (!activeProfile) return;
      if (
        !confirm(
          `确认删除设备「${device.name}」？\n\n它的订阅链接会立即 404 —— 已经在用这条链接的客户端将拉不到配置。此操作不可撤销。`,
        )
      ) {
        return;
      }
      setBusyId(device.id);
      setError(null);
      try {
        await api(`/api/v1/profiles/${activeProfile.id}/devices/${device.id}`, {
          method: 'DELETE',
        });
        toast(`已删除设备「${device.name}」`);
        void reload();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [activeProfile, reload, toast],
  );

  // 共享链接(不含设备差异)。设备行只放「复制」,不逐行铺 URL。
  const { sharedRealUrl, sharedShownUrl } = useMemo(() => {
    if (!activeProfile) return { sharedRealUrl: '', sharedShownUrl: '' };
    const path = `/${encodeURIComponent(activeProfile.name)}`;
    if (!subBase) return { sharedRealUrl: '', sharedShownUrl: `…/api/sub/${TOKEN_MASK}${path}` };
    const real = `${subBase}${path}`;
    if (reveal) return { sharedRealUrl: real, sharedShownUrl: real };
    const cut = subBase.lastIndexOf('/');
    return { sharedRealUrl: real, sharedShownUrl: `${subBase.slice(0, cut)}/${TOKEN_MASK}${path}` };
  }, [activeProfile, subBase, reveal]);

  const deviceUrl = useCallback(
    (device: DeviceRecord) =>
      subBase && activeProfile
        ? `${subBase}/${encodeURIComponent(activeProfile.name)}/${encodeURIComponent(device.name)}`
        : '',
    [subBase, activeProfile],
  );

  const copyDeviceUrl = useCallback(
    async (device: DeviceRecord) => {
      const url = deviceUrl(device);
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        toast(`已复制设备「${device.name}」的订阅链接`);
      } catch {
        toast('复制失败');
      }
    },
    [deviceUrl, toast],
  );

  const tailscaleCount = devices.filter((d) => d.features?.tailscale).length;

  return (
    <>
      <PageTopbar>
        <h1>设备</h1>
        <ScopePill />
        {!loading && devices.length > 0 && (
          <span className="crumb">
            {devices.length} 台{tailscaleCount > 0 ? ` · Tailscale ×${tailscaleCount}` : ''}
          </span>
        )}
        {isTemplate && <span className="pill acc plain">{TEMPLATE_NOT_DISTRIBUTABLE}</span>}
        <div className="grow" />
        <button
          type="button"
          className="btn primary"
          onClick={() => setCreating(true)}
          disabled={!activeProfile || loading}
        >
          ＋ 添加设备
        </button>
      </PageTopbar>

      {error && <div className={styles.errBanner}>{error}</div>}

      <div style={{ display: 'grid', gap: 18, maxWidth: 980 }}>
        {/* 旧版共享 Tailscale —— 迁移提示(原 /scenarios/tailscale 总览页并入) */}
        {legacy && legacy.nodes.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <h2>发现旧版共享 Tailscale</h2>
              <span className="pill warn">待迁移</span>
            </div>
            <div className="panel-body">
              <div className={styles.srcNote} style={{ marginTop: 0 }}>
                <span className="g">⚠</span>
                <span>
                  共享 base 仍含 {legacy.nodes.length} 个 Tailscale 节点(
                  {legacy.nodes.map((n) => n.name).join('、')}
                  )。为避免两套产物并存,设备级接入会被预检拦截 —— 请用{' '}
                  <span className="mono">migrate:tailscale-device</span> 指定目标设备,先 dry-run
                  再迁移;迁移不会在页面后台自动发生。
                </span>
              </div>
            </div>
          </section>
        )}

        {/* 设备列表 */}
        <section className="panel">
          <div className="panel-body">
            {!profilesLoaded || (loading && devices.length === 0 && !error) ? (
              <div className={styles.srcNote} style={{ marginTop: 0 }}>
                <span className="g">⋯</span>
                <span>加载设备…</span>
              </div>
            ) : !activeProfile ? (
              <div className={styles.srcNote} style={{ marginTop: 0 }}>
                <span className="g">▪</span>
                <span>尚未选择配置文件。</span>
              </div>
            ) : error && devices.length === 0 ? (
              // 拉取失败时状态未知 —— 不能落进「还没有设备」的空态引导。
              <div className={styles.srcNote} style={{ marginTop: 0 }}>
                <span className="g">⚠</span>
                <span>设备列表加载失败,请刷新重试。</span>
              </div>
            ) : devices.length === 0 ? (
              <div className={styles.srcNote} style={{ marginTop: 0 }}>
                <span className="g">▪</span>
                <span>
                  还没有设备。<b>共享配置服务所有设备</b>
                  ;当同一份配置要发给多台机器、而它们之间只有少量差异(控制器端口、密钥、
                  面板目录、进程匹配、Tailscale…),给每台建一个<b>设备</b>
                  ,只写差异即可 —— 共享层改一次,全设备生效。
                  <br />
                  差异太大(比如策略组成员就该不同)说明那是<b>另一份配置文件</b>
                  ,请用克隆而不是设备。
                </span>
              </div>
            ) : (
              devices.map((device) => {
                const tailscale = device.features?.tailscale;
                return (
                  <div key={device.id} className={styles.dangerRow} style={{ marginBottom: 10 }}>
                    <div className="gw">
                      <b className="mono">{device.name}</b>
                      <span>
                        {diffCountLabel(device)}
                        {tailscale
                          ? ` · Tailscale ${tailscale.hasAuthKey ? '已配置' : '未提供密钥'}(${tailscale.hostname})`
                          : ''}
                        {device.display_name ? ` · 显示名 ${device.display_name}` : ''}
                        {device.notes ? ` · ${device.notes}` : ''}
                      </span>
                    </div>
                    {!isTemplate && (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void copyDeviceUrl(device)}
                        disabled={!subBase}
                        title="共享配置 + 该设备差异的订阅链接"
                      >
                        复制链接
                      </button>
                    )}
                    <Link
                      className="btn sm"
                      href={`/profiles/${activeProfile.id}/devices/${device.id}`}
                      title="设备的差异清单、Tailscale 与生效预览"
                    >
                      设置
                    </Link>
                    <button
                      type="button"
                      className="btn sm danger"
                      onClick={() => void remove(device)}
                      disabled={busyId === device.id}
                    >
                      {busyId === device.id ? '删除中 …' : '删除'}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* 共享链接 —— 不含任何设备差异;设备各用各的链接(行内复制)。 */}
        {activeProfile &&
          (isTemplate ? (
            <div className={styles.srcNote}>
              <span className="g">⊘</span>
              <span>
                这是<b>模版</b>,{TEMPLATE_NOT_DISTRIBUTABLE}
                ,这些设备没有订阅链接;它们会随「从模版新建」拷贝到新配置文件,在那里下发。
              </span>
            </div>
          ) : (
            <section className="panel">
              <div className="panel-head">
                <h2>共享订阅链接</h2>
                <span className="crumb">不含设备差异</span>
              </div>
              <div className="panel-body">
                <div className="dist-url">
                  <code>{sharedShownUrl}</code>
                  <button
                    type="button"
                    className="urlbtn"
                    onClick={() => setReveal((v) => !v)}
                    title="显示 / 隐藏令牌"
                  >
                    {reveal ? '隐藏' : '显示'}
                  </button>
                  <button
                    type="button"
                    className="urlbtn"
                    disabled={!sharedRealUrl}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(sharedRealUrl);
                        toast('已复制共享订阅链接');
                      } catch {
                        toast('复制失败 · 请点「显示」后手动选取');
                      }
                    }}
                  >
                    复制
                  </button>
                </div>
                <div className={styles.srcNote} style={{ marginTop: 12 }}>
                  <span className="g">⇲</span>
                  <span>
                    客户端要取得某台设备的差异与 Tailscale,必须用该设备自己的链接(行内「复制链接」);
                    共享链接永远只下发共享层。两者共用同一把令牌,轮换时一起失效。
                  </span>
                </div>
              </div>
            </section>
          ))}
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
