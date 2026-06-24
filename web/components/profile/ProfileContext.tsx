'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';

/**
 * 配置文件（profile）上下文 —— 侧边栏切换器与 topbar scope 标签共享同一份数据，
 * 避免两处各拉一次 `/api/v1/profiles`。
 *
 * Phase 2：每份配置文件**自带** base / 策略组 / 规则（按 id 独立存储）。本上下文
 * 多了一个「正在编辑的配置文件」(`activeProfile`)：切换器选中后写入 `pm.active_profile`
 * cookie，服务端的编辑接口(`/base`、`/proxy-groups`、`/rules`、衍生的 `/anchors`、
 * `/policies`、场景 ops 等，见 lib/profileScope)据此 cookie 自动作用到该配置文件。
 * 切换会重载页面，让所有按作用域取数的请求带上新 cookie 重新拉取。
 *
 * `current`（名为 `default` 者，否则第一条）仍是 app 内总览/裸 `/api/sub/{token}` 跳转
 * 锚定的那一份；它不一定等于 `activeProfile`。
 */

/** Cookie the server reads to scope editing routes — keep in sync with lib/profileScope. */
const ACTIVE_PROFILE_COOKIE = 'pm.active_profile';

function readActiveCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === ACTIVE_PROFILE_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export type ProfileSource =
  | { type: 'none' }
  | { type: 'subscription'; id: string }
  | { type: 'collection'; id: string };

export interface Profile {
  id: string;
  name: string;
  source: ProfileSource;
  notes?: string;
  created_at?: number;
  updated_at: number;
}

interface ProfilesValue {
  profiles: Profile[];
  /** 总览/裸订阅链接锚定的配置文件(名为 default 者,否则第一条),无记录时为 null。 */
  current: Profile | null;
  /** 正在编辑的配置文件 —— /base、/proxy-groups、/rules 等作用于它。回退到 current。 */
  activeProfile: Profile | null;
  /** 切换正在编辑的配置文件:写 cookie 并重载页面以按新作用域重新取数。 */
  setActiveProfile: (name: string) => void;
  loaded: boolean;
  reload: () => Promise<void>;
}

const ProfilesContext = createContext<ProfilesValue | null>(null);

/** profile 名是否为引擎唯一生效的 default。 */
export function isLiveProfile(p: Profile | null | undefined): boolean {
  return p?.name === 'default';
}

/** 单源绑定的简短标签,用于切换器列表项尾部。 */
export function sourceLabel(p: Profile): string {
  switch (p.source?.type) {
    case 'subscription':
      return '订阅';
    case 'collection':
      return '聚合';
    default:
      return '未绑定';
  }
}

/** 头像字:取名称首个非连字符字符,大写。 */
export function profileMark(name: string): string {
  return (name.replace(/-/g, '').charAt(0) || '?').toUpperCase();
}

export function ProfilesProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ data: Profile[] }>('/api/v1/profiles');
      setProfiles(r.data);
    } catch {
      // 切换器是辅助导航,拉取失败时静默降级为「仅 default」。
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = useMemo(
    () => profiles.find((p) => p.name === 'default') ?? profiles[0] ?? null,
    [profiles],
  );

  // Active editing profile, mirrored from the `pm.active_profile` cookie. Read
  // in an effect (not during render) to avoid a hydration mismatch.
  const [activeName, setActiveName] = useState<string | null>(null);
  useEffect(() => {
    setActiveName(readActiveCookie());
  }, []);

  const activeProfile = useMemo(
    () => (activeName ? (profiles.find((p) => p.name === activeName) ?? current) : current),
    [activeName, profiles, current],
  );

  const setActiveProfile = useCallback((name: string) => {
    // Persist for the server (resolveScopeProfile) and reload so every
    // scope-reading fetch re-runs under the new cookie.
    document.cookie = `${ACTIVE_PROFILE_COOKIE}=${encodeURIComponent(name)}; path=/; max-age=31536000; SameSite=Lax`;
    window.location.reload();
  }, []);

  const value = useMemo<ProfilesValue>(
    () => ({ profiles, current, activeProfile, setActiveProfile, loaded, reload }),
    [profiles, current, activeProfile, setActiveProfile, loaded, reload],
  );

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): ProfilesValue {
  const ctx = useContext(ProfilesContext);
  if (!ctx) throw new Error('useProfiles must be used within ProfilesProvider');
  return ctx;
}
