'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { DEVICE_PRESETS, buildPresetPatch, type DevicePreset } from '@/lib/profiles/devicePresets';
import { useToast } from '@/components/ui/Toast';
import { TEMPLATE_NOT_DISTRIBUTABLE } from '@/lib/profiles/kind';
import styles from '../../profiles.module.css';

/**
 * 「设备」面板 —— 配置文件设置页的第五块（订阅链接之后）。
 *
 * 心智模型一句话写在面板顶部：共享配置服务所有设备，每台设备只叠加少量差异。
 * 零设备时这里只有一句引导 + 一个按钮，其余一切照旧 —— 这是向后兼容的锚点。
 */

export interface DeviceRecord {
  id: string;
  name: string;
  display_name?: string;
  notes?: string;
  base_patch: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export function DevicePanel({
  profileId,
  profileName,
  devices,
  loading,
  distributable = true,
  onChanged,
}: {
  profileId: string;
  profileName: string;
  devices: DeviceRecord[];
  loading: boolean;
  /**
   * false = 这份配置文件不对外分发（模版）。设备照常增删改 —— 它们会随
   * 「从模版新建」拷贝过去 —— 只是这里不承诺任何可用的订阅链接。
   */
  distributable?: boolean;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const remove = useCallback(
    async (device: DeviceRecord) => {
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
        await api(`/api/v1/profiles/${profileId}/devices/${device.id}`, { method: 'DELETE' });
        toast(`已删除设备「${device.name}」`);
        onChanged();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '删除失败');
      } finally {
        setBusyId(null);
      }
    },
    [profileId, onChanged, toast],
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>设备</h2>
        {!loading && devices.length > 0 && <span className="crumb">{devices.length} 台</span>}
        {!distributable && <span className="pill acc plain">{TEMPLATE_NOT_DISTRIBUTABLE}</span>}
        <div className={styles.grow} />
        <button
          type="button"
          className="btn sm"
          onClick={() => setCreating(true)}
          disabled={loading}
        >
          ＋ 添加设备
        </button>
      </div>
      <div className="panel-body">
        {error && <div className={styles.errBanner}>{error}</div>}

        {loading ? (
          <div className={styles.srcNote} style={{ marginTop: 0 }}>
            <span className="g">⋯</span>
            <span>加载设备…</span>
          </div>
        ) : devices.length === 0 ? (
          <div className={styles.srcNote} style={{ marginTop: 0 }}>
            <span className="g">▪</span>
            <span>
              还没有设备。<b>共享配置服务所有设备</b>
              ；当同一份配置要发给多台机器、而它们之间只有少量差异（控制器端口、密钥、
              面板目录、进程匹配…），给每台建一个<b>设备</b>
              ，只写差异即可 —— 共享层改一次，全设备生效。
              <br />
              差异太大（比如策略组成员就该不同）说明那是<b>另一份配置文件</b>
              ，请用克隆而不是设备。
            </span>
          </div>
        ) : (
          <>
            <div className={styles.srcNote} style={{ marginTop: 0, marginBottom: 14 }}>
              <span className="g">▪</span>
              <span>
                共享配置服务所有设备；每台设备在它之上叠加自己的几项差异。
                {distributable ? (
                  <>设备的订阅链接见上方「订阅链接」面板。</>
                ) : (
                  <>
                    这是<b>模版</b>，{TEMPLATE_NOT_DISTRIBUTABLE}
                    ，所以这些设备<b>没有订阅链接</b>；它们会随「从模版新建」一起拷贝到新
                    配置文件，在那里才对外下发。
                  </>
                )}
              </span>
            </div>
            {devices.map((device) => (
              <div key={device.id} className={styles.dangerRow} style={{ marginBottom: 10 }}>
                <div className="gw">
                  <b className="mono">{device.name}</b>
                  <span>
                    {diffCountLabel(device)}
                    {device.display_name ? ` · 显示名 ${device.display_name}` : ''}
                    {device.notes ? ` · ${device.notes}` : ''}
                  </span>
                </div>
                <Link
                  className="btn sm"
                  href={`/profiles/${profileId}/devices/${device.id}`}
                  title="设备的差异清单与生效预览"
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
            ))}
          </>
        )}
      </div>

      {creating && (
        <NewDeviceModal
          profileId={profileId}
          profileName={profileName}
          existing={devices}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** 「N 项差异」—— 顶层键的个数就是用户心里的「贴纸张数」。 */
export function diffCountLabel(device: DeviceRecord): string {
  const n = Object.keys(device.base_patch ?? {}).length;
  return n === 0 ? '无差异 · 与共享配置完全一致' : `${n} 项差异`;
}

function NewDeviceModal({
  profileId,
  profileName,
  existing,
  onClose,
  onCreated,
}: {
  profileId: string;
  profileName: string;
  existing: DeviceRecord[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const fid = useId();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [preset, setPreset] = useState<DevicePreset>(DEVICE_PRESETS[0]);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const nameValid = /^[a-z0-9-]+$/.test(name.trim());
  const duplicate = useMemo(() => existing.some((d) => d.name === name.trim()), [existing, name]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !pending) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const submit = useCallback(async () => {
    setErr(null);
    const n = name.trim();
    if (!n) return setErr('请填写设备名称');
    if (!nameValid) return setErr('名称只能用小写字母、数字与连字符（-）');
    if (duplicate) return setErr('该配置文件下已有同名设备');
    setPending(true);
    try {
      await api(`/api/v1/profiles/${profileId}/devices`, {
        method: 'POST',
        body: {
          name: n,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          base_patch: buildPresetPatch(preset),
        },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
      setPending(false);
    }
  }, [name, nameValid, duplicate, displayName, preset, profileId, onCreated]);

  const previewKeys = useMemo(() => Object.keys(preset.patch), [preset]);

  return (
    <div className="modal-bg open" onClick={() => !pending && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加设备</h3>
        <p className="sub">
          设备 = 这份配置 + 几项差异。名称会进订阅链接：
          <span className="mono">
            /{profileName}/{name.trim() || '…'}
          </span>
        </p>

        <div className="field">
          <label htmlFor={`${fid}-name`}>名称</label>
          <input
            id={`${fid}-name`}
            className="input mono"
            value={name}
            placeholder="例如：home-server"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <div className="hint">小写字母、数字与连字符；同一配置文件内唯一。</div>
        </div>

        <div className="field">
          <label htmlFor={`${fid}-display`}>
            订阅显示名 <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· 可选</span>
          </label>
          <input
            id={`${fid}-display`}
            className="input"
            value={displayName}
            placeholder={`默认：proxymanager-${profileName}-${name.trim() || 'device'}`}
            maxLength={120}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="field">
          <label>
            类型预设{' '}
            <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
              · 只是替你预填几项差异，之后随便改
            </span>
          </label>
          <div className="seg" role="tablist">
            {DEVICE_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`opt${preset.id === p.id ? ' on' : ''}`}
                onClick={() => setPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 8 }}>
            {preset.blurb}
            {previewKeys.length > 0 && (
              <>
                {' '}
                预填：
                <span className="mono">{previewKeys.join('、')}</span>
                {preset.needsSecret && (
                  <>
                    、<span className="mono">secret</span>（随机生成）
                  </>
                )}
              </>
            )}
          </div>
        </div>

        {err && <div className={styles.errBanner}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            aria-busy={pending || undefined}
            disabled={pending || !name.trim()}
          >
            {pending ? '创建中 …' : '创建设备'}
          </button>
        </div>
      </div>
    </div>
  );
}
