'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { useProfiles } from '@/components/profile/ProfileContext';
import { useToast } from '@/components/ui/Toast';
import styles from '../profiles.module.css';

type ProfileSource =
  | { type: 'none' }
  | { type: 'subscription'; id: string }
  | { type: 'collection'; id: string };

interface Profile {
  id: string;
  name: string;
  source: ProfileSource;
  notes?: string;
  created_at?: number;
  updated_at: number;
}

interface SubscriptionLite {
  id: string;
  name: string;
}
interface CollectionLite {
  id: string;
  name: string;
}

const DEFAULT_PROFILE_NAME = 'default';
// 不带前缀 —— 真实令牌(SUB_TOKEN)没有固定形状,掩码不该暗示长度/前缀。
const TOKEN_MASK = '••••••••';

function slugFor(name: string): string {
  return `${name || 'untitled'}.yaml`;
}

export default function ProfileDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const fid = useId();
  const toast = useToast();
  // Keep the sidebar switcher (shared ProfileContext) in sync after rename/delete.
  const { reload: reloadSwitcher, activeProfile, clearActiveProfile } = useProfiles();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [subs, setSubs] = useState<SubscriptionLite[]>([]);
  const [collections, setCollections] = useState<CollectionLite[]>([]);
  const [total, setTotal] = useState(0);
  const [subBase, setSubBase] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // editable form state
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceKind, setSourceKind] = useState<'none' | 'subscription' | 'collection'>('none');
  const [sourceId, setSourceId] = useState('');

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const hydrate = useCallback((p: Profile) => {
    setProfile(p);
    setName(p.name);
    setNotes(p.notes ?? '');
    setSourceKind(p.source.type);
    setSourceId(p.source.type === 'none' ? '' : p.source.id);
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [p, s, c, list, meta] = await Promise.all([
        api<{ data: Profile }>(`/api/v1/profiles/${id}`),
        api<{ data: SubscriptionLite[] }>('/api/v1/subscriptions'),
        api<{ data: CollectionLite[] }>('/api/v1/collections'),
        api<{ meta: { total: number } }>('/api/v1/profiles'),
        // 分发链接前缀 `{origin}/api/sub/{token}`;拿不到不挡页面,链接面板降级。
        api<{ data: { subBase: string } }>('/api/v1/meta').catch(() => null),
      ]);
      hydrate(p.data);
      setSubs(s.data);
      setCollections(c.data);
      setTotal(list.meta.total);
      setSubBase(meta?.data.subBase ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoaded(true);
    }
  }, [id, hydrate]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isDefault = profile?.name === DEFAULT_PROFILE_NAME;
  const nameValid = /^[a-z0-9-]+$/.test(name.trim());

  const dirty = useMemo(() => {
    if (!profile) return false;
    if (name.trim() !== profile.name) return true;
    if ((notes.trim() || undefined) !== (profile.notes || undefined)) return true;
    if (sourceKind !== profile.source.type) return true;
    if (
      sourceKind !== 'none' &&
      sourceId !== (profile.source.type === 'none' ? '' : profile.source.id)
    )
      return true;
    return false;
  }, [profile, name, notes, sourceKind, sourceId]);

  // 订阅链接基于**已保存**的名称(下发路径用它),不是编辑框里的草稿名。
  const { subRealUrl, subShownUrl } = useMemo(() => {
    if (!profile) return { subRealUrl: '', subShownUrl: '' };
    const path = `/${encodeURIComponent(profile.name)}`;
    if (!subBase) return { subRealUrl: '', subShownUrl: `…/api/sub/${TOKEN_MASK}${path}` };
    const real = `${subBase}${path}`;
    if (revealToken) return { subRealUrl: real, subShownUrl: real };
    // subBase 形如 {origin}/api/sub/{token} —— 掩掉最后一段令牌,不在页面明文常驻。
    const cut = subBase.lastIndexOf('/');
    return { subRealUrl: real, subShownUrl: `${subBase.slice(0, cut)}/${TOKEN_MASK}${path}` };
  }, [profile, subBase, revealToken]);

  const copySubUrl = useCallback(async () => {
    if (!subRealUrl) return;
    try {
      await navigator.clipboard.writeText(subRealUrl);
      toast('已复制订阅链接 · 可直接在客户端导入这份配置文件');
    } catch {
      toast('复制失败 · 请点「显示」后手动选取');
    }
  }, [subRealUrl, toast]);

  const save = useCallback(async () => {
    setSaveMsg(null);
    setError(null);
    const n = name.trim();
    if (!n || !nameValid) {
      setError('名称只能用小写字母、数字与连字符（-）');
      return;
    }
    let source: ProfileSource = { type: 'none' };
    if (sourceKind !== 'none') {
      if (!sourceId) {
        setError('请选择要绑定的来源');
        return;
      }
      source = { type: sourceKind, id: sourceId };
    }
    setSaving(true);
    try {
      const res = await api<{ data: Profile }>(`/api/v1/profiles/${id}`, {
        method: 'PATCH',
        body: { name: n, source, notes: notes.trim() ? notes.trim() : null },
      });
      hydrate(res.data);
      void reloadSwitcher();
      setSaveMsg('已保存');
      window.setTimeout(() => setSaveMsg(null), 2400);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [id, name, nameValid, notes, sourceId, sourceKind, hydrate, reloadSwitcher]);

  const remove = useCallback(async () => {
    if (!confirm(`确认删除配置文件「${profile?.name}」？此操作不可撤销。`)) return;
    setDeleting(true);
    setError(null);
    try {
      await api(`/api/v1/profiles/${id}`, { method: 'DELETE' });
      // 删的是当前活动配置文件 → 清掉 cookie,免得后续作用域请求 404。
      if (activeProfile?.id === id) clearActiveProfile();
      void reloadSwitcher();
      router.push('/profiles');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除失败');
      setDeleting(false);
    }
  }, [id, profile?.name, router, reloadSwitcher, activeProfile?.id, clearActiveProfile]);

  // ⌘S 保存
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty && !saving) void save();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dirty, saving, save]);

  const lastProfile = total <= 1;

  if (loaded && !profile) {
    return (
      <>
        <PageTopbar>
          <Link className={styles.back} href="/profiles">
            ‹ 配置文件
          </Link>
          <h1>未找到</h1>
          <div className="grow" />
        </PageTopbar>
        {error && <div className={styles.errBanner}>{error}</div>}
      </>
    );
  }

  return (
    <>
      <PageTopbar>
        <Link className={styles.back} href="/profiles">
          ‹ 配置文件
        </Link>
        <h1>绑定与设置</h1>
        {dirty && (
          <span className="is-dirty" style={{ display: 'inline-flex' }}>
            <span className="unsaved-dot" title="有未保存改动" />
          </span>
        )}
        {profile && (
          <span className="crumb">
            {profile.name} · {slugFor(profile.name)}
          </span>
        )}
        <div className="grow" />
        {saveMsg && <span className="pill ok plain">{saveMsg}</span>}
        <button
          type="button"
          className="btn primary"
          onClick={save}
          disabled={!dirty || saving || !loaded}
        >
          {saving ? '保存中 …' : '保存'} <span className="kbd">⌘S</span>
        </button>
      </PageTopbar>

      {error && <div className={styles.errBanner}>{error}</div>}

      {!loaded ? (
        <div className={styles.pageIntro}>加载中 …</div>
      ) : (
        <div className={styles.setGrid}>
          {/* 基本信息 */}
          <section className="panel">
            <div className="panel-head">
              <h2>基本信息</h2>
            </div>
            <div className="panel-body">
              <div className={styles.field2}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor={`${fid}-name`}>名称</label>
                  <input
                    id={`${fid}-name`}
                    className="input mono"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  {!nameValid && name.trim() && (
                    <div className="hint" style={{ color: 'var(--warn)' }}>
                      仅小写字母 / 数字 / 连字符
                    </div>
                  )}
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>
                    文件名{' '}
                    <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· 自动生成</span>
                  </label>
                  <input
                    className="input mono"
                    value={slugFor(name.trim())}
                    readOnly
                    style={{ color: 'var(--muted)' }}
                  />
                </div>
              </div>
              <div className="field" style={{ margin: '16px 0 0' }}>
                <label>
                  备注 <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· 可选</span>
                </label>
                <textarea
                  className="input"
                  rows={2}
                  value={notes}
                  placeholder="例如：家里日常用，流媒体走香港，AI 服务走专线…"
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
              {isDefault && (
                <div className={styles.srcNote} style={{ marginTop: 14 }}>
                  <span className="g">★</span>
                  <span>
                    这是默认配置文件（<span className="mono">default</span>
                    ）。未指定时下发这一份；不可删除。
                  </span>
                </div>
              )}
            </div>
          </section>

          {/* 节点来源（单一绑定，对齐 ProfileSourceSchema） */}
          <section className="panel">
            <div className="panel-head">
              <h2>节点来源</h2>
              <div className={styles.grow} />
              <Link className="btn ghost sm" href="/subscriptions">
                去资源库管理
              </Link>
            </div>
            <div className="panel-body">
              <div className="field" style={{ marginBottom: 0 }}>
                <label>这份配置文件从哪里取节点</label>
                <div className="seg" role="tablist">
                  <button
                    type="button"
                    className={`opt${sourceKind === 'none' ? ' on' : ''}`}
                    onClick={() => {
                      setSourceKind('none');
                      setSourceId('');
                    }}
                  >
                    暂不绑定
                  </button>
                  <button
                    type="button"
                    className={`opt${sourceKind === 'subscription' ? ' on' : ''}`}
                    onClick={() => {
                      setSourceKind('subscription');
                      setSourceId(profile?.source.type === 'subscription' ? profile.source.id : '');
                    }}
                  >
                    订阅源
                  </button>
                  <button
                    type="button"
                    className={`opt${sourceKind === 'collection' ? ' on' : ''}`}
                    onClick={() => {
                      setSourceKind('collection');
                      setSourceId(profile?.source.type === 'collection' ? profile.source.id : '');
                    }}
                  >
                    聚合订阅
                  </button>
                </div>
                {sourceKind === 'subscription' && (
                  <select
                    className="input mono"
                    style={{ marginTop: 8 }}
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                  >
                    <option value="">选择订阅源 …</option>
                    {subs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                {sourceKind === 'collection' && (
                  <select
                    className="input mono"
                    style={{ marginTop: 8 }}
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                  >
                    <option value="">选择聚合订阅 …</option>
                    {collections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className={styles.srcNote}>
                <span className="g">⌗</span>
                <span>
                  配置文件只绑定<b>一个</b>节点来源：单个订阅源、或一个聚合订阅（其成员合并）。
                  想用多个机场，请先在
                  <Link href="/subscriptions"> 资源库 </Link>
                  建一个聚合订阅再绑定它。
                </span>
              </div>
            </div>
          </section>

          {/* 订阅链接 —— 把这份配置文件拿去别的客户端用 */}
          <section className="panel">
            <div className="panel-head">
              <h2>订阅链接</h2>
              <div className={styles.grow} />
              {profile && (
                <Link className="btn ghost sm" href={`/api/v1/preview/${encodeURIComponent(profile.name)}`} target="_blank">
                  预览生成的配置
                </Link>
              )}
            </div>
            <div className="panel-body">
              <div className="field" style={{ marginBottom: 0 }}>
                <label>
                  这份配置文件的下发地址{' '}
                  <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
                    · 在 mihomo / Clash 客户端里当订阅导入
                  </span>
                </label>
                <div className="dist-url">
                  <code>{subShownUrl}</code>
                  <button
                    type="button"
                    className="urlbtn"
                    onClick={() => setRevealToken((v) => !v)}
                    title="显示 / 隐藏令牌"
                  >
                    {revealToken ? '隐藏' : '显示'}
                  </button>
                </div>
                <div className="dist-acts" style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    type="button"
                    className="btn primary sm"
                    onClick={copySubUrl}
                    disabled={!subRealUrl}
                  >
                    复制链接
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => subRealUrl && window.open(subRealUrl, '_blank', 'noopener')}
                    disabled={!subRealUrl}
                  >
                    打开
                  </button>
                </div>
              </div>
              <div className={styles.srcNote} style={{ marginTop: 14 }}>
                <span className="g">⇲</span>
                <span>
                  链接里含访问令牌(平台级 <span className="mono">SUB_TOKEN</span>
                  ,与其它配置文件共用),属秘钥 —— 默认掩码,点「显示」再查看 / 复制。
                  {name.trim() !== profile?.name && (
                    <>
                      {' '}
                      <b style={{ color: 'var(--warn)' }}>
                        链接用的是已保存的名称「{profile?.name}」;改名后需保存才会生效。
                      </b>
                    </>
                  )}
                </span>
              </div>
            </div>
          </section>

          {/* 操作 */}
          <section className="panel">
            <div className="panel-head">
              <h2>配置文件操作</h2>
            </div>
            <div className="panel-body">
              <div className={styles.dangerRow}>
                <div className="gw">
                  <b>删除配置文件</b>
                  <span>
                    {lastProfile
                      ? '这是唯一一份配置文件 —— 至少保留一份，无法删除。'
                      : isDefault
                        ? '默认配置文件不可删除 —— 请先把另一份设为默认，再回来删除这一份。'
                        : '永久删除这份配置文件及其绑定关系，不可撤销。'}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={remove}
                  disabled={deleting || lastProfile || isDefault}
                  title={
                    lastProfile
                      ? '至少保留一份配置文件'
                      : isDefault
                        ? '默认配置文件不可删除'
                        : undefined
                  }
                >
                  {deleting ? '删除中 …' : '删除'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
