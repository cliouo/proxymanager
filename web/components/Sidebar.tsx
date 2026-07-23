'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';
import {
  ALL_NAV,
  EXTENSIONS_NAV,
  LIBRARY_NAV,
  OVERVIEW_NAV,
  PROFILE_NAV,
  SYSTEM_NAV,
  type NavItem,
} from '@/components/nav';
import { profileMark, sourceLabel, useProfiles } from '@/components/profile/ProfileContext';

/**
 * v2「Signal Console」侧边栏 —— 固定 228px / 平板横屏图标轨 / 移动端抽屉。
 * `open` 控制移动端抽屉显隐；点导航触发 `onClose` 收起抽屉。
 *
 * 顶部为配置文件切换器(ProfileSwitcher),其下导航按「当前配置文件 / 扩展 /
 * 资源库 / 系统」四段组织,对齐 v2 原型的 profile-centric IA。导航项全部来自
 * `components/nav.ts` 这一处真相源(含扩展组),不再按场景注册表动态拼装。
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { activeProfile } = useProfiles();
  const [buildId, setBuildId] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: { buildId: string | null } }>('/api/v1/meta')
      .then((r) => setBuildId(r.data.buildId))
      .catch(() => undefined);
  }, []);

  function signOut() {
    clearAdminKey();
    window.location.href = '/login';
  }

  function isActive(href: string): boolean {
    if (href === '/') return pathname === '/';
    // 「扩展中心」(/scenarios) 是全部 /scenarios/* 的前缀:只在没有更具体的
    // 导航项(规则 / 链式代理 / Tailscale)命中时才点亮它。
    if (href === '/scenarios') {
      return (
        pathname.startsWith('/scenarios') &&
        !ALL_NAV.some((n) => n.href.startsWith('/scenarios/') && pathname.startsWith(n.href))
      );
    }
    return pathname.startsWith(href);
  }

  // 「绑定与设置」指向正在编辑的配置文件的设置页;无记录时退到管理总览。
  const profileSettingsHref = activeProfile ? `/profiles/${activeProfile.id}` : '/profiles';
  const profileSettingsActive =
    pathname === profileSettingsHref || (pathname.startsWith('/profiles/') && !!activeProfile);

  return (
    <aside className={`side${open ? ' open' : ''}`}>
      <div className="side-brand">
        <Link href="/" className="logo" onClick={onClose} aria-label="ProxyManager">
          PM
        </Link>
        <div>
          <b>ProxyManager</b>
          <span>signal console</span>
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
          <div className="nav-label">当前配置文件</div>
          {PROFILE_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
          <NavLink
            item={{ href: profileSettingsHref, label: '绑定与设置', icon: '⚙' }}
            active={profileSettingsActive}
            onClick={onClose}
          />
        </div>

        <div className="nav-group">
          <div className="nav-label">扩展</div>
          {EXTENSIONS_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
        </div>

        <div className="nav-group">
          <div className="nav-label">
            资源库<span className="sh">· 共享</span>
          </div>
          {LIBRARY_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
        </div>

        <div className="nav-group">
          <div className="nav-label">系统</div>
          {SYSTEM_NAV.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} onClick={onClose} />
          ))}
          <button type="button" className="nav-item" onClick={signOut}>
            <span className="ic">⏻</span>退出登录
          </button>
        </div>
      </nav>

      <div className="side-foot">
        <span>{buildId ? buildId.slice(0, 7) : 'dev'}</span>
        <span>signal console</span>
      </div>
    </aside>
  );
}

/**
 * 配置文件切换器(Phase 2)。选中一项即把「正在编辑的配置文件」切到它 —— 写
 * `pm.active_profile` cookie 并重载,于是 /base、/proxy-groups、/rules 等都作用到它。
 * 每行尾部的齿轮去该配置文件的设置页(绑定/订阅链接/删除)。
 */
function ProfileSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const { profiles, activeProfile, setActiveProfile } = useProfiles();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
  const name = activeProfile?.name ?? 'default';

  return (
    <div className="side-switch" ref={ref}>
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
          <span className="pf-sub">{activeProfile ? '正在编辑' : '尚未初始化'}</span>
        </span>
        <span className="caret">▾</span>
      </button>
      <div className={`profile-pop${open ? ' open' : ''}`}>
        <div className="pp-label">配置文件 · {profiles.length}</div>
        {profiles.length === 0 ? (
          <div className="pp-li" style={{ color: 'var(--muted)', cursor: 'default' }}>
            尚无配置文件记录
          </div>
        ) : (
          profiles.map((p) => (
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
                <span className="tail">{p.id === activeId ? '正在编辑' : sourceLabel(p)}</span>
              </button>
              <Link
                className="pp-gear"
                href={`/profiles/${p.id}`}
                onClick={go}
                aria-label={`${p.name} 设置`}
                title="绑定与设置"
              >
                ⚙
              </Link>
            </div>
          ))
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
}: {
  item: NavItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Link href={item.href} className={`nav-item${active ? ' on' : ''}`} onClick={onClick}>
      <span className="ic">{item.icon}</span>
      {item.label}
    </Link>
  );
}
