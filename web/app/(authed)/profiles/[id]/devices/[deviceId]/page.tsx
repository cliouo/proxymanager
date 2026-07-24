'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
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
import detailStyles from './device-detail.module.css';

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
type DeviceTab = 'differences' | 'tailscale' | 'preview';
const DEVICE_TABS: DeviceTab[] = ['differences', 'tailscale', 'preview'];

function tabFromHash(hash: string): DeviceTab {
  if (hash === '#tailscale') return 'tailscale';
  if (hash === '#preview') return 'preview';
  return 'differences';
}

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
  const [tab, setTab] = useState<DeviceTab>('differences');
  const [tailscaleDirty, setTailscaleDirty] = useState(false);

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

  useEffect(() => {
    const syncFromLocation = () => setTab(tabFromHash(window.location.hash));
    syncFromLocation();
    window.addEventListener('hashchange', syncFromLocation);
    window.addEventListener('popstate', syncFromLocation);
    return () => {
      window.removeEventListener('hashchange', syncFromLocation);
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  const selectTab = useCallback((next: DeviceTab) => {
    setTab(next);
    const nextHash = `#${next}`;
    if (window.location.hash !== nextHash) {
      // 分栏不是新的工作步骤，替换当前地址可保留深链接，也不会用浏览器后退堆出
      // 一串仅 hash 不同的历史记录。
      window.history.replaceState(window.history.state, '', nextHash);
    }
  }, []);

  const onTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = DEVICE_TABS.indexOf(tab);
      const next =
        event.key === 'Home'
          ? DEVICE_TABS[0]
          : event.key === 'End'
            ? DEVICE_TABS[DEVICE_TABS.length - 1]
            : event.key === 'ArrowRight'
              ? DEVICE_TABS[(currentIndex + 1) % DEVICE_TABS.length]
              : DEVICE_TABS[(currentIndex - 1 + DEVICE_TABS.length) % DEVICE_TABS.length];
      selectTab(next);
      requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
    },
    [selectTab, tab],
  );

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
  const patchDirty = useMemo(() => {
    if (!device) return false;
    if (JSON.stringify(patch) !== JSON.stringify(device.base_patch ?? {})) return true;
    return rawText !== savedRawText;
  }, [device, patch, rawText, savedRawText]);
  const dirty = patchDirty || tailscaleDirty;
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
  const tailscaleLabel = isTemplate
    ? '模版不配置'
    : device?.features?.tailscale?.hasAuthKey
      ? '已启用'
      : device?.features?.tailscale
        ? '待完成'
        : '未配置';

  return (
    <>
      <PageTopbar contentMaxWidth={1180}>
        <h1>{device?.display_name || device?.name || '设备'}</h1>
        {device?.display_name && <span className="crumb">{device.name}</span>}
        {dirty && (
          <span className="is-dirty" style={{ display: 'inline-flex' }}>
            <span className="unsaved-dot" title="设备差异有未保存修改" />
          </span>
        )}
        <span className="crumb">{keys.length} 项差异</span>
        <div className="grow" />
        <Link className="btn ghost sm" href={backHref}>
          {backLabel}
        </Link>
        {isTemplate && <span className="pill acc plain">{TEMPLATE_NOT_DISTRIBUTABLE}</span>}
        {!dirty && (
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
            复制订阅链接
          </button>
        )}
        {patchDirty && (
          <button
            type="button"
            className="btn primary sm"
            onClick={() => void save()}
            disabled={saving || !patchDirty || !!rawError}
          >
            {saving ? '保存中 …' : '保存差异'}
          </button>
        )}
      </PageTopbar>

      {error && <div className={styles.errBanner}>{error}</div>}

      {!loaded ? (
        <div className={styles.srcNote}>
          <span className="g">⋯</span>
          <span>加载设备…</span>
        </div>
      ) : !device ? (
        <div className={detailStyles.loadFailure}>
          <b>无法打开这台设备</b>
          <p>{error ?? '设备可能已经被删除，或当前配置文件不可访问。'}</p>
          <Link className="btn" href={backHref}>
            {backLabel}
          </Link>
        </div>
      ) : (
        <div className={detailStyles.page}>
          <section className={detailStyles.inheritanceContext}>
            <span className={detailStyles.inheritanceMark} aria-hidden="true">
              ＋
            </span>
            <div>
              <span className={detailStyles.contextEyebrow}>继承共享配置</span>
              <h2>{profileName}</h2>
              <p>共享层持续提供基础配置、代理策略和规则，这里只维护这台设备不同的部分。</p>
            </div>
            <dl className={detailStyles.contextStats}>
              <div>
                <dt>配置差异</dt>
                <dd>{keys.length === 0 ? '无差异' : `${keys.length} 项`}</dd>
              </div>
              <div>
                <dt>Tailscale</dt>
                <dd>{tailscaleLabel}</dd>
              </div>
            </dl>
          </section>

          <nav className={detailStyles.tabs} role="tablist" aria-label="设备设置">
            <button
              id="tab-differences"
              type="button"
              role="tab"
              aria-selected={tab === 'differences'}
              aria-controls="panel-differences"
              tabIndex={tab === 'differences' ? 0 : -1}
              onClick={() => selectTab('differences')}
              onKeyDown={onTabKeyDown}
            >
              配置差异
              <span>{keys.length}</span>
            </button>
            <button
              id="tab-tailscale"
              type="button"
              role="tab"
              aria-selected={tab === 'tailscale'}
              aria-controls="panel-tailscale"
              tabIndex={tab === 'tailscale' ? 0 : -1}
              onClick={() => selectTab('tailscale')}
              onKeyDown={onTabKeyDown}
            >
              Tailscale
              <span>{tailscaleDirty ? '未保存' : tailscaleLabel}</span>
            </button>
            <button
              id="tab-preview"
              type="button"
              role="tab"
              aria-selected={tab === 'preview'}
              aria-controls="panel-preview"
              tabIndex={tab === 'preview' ? 0 : -1}
              onClick={() => selectTab('preview')}
              onKeyDown={onTabKeyDown}
            >
              生效预览
              {preview && <span>已渲染</span>}
            </button>
          </nav>

          <section
            id="panel-differences"
            role="tabpanel"
            aria-labelledby="tab-differences"
            hidden={tab !== 'differences'}
            className={detailStyles.tabPanel}
          >
            <div className={detailStyles.stack}>
              <section className="panel">
                <div className="panel-head">
                  <h2>差异清单</h2>
                  <div className={styles.grow} />
                  <span className="crumb">
                    {cardsLocked
                      ? 'raw 补丁有语法错误 · 卡片暂时只读'
                      : '移除一项 = 回到共享配置的值'}
                  </span>
                </div>
                <div className="panel-body">
                  {cardsLocked && (
                    <div className={detailStyles.lockNotice}>
                      <span>⚠</span>
                      <p>
                        <b>raw 补丁有语法错误，卡片操作已暂时锁定。</b>
                        先把下面的 YAML 改合法，避免卡片操作覆盖正在修复的文本。
                      </p>
                    </div>
                  )}
                  {keys.length === 0 ? (
                    <div className={detailStyles.noDifferences}>
                      <span>＝</span>
                      <div>
                        <b>这台设备与共享配置完全一致</b>
                        <p>之后共享配置发生变化时，它会自动跟随，不需要重复维护。</p>
                      </div>
                    </div>
                  ) : (
                    keys.map((key) => (
                      <div key={key} className={detailStyles.differenceRow}>
                        <div className={detailStyles.differenceCopy}>
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
                    <div className={detailStyles.addDifference}>
                      <label>添加差异</label>
                      <div>
                        {unusedCommon.map((item) => (
                          <button
                            key={item.key}
                            type="button"
                            className="btn sm"
                            disabled={cardsLocked}
                            title={cardsLocked ? 'raw 补丁有语法错误' : item.hint}
                            onClick={() =>
                              writePatch({
                                ...patch,
                                [item.key]: item.key === 'secret' ? randomSecret() : '',
                              })
                            }
                          >
                            ＋ {item.label}
                          </button>
                        ))}
                      </div>
                      <p>添加后在 raw 补丁中填写具体值，空字符串也会被原样下发。</p>
                    </div>
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head">
                  <h2>raw 补丁</h2>
                  <div className={styles.grow} />
                  <span className="crumb">YAML · 与上面的差异清单是同一份数据</span>
                </div>
                <div className="panel-body">
                  <div className={detailStyles.rawExplanation}>
                    <span>补丁规则</span>
                    <p>
                      对象逐字段合并，数组整段替换，<code>null</code> 删除该键。
                      <code>proxies</code>、<code>proxy-groups</code>、<code>rules</code> 和
                      <code>rule-providers</code> 仍由共享层管理。
                    </p>
                  </div>
                  <CodeEditor
                    value={rawText}
                    onChange={onRawChange}
                    onSave={() => void save()}
                    dirty={patchDirty}
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
            </div>
          </section>

          <section
            id="panel-tailscale"
            role="tabpanel"
            aria-labelledby="tab-tailscale"
            hidden={tab !== 'tailscale'}
            className={detailStyles.tabPanel}
          >
            <TailscaleDeviceCard
              profileId={profileId}
              deviceId={deviceId}
              deviceName={device.name}
              initialFeature={device.features?.tailscale ?? null}
              isTemplate={isTemplate}
              onChanged={updateTailscale}
              onDirtyChange={setTailscaleDirty}
            />
          </section>

          <section
            id="panel-preview"
            role="tabpanel"
            aria-labelledby="tab-preview"
            hidden={tab !== 'preview'}
            className={detailStyles.tabPanel}
          >
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
                <div className={detailStyles.previewExplanation}>
                  <span>共享配置</span>
                  <b>＋</b>
                  <span>已保存的设备差异</span>
                  <b>＝</b>
                  <strong>设备最终配置</strong>
                </div>
                {dirty && (
                  <div className={detailStyles.previewNotice}>
                    当前还有未保存的设备差异，预览只会使用上一次保存的版本。
                  </div>
                )}
                {previewError && <div className={styles.errBanner}>{previewError}</div>}
                {!preview && !previewError && (
                  <div className={detailStyles.previewEmpty}>
                    <b>还没有生成对比</b>
                    <p>渲染后可以并排检查共享配置和这台设备最终收到的配置。</p>
                  </div>
                )}
                {preview && (
                  <div className={detailStyles.previewGrid}>
                    <CodeEditor
                      value={preview.shared}
                      readOnly
                      label="共享渲染"
                      minHeight={320}
                      hint=""
                    />
                    <CodeEditor
                      value={preview.device ?? '（补丁无效，无法渲染，请检查上方错误）'}
                      readOnly
                      label={`设备渲染 · ${device.name}`}
                      minHeight={320}
                      hint=""
                    />
                  </div>
                )}
              </div>
            </section>
          </section>

          <details className={detailStyles.dangerZone}>
            <summary>设备管理</summary>
            <div>
              <div>
                <b>删除设备</b>
                <p>
                  删除后它的订阅链接立即
                  404，已经使用这条链接的客户端将无法继续更新。共享配置和其他设备不受影响。
                </p>
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
          </details>
        </div>
      )}
    </>
  );
}
