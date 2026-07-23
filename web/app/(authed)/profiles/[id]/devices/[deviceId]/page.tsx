'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parse, stringify } from 'yaml';
import { ApiError, api } from '@/lib/client/api';
import { useUnsavedGuard } from '@/lib/client/useUnsavedGuard';
import { PageTopbar } from '@/components/PageChrome';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { useToast } from '@/components/ui/Toast';
import { COMMON_PATCH_KEYS, randomSecret } from '@/lib/profiles/devicePresets';
import { TEMPLATE_NOT_DISTRIBUTABLE, isTemplateProfile } from '@/lib/profiles/kind';
import { useProfiles } from '@/components/profile/ProfileContext';
import type { DeviceRecord } from '@/components/devices';
import type { PublicTailscaleDeviceFeature } from '@/schemas';
import { TailscaleDeviceCard } from './_components/TailscaleDeviceCard';
import styles from '../../../profiles.module.css';

/**
 * 设备详情页 —— 用户在这里看到的**永远是差异**，不提供「合并后全量编辑」视图。
 *
 * 结构化卡片与 raw 补丁是同一份 base_patch 的两个视图：卡片编辑写进补丁对象，
 * raw 里手写的未知键在卡片区显示为「自定义键」。移除一张卡 = 回退到共享值。
 */

const MANAGED_KEYS = new Set(['proxies', 'proxy-groups', 'rules', 'rule-providers']);
const SENSITIVE_KEYS = new Set([
  'secret',
  'auth-key',
  'authentication',
  'password',
  'private-key',
  'token',
]);
const TOKEN_MASK = '••••••••';

type Patch = Record<string, unknown>;

function isSensitive(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

/** 卡片上显示的值：标量直出，容器给个形状提示，敏感值一律掩码。 */
function displayValue(key: string, value: unknown): string {
  if (isSensitive(key)) return `${TOKEN_MASK}（已设置）`;
  if (value === null) return '（删除该键 · 回到 mihomo 默认）';
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (typeof value === 'object') return `{${Object.keys(value as object).join(', ')}}`;
  return String(value);
}

function labelFor(key: string): string {
  return COMMON_PATCH_KEYS.find((k) => k.key === key)?.label ?? '自定义键';
}

export default function DeviceDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; deviceId: string }>();
  const { id: profileId, deviceId } = params;
  const toast = useToast();
  // 从「设备」页(当前配置文件)进来时返回它;查看非活动配置文件的设备则回其设置页。
  const { activeProfile } = useProfiles();
  const backHref = activeProfile?.id === profileId ? '/devices' : `/profiles/${profileId}`;
  const backLabel = activeProfile?.id === profileId ? '返回设备列表' : '返回配置文件';

  const [device, setDevice] = useState<DeviceRecord | null>(null);
  const [profileName, setProfileName] = useState('');
  // 模版不分发 —— 这台设备的订阅链接必然 404，页面不能装作它可用。
  const [isTemplate, setIsTemplate] = useState(false);
  const [subBase, setSubBase] = useState<string | null>(null);
  const [patch, setPatch] = useState<Patch>({});
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [preview, setPreview] = useState<{ shared: string; device: string | null } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const hydrate = useCallback((d: DeviceRecord) => {
    setDevice(d);
    setPatch(d.base_patch ?? {});
    setRawText(Object.keys(d.base_patch ?? {}).length > 0 ? stringify(d.base_patch) : '');
    setRawError(null);
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [d, p, meta] = await Promise.all([
        api<{ data: DeviceRecord }>(`/api/v1/profiles/${profileId}/devices/${deviceId}`),
        api<{ data: { name: string; kind?: 'normal' | 'template' } }>(
          `/api/v1/profiles/${profileId}`,
        ),
        api<{ data: { subBase: string } }>('/api/v1/meta').catch(() => null),
      ]);
      hydrate(d.data);
      setProfileName(p.data.name);
      setIsTemplate(isTemplateProfile(p.data));
      setSubBase(meta?.data.subBase ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoaded(true);
    }
  }, [profileId, deviceId, hydrate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 已保存补丁对应的 raw 文本 —— dirty 的基准之一。 */
  const savedRawText = useMemo(
    () =>
      device && Object.keys(device.base_patch ?? {}).length > 0 ? stringify(device.base_patch) : '',
    [device],
  );

  /**
   * dirty 同时看**补丁对象**与**raw 文本**。
   *
   * 只比补丁对象是不够的：raw 里有语法错误时补丁根本没更新，用户敲了一屏字
   * 却被判定为「没有未保存修改」，切走时毫无提醒 —— 那些字就没了。
   */
  const dirty = useMemo(() => {
    if (!device) return false;
    if (JSON.stringify(patch) !== JSON.stringify(device.base_patch ?? {})) return true;
    return rawText !== savedRawText;
  }, [device, patch, rawText, savedRawText]);
  useUnsavedGuard(dirty);

  /**
   * raw 有语法错误时，卡片区一律只读。
   *
   * 否则卡片操作会拿**上一份能解析的** patch 重新序列化覆盖 rawText，把用户正在
   * 修的那段文本连同错误一起抹掉 —— 用户会以为自己刚敲的内容被系统吃了。
   */
  const cardsLocked = rawError !== null;

  /** raw 编辑 → 解析成补丁对象；解析失败只提示，不丢用户正在敲的文本。 */
  const onRawChange = useCallback((text: string) => {
    setRawText(text);
    if (text.trim() === '') {
      setPatch({});
      setRawError(null);
      return;
    }
    try {
      const parsed = parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setRawError('补丁必须是一个键值对象（顶层是 key: value）。');
        return;
      }
      setPatch(parsed as Patch);
      setRawError(null);
    } catch {
      setRawError('YAML 解析失败 —— 检查缩进与冒号。');
    }
  }, []);

  /** 卡片编辑写回补丁，同时把 raw 文本刷成同一份内容（两个视图，一份数据）。 */
  const writePatch = useCallback((next: Patch) => {
    setPatch(next);
    setRawText(Object.keys(next).length > 0 ? stringify(next) : '');
    setRawError(null);
  }, []);

  const removeKey = useCallback(
    (key: string) => {
      const next = { ...patch };
      delete next[key];
      writePatch(next);
    },
    [patch, writePatch],
  );

  const save = useCallback(async () => {
    if (rawError) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api<{ data: DeviceRecord }>(
        `/api/v1/profiles/${profileId}/devices/${deviceId}`,
        { method: 'PATCH', body: { base_patch: patch } },
      );
      hydrate(r.data);
      toast('已保存设备差异');
      setPreview(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [rawError, profileId, deviceId, patch, hydrate, toast]);

  const loadPreview = useCallback(async () => {
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      const r = await api<{
        data: { shared: string; device: string | null; issues: { message: string }[] };
      }>(`/api/v1/profiles/${profileId}/devices/${deviceId}/preview`);
      setPreview({ shared: r.data.shared, device: r.data.device });
      if (r.data.issues.length > 0) setPreviewError(r.data.issues.map((i) => i.message).join('；'));
    } catch (e) {
      setPreviewError(e instanceof ApiError ? e.message : '预览失败');
    } finally {
      setPreviewBusy(false);
    }
  }, [profileId, deviceId]);

  const remove = useCallback(async () => {
    if (
      !confirm(
        `确认删除设备「${device?.name}」？\n\n它的订阅链接会立即 404 —— 已在用这条链接的客户端将拉不到配置。此操作不可撤销。`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await api(`/api/v1/profiles/${profileId}/devices/${deviceId}`, { method: 'DELETE' });
      router.push(backHref);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
      setDeleting(false);
    }
  }, [device, profileId, deviceId, router, backHref]);

  const subUrl = useMemo(() => {
    // 模版一律不给链接 —— 给了也是一条注定 404 的链接（route 层同样拦）。
    if (isTemplate || !subBase || !device || !profileName) return '';
    return `${subBase}/${encodeURIComponent(profileName)}/${encodeURIComponent(device.name)}`;
  }, [isTemplate, subBase, device, profileName]);

  const keys = Object.keys(patch);
  const unusedCommon = COMMON_PATCH_KEYS.filter((k) => !(k.key in patch));
  const updateTailscale = useCallback((feature: PublicTailscaleDeviceFeature | null) => {
    setPreview(null);
    setPreviewError(null);
    setDevice((current) => {
      if (!current) return current;
      const features = { ...(current.features ?? {}) };
      if (feature) features.tailscale = feature;
      else delete features.tailscale;
      return { ...current, features };
    });
  }, []);

  return (
    <>
      <PageTopbar>
        <h1>设备 · {device?.name ?? '…'}</h1>
        {dirty && (
          <span className="is-dirty" style={{ display: 'inline-flex' }}>
            <span className="unsaved-dot" title="有未保存修改" />
          </span>
        )}
        <span className="crumb">{keys.length} 项差异</span>
        <div className="grow" />
        <Link className="btn ghost sm" href={backHref}>
          {backLabel}
        </Link>
        {isTemplate && <span className="pill acc plain">{TEMPLATE_NOT_DISTRIBUTABLE}</span>}
        <button
          type="button"
          className="btn sm"
          disabled={!subUrl}
          title={isTemplate ? '模版不对外分发，这台设备没有订阅链接' : undefined}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(subUrl);
              toast('已复制该设备的订阅链接');
            } catch {
              toast('复制失败');
            }
          }}
        >
          订阅链接 ⧉
        </button>
        <button
          type="button"
          className="btn primary sm"
          onClick={() => void save()}
          disabled={saving || !dirty || !!rawError}
        >
          {saving ? '保存中 …' : '保存'}
        </button>
      </PageTopbar>

      {error && <div className={styles.errBanner}>{error}</div>}

      {!loaded ? (
        <div className={styles.srcNote}>
          <span className="g">⋯</span>
          <span>加载设备…</span>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 18 }}>
          {/* ① 差异清单 */}
          <section className="panel">
            <div className="panel-head">
              <h2>差异清单</h2>
              <div className={styles.grow} />
              <span className="crumb">
                {cardsLocked ? 'raw 补丁有语法错误 · 卡片暂时只读' : '移除一项 = 回到共享配置的值'}
              </span>
            </div>
            <div className="panel-body">
              {cardsLocked && (
                <div className={styles.srcNote} style={{ marginTop: 0, marginBottom: 12 }}>
                  <span className="g">⚠</span>
                  <span>
                    下面的 <b>raw 补丁有语法错误</b>
                    ，卡片操作已暂时锁定 —— 否则改卡片会用上一份能解析的补丁覆盖你正在
                    修的文本。先把 raw 改成合法 YAML，卡片会自动解锁。
                  </span>
                </div>
              )}
              {keys.length === 0 ? (
                <div className={styles.srcNote} style={{ marginTop: 0 }}>
                  <span className="g">▪</span>
                  <span>
                    这台设备目前<b>没有任何差异</b>，下发内容与共享配置完全一致。
                    从下面挑一个常用键，或直接在 raw 补丁里写。
                  </span>
                </div>
              ) : (
                keys.map((key) => (
                  <div key={key} className={styles.dangerRow} style={{ marginBottom: 10 }}>
                    <div className="gw">
                      <b className="mono">{key}</b>
                      <span>
                        {labelFor(key)} · {displayValue(key, patch[key])}
                        {MANAGED_KEYS.has(key) && (
                          <b style={{ color: 'var(--danger)' }}>
                            {' '}
                            · 该键由共享层管理，保存会被拒绝
                          </b>
                        )}
                      </span>
                    </div>
                    {isSensitive(key) && (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={cardsLocked}
                        title={cardsLocked ? 'raw 补丁有语法错误' : undefined}
                        onClick={() => writePatch({ ...patch, [key]: randomSecret() })}
                      >
                        重新生成
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn sm"
                      disabled={cardsLocked}
                      title={cardsLocked ? 'raw 补丁有语法错误' : undefined}
                      onClick={() => removeKey(key)}
                    >
                      移除
                    </button>
                  </div>
                ))
              )}

              {unusedCommon.length > 0 && (
                <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                  <label>添加差异</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {unusedCommon.map((k) => (
                      <button
                        key={k.key}
                        type="button"
                        className="btn sm"
                        disabled={cardsLocked}
                        title={cardsLocked ? 'raw 补丁有语法错误' : k.hint}
                        onClick={() =>
                          writePatch({
                            ...patch,
                            [k.key]: k.key === 'secret' ? randomSecret() : '',
                          })
                        }
                      >
                        ＋ {k.label}
                      </button>
                    ))}
                  </div>
                  <div className="hint">
                    加完在下面的 raw 补丁里填值（空字符串会原样下发，记得改）。
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ② raw 补丁 */}
          <section className="panel">
            <div className="panel-head">
              <h2>raw 补丁</h2>
              <div className={styles.grow} />
              <span className="crumb">YAML · 与上面的卡片是同一份数据</span>
            </div>
            <div className="panel-body">
              <div className={styles.srcNote} style={{ marginTop: 0, marginBottom: 12 }}>
                <span className="g">⌗</span>
                <span>
                  对象<b>逐字段合并</b> · 数组<b>整段替换</b> · <span className="mono">null</span>
                  <b>删除该键</b> ·{' '}
                  <span className="mono">proxies / proxy-groups / rules / rule-providers</span>{' '}
                  由共享层管理，不可写。
                </span>
              </div>
              <CodeEditor
                value={rawText}
                onChange={onRawChange}
                onSave={() => void save()}
                dirty={dirty}
                label="base_patch · yaml"
                minHeight={220}
              />
              {rawError && (
                <div className={styles.errBanner} style={{ marginTop: 10 }}>
                  {rawError}
                </div>
              )}
            </div>
          </section>

          {/* ③ 生效预览 */}
          <section className="panel">
            <div className="panel-head">
              <h2>生效预览</h2>
              <div className={styles.grow} />
              <button
                type="button"
                className="btn sm"
                onClick={() => void loadPreview()}
                disabled={previewBusy}
              >
                {previewBusy ? '渲染中 …' : preview ? '重新渲染' : '渲染对比'}
              </button>
            </div>
            <div className="panel-body">
              <div className={styles.srcNote} style={{ marginTop: 0, marginBottom: 12 }}>
                <span className="g">⇲</span>
                <span>
                  左为<b>共享渲染</b>，右为<b>本设备渲染</b>
                  ；预览基于**已保存**的补丁，改完记得先保存。
                </span>
              </div>
              {previewError && <div className={styles.errBanner}>{previewError}</div>}
              {preview && (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                    gap: 12,
                  }}
                >
                  <CodeEditor
                    value={preview.shared}
                    readOnly
                    label="共享渲染"
                    minHeight={280}
                    hint=""
                  />
                  <CodeEditor
                    value={preview.device ?? '（补丁无效，无法渲染 —— 见上方错误）'}
                    readOnly
                    label={`设备渲染 · ${device?.name ?? ''}`}
                    minHeight={280}
                    hint=""
                  />
                </div>
              )}
            </div>
          </section>

          {/* ④ 本设备功能 */}
          <TailscaleDeviceCard
            profileId={profileId}
            deviceId={deviceId}
            deviceName={device?.name ?? ''}
            initialFeature={device?.features?.tailscale ?? null}
            isTemplate={isTemplate}
            onChanged={updateTailscale}
          />

          {/* ⑤ 危险区 */}
          <section className="panel">
            <div className="panel-head">
              <h2>危险区</h2>
            </div>
            <div className="panel-body">
              <div className={styles.dangerRow}>
                <div className="gw">
                  <b>删除设备</b>
                  <span>
                    删除后它的订阅链接立即 <b>404</b>
                    ，已在用这条链接的客户端将拉不到配置。共享配置与其它设备不受影响。
                  </span>
                </div>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => void remove()}
                  disabled={deleting}
                >
                  {deleting ? '删除中 …' : '删除设备'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
