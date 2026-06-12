'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';

/**
 * 配置文件（profile）上下文 —— 侧边栏切换器与 topbar scope 标签共享同一份数据，
 * 避免两处各拉一次 `/api/v1/profiles`。
 *
 * 诚实边界(DESIGN §7「不画假数据」)：引擎当前只渲染名为 `default` 的配置文件
 * (`/api/v1/preview/[profile]` 对非 default 直接 404)，**没有真正的「切换生效配置文件」**。
 * 因此 `current` 取名为 `default` 的记录(否则取第一条)，仅作为「当前生效」的展示锚点；
 * 切换器把其余 profile 记录链接到各自的设置页(/profiles/[id])做管理,不伪造「一键切换全局」。
 */

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
  /** 当前生效的配置文件(名为 default 者,否则第一条),无记录时为 null。 */
  current: Profile | null;
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

  const value = useMemo<ProfilesValue>(
    () => ({ profiles, current, loaded, reload }),
    [profiles, current, loaded, reload],
  );

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): ProfilesValue {
  const ctx = useContext(ProfilesContext);
  if (!ctx) throw new Error('useProfiles must be used within ProfilesProvider');
  return ctx;
}
