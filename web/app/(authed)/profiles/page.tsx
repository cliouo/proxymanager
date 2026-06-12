'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import styles from './profiles.module.css';

/** —— 真实数据形态（见 schemas/profile.ts / collection.ts / subscription.ts）—— */
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

function slugFor(name: string): string {
  return `${name || 'untitled'}.yaml`;
}

function fmtTime(s: number | undefined): string {
  if (!s) return '—';
  const diff = Date.now() / 1000 - s;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  return `${Math.round(diff / 86400)} 天前`;
}

/** 头像字（取名称首个非连字符字符，大写）。 */
function markFor(name: string): string {
  const c = name.replace(/-/g, '').charAt(0) || '?';
  return c.toUpperCase();
}

export default function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [subs, setSubs] = useState<SubscriptionLite[]>([]);
  const [collections, setCollections] = useState<CollectionLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [p, s, c] = await Promise.all([
        api<{ data: Profile[] }>('/api/v1/profiles'),
        api<{ data: SubscriptionLite[] }>('/api/v1/subscriptions'),
        api<{ data: CollectionLite[] }>('/api/v1/collections'),
      ]);
      setProfiles(p.data);
      setSubs(s.data);
      setCollections(c.data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const subName = useCallback((id: string) => subs.find((x) => x.id === id)?.name ?? id, [subs]);
  const colName = useCallback(
    (id: string) => collections.find((x) => x.id === id)?.name ?? id,
    [collections],
  );

  const defaultCount = profiles.filter((p) => p.name === DEFAULT_PROFILE_NAME).length;

  return (
    <>
      <PageTopbar>
        <h1>配置文件</h1>
        {loaded && (
          <span className="crumb">
            {profiles.length} 份{defaultCount ? ` · ${defaultCount} 默认` : ''}
          </span>
        )}
        <div className="grow" />
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          ＋ 新建配置文件
        </button>
      </PageTopbar>

      <p className={styles.pageIntro}>
        每份<b>配置文件</b>是一份可独立解析的客户端配置：它绑定<b>单一节点来源</b>
        （某个订阅源、某个聚合订阅，或暂不绑定），其余结构 base、策略组、规则等当前由全局共享。
        <b>订阅源</b>和<b>规则集</b>放在下方共享资源库里，被各份配置文件共用。
      </p>

      {/* 共享资源库 */}
      <div className="lib-strip">
        <span className="lh">共享资源库</span>
        <div className="lg">
          <span className="gl">订阅源</span>
          {subs.length === 0 ? (
            <span className="gl">无</span>
          ) : (
            subs.slice(0, 6).map((s) => (
              <Link key={s.id} className="tag" href="/subscriptions">
                {s.name}
              </Link>
            ))
          )}
        </div>
        <span className="sep" />
        <div className="lg">
          <span className="gl">聚合订阅</span>
          {collections.length === 0 ? (
            <span className="gl">无</span>
          ) : (
            collections.slice(0, 6).map((c) => (
              <Link key={c.id} className="tag" href="/subscriptions">
                {c.name}
              </Link>
            ))
          )}
        </div>
        <span className="grow" />
        <Link className="btn sm" href="/subscriptions">
          管理资源库
        </Link>
      </div>

      <div className={styles.secH}>
        <h2>全部配置文件</h2>
        <span className="ct">{profiles.length}</span>
      </div>

      {error && <div className={styles.errBanner}>{error}</div>}

      {!loaded ? (
        <div className={styles.pageIntro}>加载中 …</div>
      ) : (
        <div className="pf-grid">
          {profiles.map((p) => {
            const isDefault = p.name === DEFAULT_PROFILE_NAME;
            return (
              <article key={p.id} className={`pf-card${isDefault ? ' is-default' : ''}`}>
                <div className="pf-top">
                  <div className="pf-mark">{markFor(p.name)}</div>
                  <div className="pf-id">
                    <b>{p.name}</b>
                    <span className="slug">{slugFor(p.name)}</span>
                  </div>
                  {isDefault && <span className="pill acc plain">默认</span>}
                </div>

                {p.notes && (
                  <div className="pf-meta">
                    <span>{p.notes}</span>
                  </div>
                )}

                <div className="pf-bind">
                  <span className="bl">节点来源</span>
                  <div className="row">
                    {p.source.type === 'none' && <span className="pill idle plain">未绑定</span>}
                    {p.source.type === 'subscription' && (
                      <>
                        <span
                          className="gl"
                          style={{ font: '10px var(--font-mono)', color: 'var(--faint)' }}
                        >
                          订阅源
                        </span>
                        <span className="tag">{subName(p.source.id)}</span>
                      </>
                    )}
                    {p.source.type === 'collection' && (
                      <>
                        <span
                          className="gl"
                          style={{ font: '10px var(--font-mono)', color: 'var(--faint)' }}
                        >
                          聚合订阅
                        </span>
                        <span className="tag">{colName(p.source.id)}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="pf-foot">
                  <Link className="btn primary sm" href={`/profiles/${p.id}`}>
                    设置
                  </Link>
                  <span className="when">编辑于 {fmtTime(p.updated_at)}</span>
                </div>
              </article>
            );
          })}

          {/* 新建占位卡 */}
          <button
            type="button"
            className="pf-card"
            onClick={() => setCreating(true)}
            style={{
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              minHeight: 180,
              borderStyle: 'dashed',
              color: 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            <span style={{ font: '20px var(--font-mono)', color: 'var(--accent)' }}>＋</span>
            <span style={{ fontSize: 13 }}>新建配置文件</span>
          </button>
        </div>
      )}

      {creating && (
        <NewProfileModal
          subs={subs}
          collections={collections}
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

/* ============================================================
   新建配置文件弹窗 → POST /api/v1/profiles
   真实接口只接受 { name, source, notes }。create-mode 卡里
   只保留接口支持的「空白 / 基础模板」语义占位；clone/import
   暂无后端，故不画（DESIGN §7：不画假能力）。
   ============================================================ */
function NewProfileModal({
  subs,
  collections,
  onClose,
  onCreated,
}: {
  subs: SubscriptionLite[];
  collections: CollectionLite[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const fid = useId();
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceKind, setSourceKind] = useState<'none' | 'subscription' | 'collection'>('none');
  const [sourceId, setSourceId] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const slugPreview = useMemo(() => slugFor(name.trim()), [name]);
  const nameValid = /^[a-z0-9-]+$/.test(name.trim());

  // Esc 关闭
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = useCallback(async () => {
    setErr(null);
    const n = name.trim();
    if (!n) return setErr('请填写名称');
    if (!nameValid) return setErr('名称只能用小写字母、数字与连字符（-）');
    let source: ProfileSource = { type: 'none' };
    if (sourceKind !== 'none') {
      if (!sourceId) return setErr('请选择要绑定的来源');
      source = { type: sourceKind, id: sourceId };
    }
    setPending(true);
    try {
      await api('/api/v1/profiles', {
        method: 'POST',
        body: { name: n, source, ...(notes.trim() ? { notes: notes.trim() } : {}) },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
      setPending(false);
    }
  }, [name, nameValid, notes, sourceId, sourceKind, onCreated]);

  return (
    <div className="modal-bg open" onClick={onClose}>
      <div className={`modal ${styles.npModal}`} onClick={(e) => e.stopPropagation()}>
        <h3>新建配置文件</h3>
        <p className="sub">命名（kebab-case），按需预绑一个节点来源。</p>

        <div className="field">
          <label htmlFor={`${fid}-name`}>名称</label>
          <input
            id={`${fid}-name`}
            className="input mono"
            value={name}
            placeholder="例如：home-main"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <div className="hint">
            文件名将由名称生成：<span className="mono">{slugPreview}</span>
          </div>
        </div>

        <div className="field">
          <label>
            节点来源{' '}
            <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· 可选，之后也能改</span>
          </label>
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
                setSourceId('');
              }}
            >
              订阅源
            </button>
            <button
              type="button"
              className={`opt${sourceKind === 'collection' ? ' on' : ''}`}
              onClick={() => {
                setSourceKind('collection');
                setSourceId('');
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

        <div className="field" style={{ marginBottom: 18 }}>
          <label>
            备注 <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· 可选</span>
          </label>
          <textarea
            className="input"
            rows={2}
            value={notes}
            placeholder="例如：家里日常用，流媒体走香港…"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {err && <div className={styles.errBanner}>{err}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={pending || !name.trim()}
          >
            {pending ? '创建中 …' : '创建配置文件'}
          </button>
        </div>
      </div>
    </div>
  );
}
