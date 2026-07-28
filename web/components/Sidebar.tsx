'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';
import {
  TEMPLATE_BADGE,
  TEMPLATE_TAGLINE,
  isTemplateProfile,
  partitionProfilesByKind,
} from '@/lib/profiles/kind';
import { NavIcon } from '@/components/NavIcon';
import {
  ADVANCED_NAV,
  LIBRARY_NAV,
  OVERVIEW_NAV,
  PROFILE_NAV,
  SYSTEM_NAV,
  type NavItem,
} from '@/components/nav';
import {
  profileMark,
  sourceLabel,
  useProfiles,
  type Profile,
} from '@/components/profile/ProfileContext';

/**
 * 任务导向侧边栏。桌面固定展示完整语义，窄屏直接切为抽屉，
 * 不再依赖悬停展开的图标轨道。
 *
 * 顶部为配置文件切换器(ProfileSwitcher),其下导航按「当前配置文件 /
 * 资源库 / 系统」三段组织,对齐 profile-centric IA。导航项全部来自
 * `components/nav.ts` 这一处真相源,不按场景注册表动态拼装。
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { activeProfile, loading: profilesLoading, error: profilesError } = useProfiles();
  const [meta, setMeta] = useState<{ buildId: string | null; hasBase: boolean } | null>(null);
  const [metaError, setMetaError] = useState(false);

  useEffect(() => {
    api<{ data: { buildId: string | null; hasBase: boolean } }>('/api/v1/meta')
      .then((response) => {
        setMeta(response.data);
        setMetaError(false);
      })
      .catch(() => setMetaError(true));
  }, []);

  function signOut() {
    clearAdminKey();
    window.location.href = '/login';
  }

  // 设备详情页路由挂在 /profiles/[id]/devices/* 下,但按 IA 属于「设备」——
  // 点亮设备项而不是绑定与设置。
  const onDeviceDetail = /^\/profiles\/[^/]+\/devices\//.test(pathname);

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    if (href === '/devices') return pathname.startsWith('/devices') || onDeviceDetail;
    return pathname.startsWith(href);
  }

  // 「绑定与设置」指向正在编辑的配置文件的设置页;无记录时退到管理总览。
  const profileSettingsHref = activeProfile ? `/profiles/${activeProfile.id}` : '/profiles';
  const profileSettingsActive =
    !onDeviceDetail &&
    (pathname === profileSettingsHref || (pathname.startsWith('/profiles/') && !!activeProfile));
  const profileReady = !profilesLoading && !profilesError && Boolean(activeProfile);
  const profilePrerequisite = profilesError
    ? '需要先重新读取配置文件列表'
    : profilesLoading
      ? '正在读取配置文件列表'
      : '需要先选择配置文件';
  const basePrerequisite = metaError
    ? '无法确认当前配置是否已有 base'
    : !meta
      ? '正在检查当前配置的 base'
      : !meta.hasBase
        ? '需要先完成基础配置'
        : undefined;

  return (
    <aside className={`side${open ? ' open' : ''}`} aria-label="主导航">
      <div className="side-brand">
        <Link href="/" className="logo" onClick={onClose} aria-label="ProxyManager">
          PM
        </Link>
        <div>
          <b>ProxyManager</b>
          <span>配置与分发</span>
        </div>
      </div>

      <ProfileSwitcher onNavigate={onClose} />

      <nav className="side-nav">
        <div className="nav-group">
          {OVERVIEW_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
        </div>

        <div className="nav-group">
          <div className="nav-label">编辑当前配置</div>
          {PROFILE_NAV.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              onClick={onClose}
              disabledReason={
                !profileReady
                  ? profilePrerequisite
                  : item.href === '/base'
                    ? undefined
                    : basePrerequisite
              }
            />
          ))}
          <NavLink
            item={{
              href: profileSettingsHref,
              label: '配置文件设置',
              icon: 'settings',
              description: '来源、模版与删除',
            }}
            active={profileSettingsActive}
            onClick={onClose}
            disabledReason={!profileReady ? profilePrerequisite : undefined}
          />
        </div>

        <div className="nav-group">
          <div className="nav-label">高级配置</div>
          {ADVANCED_NAV.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              active={isActive(item.href)}
              onClick={onClose}
              disabledReason={!profileReady ? profilePrerequisite : basePrerequisite}
            />
          ))}
        </div>

        <div className="nav-group">
          <div className="nav-label">共享资源</div>
          {LIBRARY_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
        </div>

        <div className="nav-group nav-group-compact">
          <div className="nav-label">更多</div>
          {SYSTEM_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
          <button type="button" className="nav-item" onClick={signOut}>
            <span className="ic">
              <NavIcon name="logout" />
            </span>
            <span className="nav-copy">
              <span className="nav-name">退出登录</span>
            </span>
          </button>
        </div>
      </nav>

      <div className="side-foot">
        <span className="side-foot-label">当前版本</span>
        <span className="num">{meta?.buildId ? meta.buildId.slice(0, 7) : 'dev'}</span>
      </div>
    </aside>
  );
}

/**
 * 配置文件切换器(Phase 2)。选中一项即把「正在编辑的配置文件」切到它 —— 写
 * `pm.active_profile` cookie 并重载,于是 /base、/proxy-groups、/rules 等都作用到它。
 * 每行尾部的齿轮去该配置文件的设置页(绑定/订阅链接/删除)。
 *
 * Phase T:模版(kind=template)列在分隔线下的「模版」小节并加徽章,但**允许激活**
 * —— 激活即编辑模版内容,这正是维护模版的正规方式(见 DEVICE-LAYER-DESIGN.md §8.1)。
 */
function ProfileSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const { profiles, activeProfile, setActiveProfile, loading, error, reload } = useProfiles();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { normal, templates } = useMemo(() => partitionProfilesByKind(profiles), [profiles]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function go() {
    setOpen(false);
    onNavigate();
  }

  const activeId = activeProfile?.id ?? null;
  const name = activeProfile?.name ?? (loading ? '读取中' : error ? '读取失败' : '未选择');

  function row(p: Profile) {
    const template = isTemplateProfile(p);
    return (
      <div key={p.id} className={`pp-row${p.id === activeId ? ' on' : ''}`}>
        <button
          type="button"
          className="pp-pick"
          onClick={() => {
            if (p.id === activeId) {
              go();
            } else {
              setActiveProfile(p.name); // writes cookie + reloads
            }
          }}
        >
          <span className="dot" />
          <span className="nm">{p.name}</span>
          {template && <span className="tpl">{TEMPLATE_BADGE}</span>}
          <span className="tail">{p.id === activeId ? '正在编辑' : sourceLabel(p)}</span>
        </button>
        <Link
          className="pp-gear"
          href={`/profiles/${p.id}`}
          onClick={go}
          aria-label={`${p.name} 设置`}
          title="绑定与设置"
        >
          <NavIcon name="settings" size={16} />
        </Link>
      </div>
    );
  }

  return (
    <div className="side-switch" ref={ref}>
      <span className="side-switch-label">正在编辑</span>
      <button
        type="button"
        className="profile-switch"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pf-ic">{profileMark(name)}</span>
        <span className="pf-txt">
          <span className="pf-name">{name}</span>
          <span className="pf-sub">
            {error
              ? '读取失败，保留上次结果'
              : loading
                ? activeProfile
                  ? '正在刷新配置文件'
                  : '正在读取配置文件'
                : activeProfile
                  ? '配置文件'
                  : '尚未初始化'}
          </span>
        </span>
        <span className="caret">▾</span>
      </button>
      <div className={`profile-pop${open ? ' open' : ''}`}>
        <div className="pp-label">配置文件 · {normal.length}</div>
        {loading && !activeProfile ? (
          <div className="pp-li" style={{ color: 'var(--muted)', cursor: 'default' }} role="status">
            正在读取配置文件
          </div>
        ) : error ? (
          <div className="pp-li" style={{ cursor: 'default', display: 'block' }} role="alert">
            <span style={{ color: 'var(--danger)', display: 'block' }}>配置文件读取失败</span>
            <button
              type="button"
              className="btn sm"
              style={{ marginTop: 8 }}
              disabled={loading}
              aria-busy={loading}
              onClick={() => void reload()}
            >
              {loading ? '正在重试' : '重试'}
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="pp-li" style={{ color: 'var(--muted)', cursor: 'default' }}>
            尚无配置文件记录
          </div>
        ) : normal.length === 0 ? (
          <div className="pp-li" style={{ color: 'var(--muted)', cursor: 'default' }}>
            只有模版,尚无配置文件
          </div>
        ) : (
          normal.map(row)
        )}
        {templates.length > 0 && (
          <>
            <div className="pp-sep" />
            <div className="pp-label" title={TEMPLATE_TAGLINE}>
              模版 · {templates.length}
            </div>
            {templates.map(row)}
          </>
        )}
        <div className="pp-sep" />
        <Link className="pp-li pp-act" href="/profiles" onClick={go}>
          <span className="ic">＋</span>新建配置文件
        </Link>
        <Link className="pp-li pp-act" href="/profiles" onClick={go}>
          <span className="ic">⊞</span>管理全部配置文件
        </Link>
      </div>
    </div>
  );
}

function NavLink({
  item,
  active,
  onClick,
  disabledReason,
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
  disabledReason?: string;
}) {
  const content = (
    <>
      <span className="ic">
        <NavIcon name={item.icon} />
      </span>
      <span className="nav-copy">
        <span className="nav-name">{item.label}</span>
        <span className="nav-desc">{disabledReason ?? item.description}</span>
      </span>
    </>
  );

  if (disabledReason) {
    return (
      <span
        className="nav-item disabled"
        role="link"
        aria-disabled="true"
        tabIndex={0}
        title={disabledReason}
        data-prerequisite={disabledReason}
      >
        {content}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      className={`nav-item${active ? ' on' : ''}`}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {content}
    </Link>
  );
}
