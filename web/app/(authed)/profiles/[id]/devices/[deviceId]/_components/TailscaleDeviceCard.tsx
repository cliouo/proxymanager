'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { useToast } from '@/components/ui/Toast';
import type { PublicTailscaleDeviceFeature } from '@/schemas';
import styles from '../device-detail.module.css';

interface TailscaleFeatureResult {
  feature: PublicTailscaleDeviceFeature | null;
  warnings: string[];
}

interface FormState {
  hostname: string;
  authKey: string;
  clearAuthKey: boolean;
  controlUrl: string;
  stateDir: string;
  nodeName: string;
  groupName: string;
  exitNode: string;
  extraCidrs: string;
  acceptRoutes: boolean;
  udp: boolean;
  ephemeral: boolean;
  exitNodeAllowLanAccess: boolean;
}

function formFrom(feature: PublicTailscaleDeviceFeature | null, deviceName: string): FormState {
  return {
    hostname: feature?.hostname ?? deviceName,
    authKey: '',
    clearAuthKey: false,
    controlUrl: feature?.controlUrl ?? '',
    stateDir: feature?.stateDir ?? '',
    nodeName: feature?.nodeName ?? '',
    groupName: feature?.groupName ?? '',
    exitNode: feature?.exitNode ?? '',
    extraCidrs: feature?.extraCidrs.join('\n') ?? '',
    acceptRoutes: feature?.acceptRoutes ?? true,
    udp: feature?.udp ?? true,
    ephemeral: feature?.ephemeral ?? false,
    exitNodeAllowLanAccess: feature?.exitNodeAllowLanAccess ?? false,
  };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function TailscaleDeviceCard({
  profileId,
  deviceId,
  deviceName,
  initialFeature,
  isTemplate,
  onChanged,
  onDirtyChange,
}: {
  profileId: string;
  deviceId: string;
  deviceName: string;
  initialFeature: PublicTailscaleDeviceFeature | null;
  isTemplate: boolean;
  onChanged: (feature: PublicTailscaleDeviceFeature | null) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [feature, setFeature] = useState(initialFeature);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(() => formFrom(initialFeature, deviceName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFeature(initialFeature);
    if (!editing) setForm(formFrom(initialFeature, deviceName));
  }, [initialFeature, deviceName, editing]);

  useEffect(() => {
    let cancelled = false;
    api<{ data: TailscaleFeatureResult }>(
      `/api/v1/profiles/${profileId}/devices/${deviceId}/features/tailscale`,
    )
      .then(({ data }) => {
        if (cancelled) return;
        setFeature(data.feature);
        setWarnings(data.warnings);
        onChanged(data.feature);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof ApiError ? cause.message : 'Tailscale 状态加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, deviceId, onChanged]);

  const hostnameValid = useMemo(
    () =>
      form.hostname.trim().length <= 63 &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(form.hostname.trim()),
    [form.hostname],
  );
  const formDirty = useMemo(
    () => editing && JSON.stringify(form) !== JSON.stringify(formFrom(feature, deviceName)),
    [deviceName, editing, feature, form],
  );

  useEffect(() => {
    onDirtyChange(formDirty);
  }, [formDirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange(false);
    },
    [onDirtyChange],
  );

  const edit = useCallback(() => {
    setForm(formFrom(feature, deviceName));
    setError(null);
    setEditing(true);
  }, [feature, deviceName]);

  const save = useCallback(async () => {
    if (!hostnameValid) {
      setError('hostname 最多 63 个字符，只能包含字母、数字与中划线，且不能以中划线开头或结尾。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const extraCidrs = [
        ...new Set(
          form.extraCidrs
            .split(/[\n,]/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      const authKey =
        isTemplate || (!form.authKey.trim() && !form.clearAuthKey)
          ? undefined
          : form.clearAuthKey
            ? null
            : form.authKey.trim();
      const response = await api<{ data: TailscaleFeatureResult }>(
        `/api/v1/profiles/${profileId}/devices/${deviceId}/features/tailscale`,
        {
          method: 'PUT',
          body: {
            hostname: form.hostname.trim(),
            ...(authKey !== undefined ? { authKey } : {}),
            ...(optional(form.controlUrl) ? { controlUrl: optional(form.controlUrl) } : {}),
            ...(optional(form.stateDir) ? { stateDir: optional(form.stateDir) } : {}),
            ...(optional(form.nodeName) ? { nodeName: optional(form.nodeName) } : {}),
            ...(optional(form.groupName) ? { groupName: optional(form.groupName) } : {}),
            ...(optional(form.exitNode) ? { exitNode: optional(form.exitNode) } : {}),
            extraCidrs,
            acceptRoutes: form.acceptRoutes,
            udp: form.udp,
            ephemeral: form.ephemeral,
            exitNodeAllowLanAccess: form.exitNodeAllowLanAccess,
          },
        },
      );
      setFeature(response.data.feature);
      setWarnings(response.data.warnings);
      onChanged(response.data.feature);
      setEditing(false);
      toast(feature ? '已更新这台设备的 Tailscale' : '已为这台设备启用 Tailscale');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [deviceId, feature, form, hostnameValid, isTemplate, onChanged, profileId, toast]);

  const disable = useCallback(async () => {
    if (
      !confirm(
        `确认停用设备「${deviceName}」的 Tailscale？\n\n只会移除这台设备渲染时注入的节点、策略组和路由，共享配置与其它设备不受影响。`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ data: TailscaleFeatureResult }>(
        `/api/v1/profiles/${profileId}/devices/${deviceId}/features/tailscale`,
        { method: 'DELETE' },
      );
      setFeature(null);
      setWarnings(response.data.warnings);
      setForm(formFrom(null, deviceName));
      setEditing(false);
      onChanged(null);
      toast('已停用这台设备的 Tailscale');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '停用失败');
    } finally {
      setBusy(false);
    }
  }, [deviceId, deviceName, onChanged, profileId, toast]);

  return (
    <section id="tailscale" className="panel">
      <div className="panel-head">
        <h2>Tailscale</h2>
        <span className={`pill ${feature?.hasAuthKey ? 'ok' : 'idle'}`}>
          {isTemplate
            ? '模版不配置'
            : feature?.hasAuthKey
              ? '本设备已配置'
              : feature
                ? '未提供密钥'
                : '本设备未配置'}
        </span>
        <div className="grow" />
        {!isTemplate && !editing && (
          <button type="button" className="btn sm" onClick={edit} disabled={busy}>
            {feature ? '编辑' : '为此设备配置'}
          </button>
        )}
      </div>

      <div className="panel-body">
        <div className={styles.featureIntro}>
          这是设备功能，不写入共享 base。只有通过
          <b>这台设备的订阅链接</b>
          获取配置时，系统才会注入 Tailscale 节点、单成员策略组和 tailnet 路由。
        </div>

        {error && (
          <div role="alert" className={`${styles.featureFeedback} ${styles.featureError}`}>
            {error}
          </div>
        )}
        {warnings.map((warning) => (
          <div key={warning} role="status" className={styles.featureWarning}>
            {warning}
          </div>
        ))}

        {isTemplate ? (
          <p className={styles.featureParagraph}>
            模版只保留可复用的共享配置与基础设备差异。Tailscale hostname、认证与状态目录
            都属于具体设备，请从模版新建普通配置后再启用。
          </p>
        ) : editing ? (
          <div className={styles.formStack}>
            <div className={styles.formGrid}>
              <div className={`field ${styles.fieldReset}`}>
                <label htmlFor="tailscale-hostname">Tailnet hostname</label>
                <input
                  id="tailscale-hostname"
                  className="input mono"
                  value={form.hostname}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, hostname: event.target.value }))
                  }
                  placeholder={deviceName}
                  autoComplete="off"
                />
                <div className="hint">每台真实设备都应使用独立 hostname。</div>
              </div>
              <div className={`field ${styles.fieldReset}`}>
                <label htmlFor="tailscale-auth-key">
                  Auth key {feature?.hasAuthKey ? '· 已保存' : '· 未设置'}
                </label>
                <input
                  id="tailscale-auth-key"
                  className="input mono"
                  type="password"
                  value={form.authKey}
                  disabled={isTemplate || form.clearAuthKey}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, authKey: event.target.value }))
                  }
                  placeholder={
                    isTemplate
                      ? '模版不保存密钥'
                      : feature?.hasAuthKey
                        ? '留空则保留现有密钥'
                        : 'tskey-auth-…'
                  }
                  autoComplete="new-password"
                />
                <div className="hint">
                  密钥只写入服务端存储，不会从管理 API、预览或审计记录返回。
                </div>
              </div>
            </div>

            {feature?.hasAuthKey && !isTemplate && (
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={form.clearAuthKey}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      clearAuthKey: event.target.checked,
                      authKey: event.target.checked ? '' : current.authKey,
                    }))
                  }
                />
                清除已保存的 auth key，之后由客户端交互登录
              </label>
            )}
            {isTemplate && (
              <p className={styles.featureParagraph}>
                模版可以保存字段结构，但不能保存认证密钥；请从模版建立普通配置后，在具体
                设备中填写。
              </p>
            )}

            <div className={styles.checkGrid}>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={form.acceptRoutes}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, acceptRoutes: event.target.checked }))
                  }
                />
                接受 tailnet 子网路由
              </label>
              <label className={styles.checkRow}>
                <input
                  type="checkbox"
                  checked={form.udp}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, udp: event.target.checked }))
                  }
                />
                允许 UDP
              </label>
            </div>

            <details className={styles.advancedSettings}>
              <summary>高级设置</summary>
              <div className={styles.advancedGrid}>
                <TextField
                  id="tailscale-control-url"
                  label="Control URL"
                  value={form.controlUrl}
                  placeholder="https://controlplane.tailscale.com"
                  onChange={(value) => setForm((current) => ({ ...current, controlUrl: value }))}
                />
                <TextField
                  id="tailscale-state-dir"
                  label="State dir"
                  value={form.stateDir}
                  placeholder={`./ts-${form.hostname || deviceName}`}
                  onChange={(value) => setForm((current) => ({ ...current, stateDir: value }))}
                />
                <TextField
                  id="tailscale-node-name"
                  label="节点名"
                  value={form.nodeName}
                  placeholder={`ts-${form.hostname || deviceName}`}
                  onChange={(value) => setForm((current) => ({ ...current, nodeName: value }))}
                />
                <TextField
                  id="tailscale-group-name"
                  label="策略组名"
                  value={form.groupName}
                  placeholder="Tailscale"
                  onChange={(value) => setForm((current) => ({ ...current, groupName: value }))}
                />
                <TextField
                  id="tailscale-exit-node"
                  label="Exit node"
                  value={form.exitNode}
                  placeholder="100.64.0.9 或节点名"
                  onChange={(value) => setForm((current) => ({ ...current, exitNode: value }))}
                />
                <div className={`field ${styles.fieldReset}`}>
                  <label htmlFor="tailscale-extra-cidrs">额外 CIDR</label>
                  <textarea
                    id="tailscale-extra-cidrs"
                    className="input mono"
                    rows={3}
                    value={form.extraCidrs}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, extraCidrs: event.target.value }))
                    }
                    placeholder={'10.0.0.0/24\nfd7a:115c:a1e0::/48'}
                  />
                  <div className="hint">每行或逗号分隔；100.64.0.0/10 会自动加入。</div>
                </div>
              </div>
              <div className={styles.checkGrid}>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={form.ephemeral}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, ephemeral: event.target.checked }))
                    }
                  />
                  使用临时节点
                </label>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    checked={form.exitNodeAllowLanAccess}
                    disabled={!form.exitNode.trim()}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        exitNodeAllowLanAccess: event.target.checked,
                      }))
                    }
                  />
                  使用 Exit Node 时允许 LAN
                </label>
              </div>
            </details>

            <div className={styles.actionRow}>
              <button
                type="button"
                className="btn sm ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setError(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary sm"
                disabled={busy || !hostnameValid}
                onClick={() => void save()}
              >
                {busy ? '校验并保存中 …' : '保存并预检'}
              </button>
            </div>
          </div>
        ) : feature ? (
          <div className={styles.formStack}>
            <dl className={styles.infoGrid}>
              <Info label="Hostname" value={feature.hostname} mono />
              <Info
                label="Auth key"
                value={feature.hasAuthKey ? '已安全保存' : '未设置，需交互登录'}
              />
              <Info label="Control" value={feature.controlUrl ?? 'Tailscale 官方控制平面'} mono />
              <Info label="State dir" value={feature.stateDir ?? `./ts-${feature.hostname}`} mono />
              <Info
                label="节点 / 策略组"
                value={`${feature.nodeName ?? `ts-${feature.hostname}`} / ${feature.groupName ?? 'Tailscale'}`}
                mono
              />
              <Info
                label="路由"
                value={`100.64.0.0/10${feature.extraCidrs.length ? ` + ${feature.extraCidrs.length} 条` : ''}`}
                mono
              />
            </dl>
            <div className={styles.actionRow}>
              <button
                type="button"
                className="btn sm danger"
                disabled={busy}
                onClick={() => void disable()}
              >
                {busy ? '处理中 …' : '停用本设备 Tailscale'}
              </button>
            </div>
          </div>
        ) : (
          <p className={styles.featureParagraph}>
            这台设备当前只使用共享配置和自己的基础差异。启用后，hostname、auth key 与 state dir
            都属于这台设备，不会影响同一配置文件下的手机、电脑或服务器。
          </p>
        )}
      </div>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={`field ${styles.fieldReset}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="input mono"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
      />
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className={styles.infoItem}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}
