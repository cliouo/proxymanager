'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { DEVICE_PRESETS, buildPresetPatch, type DevicePreset } from '@/lib/profiles/devicePresets';
import type { PublicDeviceFeatures } from '@/schemas';
import styles from '@/app/(authed)/profiles/profiles.module.css';

/**
 * 设备层共享 UI:类型、差异计数、新建弹窗。
 * 设备列表在 /devices 页(当前配置文件作用域),设备详情在
 * /profiles/[id]/devices/[deviceId];两处与配置文件设置页共用这里的定义。
 */

export interface DeviceRecord {
  id: string;
  name: string;
  display_name?: string;
  notes?: string;
  base_patch: Record<string, unknown>;
  features?: PublicDeviceFeatures;
  created_at: number;
  updated_at: number;
}

/** 「N 项差异」—— 顶层键的个数就是用户心里的「贴纸张数」。 */
export function diffCountLabel(device: DeviceRecord): string {
  const n = Object.keys(device.base_patch ?? {}).length;
  return n === 0 ? '无差异 · 与共享配置完全一致' : `${n} 项差异`;
}

export function NewDeviceModal({
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
