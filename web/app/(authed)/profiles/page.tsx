'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { useProfiles } from '@/components/profile/ProfileContext';
import { Placeholder } from '@/components/ui/Reveal';
import {
  TEMPLATE_BADGE,
  TEMPLATE_NOT_DISTRIBUTABLE,
  TEMPLATE_TAGLINE,
  isTemplateProfile,
  partitionProfilesByKind,
  templatesFirst,
} from '@/lib/profiles/kind';
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
  /** 普通配置文件 / 模版（schemas/profile.ts）。存量记录 parse-forward 为 normal。 */
  kind?: 'normal' | 'template';
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
  // The sidebar switcher reads from the shared ProfileContext; refresh it too so
  // a newly created profile shows up there without a full page reload.
  const { reload: reloadSwitcher } = useProfiles();

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
  // Phase T:模版与普通配置文件分两栏陈列。语义完全一致(可编辑、可预览、可激活),
  // 只是不对外分发 —— 分组是为了让「拿来复制的底本」和「日常在用的配置」一眼分开。
  const { normal, templates } = useMemo(() => partitionProfilesByKind(profiles), [profiles]);

  /** 一张配置文件卡 —— 两栏共用,差别只在模版徽章与「不可分发」提示。 */
  function profileCard(p: Profile) {
    const isDefault = p.name === DEFAULT_PROFILE_NAME;
    const template = isTemplateProfile(p);
    return (
      <article key={p.id} className={`pf-card${isDefault ? ' is-default' : ''}`}>
        <div className="pf-top">
          <div className="pf-mark">{markFor(p.name)}</div>
          <div className="pf-id">
            <b>{p.name}</b>
            <span className="slug">{template ? TEMPLATE_NOT_DISTRIBUTABLE : slugFor(p.name)}</span>
          </div>
          {isDefault && <span className="pill acc plain">默认</span>}
          {template && <span className="pill acc plain">{TEMPLATE_BADGE}</span>}
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
  }

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
        每份<b>配置文件</b>是一份可独立解析的客户端配置：它有<b>自己的</b>结构 base、策略组与规则，
        并绑定<b>单一节点来源</b>（某个订阅源、某个聚合订阅，或暂不绑定）。新建时可
        <b>从某份配置文件复制</b>
        （默认 default）再改，互不影响。<b>订阅源</b>和<b>规则集</b>
        放在下方共享资源库里，被各份配置文件共用。
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
        <h2>配置文件</h2>
        <span className="ct">{normal.length}</span>
      </div>

      {error && <div className={styles.errBanner}>{error}</div>}

      {!loaded ? (
        <div className="pf-grid" aria-busy="true">
          <ProfileCardSkeleton />
          <ProfileCardSkeleton />
          <ProfileCardSkeleton />
        </div>
      ) : (
        <div className="pf-grid">
          {normal.map(profileCard)}

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

      {/* 模版栏 —— 有模版才出现，无模版时页面与改动前一致。 */}
      {loaded && templates.length > 0 && (
        <>
          <div className={styles.secH} style={{ marginTop: 28 }}>
            <h2>模版</h2>
            <span className="ct">{templates.length}</span>
          </div>
          <p className={styles.pageIntro}>
            模版是拿来<b>复制</b>的底本：新建配置文件时选它作起点，复制完两边各走各的。 模版本身
            <b>不对外分发</b>（订阅链接一律 404），但照样可以编辑、预览、激活 ——
            激活即编辑模版内容，这正是维护模版的方式。{TEMPLATE_TAGLINE}
          </p>
          <div className="pf-grid">{templates.map(profileCard)}</div>
        </>
      )}

      {creating && (
        <NewProfileModal
          subs={subs}
          collections={collections}
          profiles={profiles}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
            void reloadSwitcher();
          }}
        />
      )}
    </>
  );
}

/* ============================================================
   新建配置文件弹窗 → POST /api/v1/profiles
   接口接受 { name, source, notes?, copy_from? }。copy_from 指向
   一份已有配置文件 → 深拷贝其 base + 策略组 + 规则；留空(空白) →
   仅从 default 复制一份骨架 base，无策略组/规则。
   ============================================================ */
function NewProfileModal({
  subs,
  collections,
  profiles,
  onClose,
  onCreated,
}: {
  subs: SubscriptionLite[];
  collections: CollectionLite[];
  profiles: Profile[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const fid = useId();
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [notes, setNotes] = useState('');
  const [sourceKind, setSourceKind] = useState<'none' | 'subscription' | 'collection'>('none');
  const [sourceId, setSourceId] = useState('');
  // 初始内容：从某配置文件复制(默认 default) 或 空白(仅骨架)。
  // Phase T：模版就是为「拿来复制」而存在的，所以候选列表把模版置顶，
  // 且有模版时默认选中第一个模版（「从模版新建」是主推路径）。
  const candidates = useMemo(() => templatesFirst(profiles), [profiles]);
  const firstTemplateId = useMemo(
    () => candidates.find((p) => isTemplateProfile(p))?.id ?? '',
    [candidates],
  );
  const defaultProfileId = useMemo(
    () =>
      firstTemplateId ||
      profiles.find((p) => p.name === DEFAULT_PROFILE_NAME)?.id ||
      profiles[0]?.id ||
      '',
    [firstTemplateId, profiles],
  );
  const [seed, setSeed] = useState<'copy' | 'blank'>(profiles.length > 0 ? 'copy' : 'blank');
  const [copyFrom, setCopyFrom] = useState<string>(defaultProfileId);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const slugPreview = useMemo(() => slugFor(name.trim()), [name]);
  const nameValid = /^[a-z0-9-]+$/.test(name.trim());

  // Esc 关闭 — P3-34: 但创建进行中不允许关闭(否则可能中途丢失/重复提交)。
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
        body: {
          name: n,
          ...(displayName.trim() ? { display_name: displayName.trim() } : {}),
          source,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(seed === 'copy' && copyFrom ? { copy_from: copyFrom } : {}),
        },
      });
      onCreated();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
      setPending(false);
    }
  }, [name, nameValid, displayName, notes, sourceId, sourceKind, seed, copyFrom, onCreated]);

  return (
    <div className="modal-bg open" onClick={() => !pending && onClose()}>
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
          <label htmlFor={`${fid}-display`}>
            订阅显示名{' '}
            <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
              · 可选 · 导入客户端后看到的名字
            </span>
          </label>
          <input
            id={`${fid}-display`}
            className="input"
            value={displayName}
            placeholder={`默认：proxymanager-${name.trim() || 'untitled'}`}
            maxLength={120}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <div className="hint">支持中文 / 空格 / emoji；留空用默认名。之后也能改。</div>
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

        {profiles.length > 0 && (
          <div className="field">
            <label>
              初始内容{' '}
              <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
                · base / 策略组 / 规则的起点
              </span>
            </label>
            <div className="seg" role="tablist">
              <button
                type="button"
                className={`opt${seed === 'copy' ? ' on' : ''}`}
                onClick={() => setSeed('copy')}
              >
                {firstTemplateId ? '从模版新建' : '从配置文件复制'}
              </button>
              <button
                type="button"
                className={`opt${seed === 'blank' ? ' on' : ''}`}
                onClick={() => setSeed('blank')}
              >
                空白（仅骨架）
              </button>
            </div>
            {seed === 'copy' ? (
              <>
                <select
                  className="input mono"
                  style={{ marginTop: 8 }}
                  value={copyFrom}
                  onChange={(e) => setCopyFrom(e.target.value)}
                >
                  {candidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {isTemplateProfile(p)
                        ? `（${TEMPLATE_BADGE}）`
                        : p.name === DEFAULT_PROFILE_NAME
                          ? '（默认）'
                          : ''}
                    </option>
                  ))}
                </select>
                {firstTemplateId && (
                  <div className="hint">{TEMPLATE_TAGLINE}复制完即独立，改模版不影响它。</div>
                )}
              </>
            ) : (
              <div className="hint">从 default 复制一份骨架 base，不含策略组与规则。</div>
            )}
          </div>
        )}

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
            aria-busy={pending || undefined}
            disabled={pending || !name.trim()}
          >
            {pending ? '创建中 …' : '创建配置文件'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileCardSkeleton() {
  return (
    <article className="pf-card" aria-hidden>
      <div className="pf-top">
        <div className="pm-skeleton" style={{ width: 42, height: 42, borderRadius: 10 }} />
        <div className="pf-id" style={{ flex: 1 }}>
          <div className="pm-skeleton line" style={{ width: '46%', height: 14 }} />
          <div className="pm-skeleton line" style={{ width: '64%', height: 10, marginTop: 8 }} />
        </div>
      </div>
      <div className="pf-bind">
        <Placeholder rows={2} compact />
      </div>
      <div className="pf-foot">
        <div className="pm-skeleton line" style={{ width: 58, height: 26 }} />
        <div className="pm-skeleton line" style={{ width: '38%', height: 10 }} />
      </div>
    </article>
  );
}
