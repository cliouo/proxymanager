'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';
import {
  LIBRARY_NAV,
  OVERVIEW_NAV,
  PROFILE_NAV,
  SYSTEM_NAV,
  type NavItem,
} from '@/components/nav';
import {
  isLiveProfile,
  profileMark,
  sourceLabel,
  useProfiles,
} from '@/components/profile/ProfileContext';

const PROMOTED_SCENARIOS = new Set(['rule-anchor-append', 'chained-proxy']);

interface ScenarioDescriptor {
  id: string;
  title: string;
  navHref?: string;
}

const SCENARIO_LABEL_OVERRIDES: Record<string, string> = {
  'rule-anchor-append': '规则编辑',
  'chained-proxy': '链式代理',
  'dev-echo': 'Echo (调试)',
};

/**
 * v2「Signal Console」侧边栏 —— 固定 228px / 平板横屏图标轨 / 移动端抽屉。
 * `open` 控制移动端抽屉显隐；点导航触发 `onClose` 收起抽屉。
 *
 * 顶部为配置文件切换器(ProfileSwitcher),其下导航按「当前配置文件 / 资源库 / 系统」
 * 三段组织,对齐 v2 原型的 profile-centric IA。
 */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { current } = useProfiles();
  const [scenarios, setScenarios] = useState<ScenarioDescriptor[]>([]);
  const [buildId, setBuildId] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: ScenarioDescriptor[] }>('/api/v1/scenarios')
      .then((r) => setScenarios(r.data))
      .catch(() => undefined);
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
    return pathname.startsWith(href);
  }

  // 「绑定与设置」指向当前配置文件的设置页;无 current 时退到管理总览。
  const profileSettingsHref = current ? `/profiles/${current.id}` : '/profiles';
  const profileSettingsActive =
    pathname === profileSettingsHref || (pathname.startsWith('/profiles/') && !!current);

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

        {scenarios.some((s) => s.navHref && !PROMOTED_SCENARIOS.has(s.id)) && (
          <div className="nav-group">
            <div className="nav-label">更多场景</div>
            <NavLink
              item={{ href: '/scenarios', label: '全部场景', icon: '✦' }}
              active={
                pathname === '/scenarios' ||
                (pathname.startsWith('/scenarios/') &&
                  !scenarios.some((s) => s.navHref === pathname))
              }
              onClick={onClose}
            />
            {scenarios.map((s) =>
              s.navHref && !PROMOTED_SCENARIOS.has(s.id) ? (
                <NavLink
                  key={s.id}
                  item={{
                    href: s.navHref,
                    label: SCENARIO_LABEL_OVERRIDES[s.id] ?? s.title,
                    icon: '·',
                  }}
                  active={pathname === s.navHref}
                  onClick={onClose}
                />
              ) : null,
            )}
          </div>
        )}
      </nav>

      <div className="side-foot">
        <span>{buildId ? buildId.slice(0, 7) : 'dev'}</span>
        <span>signal console</span>
      </div>
    </aside>
  );
}

/**
 * 配置文件切换器。诚实边界:引擎当前只渲染名为 `default` 的配置文件,没有「一键切换全局」;
 * 故列表项链接到各 profile 的设置页做管理,默认(生效)项标 on。
 */
function ProfileSwitcher({ onNavigate }: { onNavigate: () => void }) {
  const { profiles, current } = useProfiles();
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

  const name = current?.name ?? 'default';
  const sub = current ? (isLiveProfile(current) ? '默认配置文件' : '配置文件') : '尚未初始化';

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
          <span className="pf-sub">{sub}</span>
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
            <Link
              key={p.id}
              className={`pp-li${isLiveProfile(p) ? ' on' : ''}`}
              href={`/profiles/${p.id}`}
              onClick={go}
            >
              <span className="dot" />
              <span className="nm">{p.name}</span>
              <span className="tail">{isLiveProfile(p) ? '生效' : sourceLabel(p)}</span>
            </Link>
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
