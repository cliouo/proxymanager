'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { startProfileSession, bindProfileSession } from '@/lib/client/profile-session';
import { navigateWithUnsavedGuard } from '@/lib/client/useUnsavedGuard';
import { safeNext } from '@/lib/client/safeNext';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';

/** The tab pins a stable profile ID in sessionStorage. Cookies are only the
 * initial preference of a new tab; each scoped API request carries the ID.
 * Background refresh keeps the editor mounted and pauses writes until verified. */

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
  /** 普通配置文件 / 模版。存量记录经 schema parse-forward 后总是有值。 */
  kind?: 'normal' | 'template';
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
  /**
   * 切换正在编辑的配置文件:写 cookie 并重载页面以按新作用域重新取数。
   * 传 `redirectTo` 则重载到该路径(例:从别的配置文件的设置页跳去它的设备页)。
   */
  setActiveProfile: (name: string, redirectTo?: string) => void;
  /** 清除 active cookie 并回退到 current(无重载)—— 删除当前活动配置文件后调用。 */
  clearActiveProfile: () => void;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** True only after the current profile list has been read successfully. */
  scopeConfirmed: boolean;
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
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pinnedId = useRef<string | null>(
    typeof window === 'undefined' ? null : sessionStorage.getItem('pm.profileId'),
  );
  const [activeProfile, setActive] = useState<Profile | null>(null);
  const [sessionStarted] = useState(() => {
    if (typeof window !== 'undefined') startProfileSession();
    return true;
  });
  void sessionStarted;
  const reloadGeneration = useRef(0);
  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    setLoading(true);
    if (pinnedId.current) bindProfileSession(pinnedId.current, false);
    setError(null);
    try {
      const r = await api<{ data: Profile[] }>('/api/v1/profiles');
      if (generation !== reloadGeneration.current) return;
      const preference = readActiveCookie();
      const selected = pinnedId.current
        ? r.data.find((p) => p.id === pinnedId.current)
        : preference
          ? r.data.find((p) => p.name === preference)
          : (r.data.find((p) => p.name === 'default') ?? r.data[0]);
      setProfiles(r.data);
      if (!selected && (pinnedId.current || preference)) {
        throw new Error('当前配置文件已不存在，请重新选择。草稿已保留。');
      }
      pinnedId.current = selected?.id ?? null;
      bindProfileSession(selected?.id ?? null, Boolean(selected));
      setActive(selected ?? null);
      if (selected) sessionStorage.setItem('pm.profileId', selected.id);
    } catch (caught) {
      if (generation !== reloadGeneration.current) return;
      // Keep the last successful list, but never present a first-load failure
      // as an empty instance or manufacture a default profile.
      bindProfileSession(pinnedId.current, false);
      setError(caught instanceof Error ? caught.message : '无法读取配置文件列表');
    } finally {
      if (generation === reloadGeneration.current) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const current = useMemo(
    () => profiles.find((p) => p.name === 'default') ?? profiles[0] ?? null,
    [profiles],
  );

  const scopeConfirmed = loaded && !loading && !error && activeProfile !== null;

  const setActiveProfile = useCallback(
    (name: string, redirectTo?: string) => {
      const target = profiles.find((p) => p.name === name);
      if (!target) return;
      navigateWithUnsavedGuard(() => {
        sessionStorage.setItem('pm.profileId', target.id);
        document.cookie = `${ACTIVE_PROFILE_COOKIE}=${encodeURIComponent(name)}; path=/; max-age=31536000; SameSite=Lax`;
        if (redirectTo) window.location.href = safeNext(redirectTo, window.location.origin);
        else window.location.reload();
      }, true);
    },
    [profiles],
  );

  const clearActiveProfile = useCallback(() => {
    // Drop the cookie (max-age=0) and fall back to `current` in memory, so a
    // deleted active profile can't leave a stale cookie that 404s scoped routes.
    document.cookie = `${ACTIVE_PROFILE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    sessionStorage.removeItem('pm.profileId');
    pinnedId.current = null;
    bindProfileSession(null, false);
    setActive(null);
  }, []);

  const value = useMemo<ProfilesValue>(
    () => ({
      profiles,
      current,
      activeProfile,
      setActiveProfile,
      clearActiveProfile,
      loading,
      loaded,
      error,
      scopeConfirmed,
      reload,
    }),
    [
      profiles,
      current,
      activeProfile,
      setActiveProfile,
      clearActiveProfile,
      loading,
      loaded,
      error,
      scopeConfirmed,
      reload,
    ],
  );

  return <ProfilesContext.Provider value={value}>{children}</ProfilesContext.Provider>;
}

export function useProfiles(): ProfilesValue {
  const ctx = useContext(ProfilesContext);
  if (!ctx) throw new Error('useProfiles must be used within ProfilesProvider');
  return ctx;
}

export type ProfileScopeAccess = 'loading' | 'error' | 'empty' | 'ready';

export function deriveProfileScopeAccess(input: {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  hasActiveProfile: boolean;
}): ProfileScopeAccess {
  if (input.loading || !input.loaded) return 'loading';
  if (input.error) return 'error';
  return input.hasActiveProfile ? 'ready' : 'empty';
}

export function ProfileReadErrorBanner() {
  const { error, loading, reload } = useProfiles();
  if (!error) return null;
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        marginBottom: 18,
        padding: '12px 14px',
        borderRadius: 'var(--r-md)',
        color: 'var(--danger)',
        background: 'var(--danger-dim)',
      }}
    >
      <div style={{ flex: '1 1 280px' }}>
        <strong style={{ display: 'block' }}>无法读取配置文件列表</strong>
        <span style={{ display: 'block', marginTop: 2, color: 'var(--fg-2)', fontSize: 12.5 }}>
          当前未确认编辑作用域。依赖配置文件的入口已暂停，现有数据没有被修改。
        </span>
      </div>
      <button
        type="button"
        className="btn sm"
        disabled={loading}
        aria-busy={loading}
        onClick={() => void reload()}
      >
        {loading ? '正在重试' : '重试'}
      </button>
    </div>
  );
}

export function ProfileScopeBoundary({ children }: { children: React.ReactNode }) {
  const { activeProfile, loading, loaded, error, reload } = useProfiles();
  const access = deriveProfileScopeAccess({
    loading,
    loaded,
    error,
    hasActiveProfile: activeProfile !== null,
  });

  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (access === 'ready') setMounted(true);
  }, [access]);
  if (mounted || access === 'ready') {
    return (
      <div data-profile-scope={activeProfile?.id} style={{ display: 'contents' }}>
        {access !== 'ready' && (
          <div role="alert" className="panel" style={{ padding: 16, marginBottom: 16 }}>
            {loading
              ? '正在重新确认配置，保存已暂停，草稿已保留。'
              : (error ?? '配置已不可用，草稿已保留。')}
            {!loading && (
              <button className="btn sm" onClick={() => void reload()}>
                重试读取
              </button>
            )}
          </div>
        )}
        <fieldset
          disabled={access !== 'ready'}
          style={{ display: 'contents', border: 0, padding: 0, margin: 0, minWidth: 0 }}
        >
          {children}
        </fieldset>
      </div>
    );
  }

  if (access === 'loading') {
    return (
      <ProfileScopeState
        title="正在确认编辑作用域"
        detail="配置文件列表读取完成前，当前页面及其保存快捷键保持暂停。"
        busy
      />
    );
  }

  if (access === 'error') {
    return (
      <ProfileScopeState
        title="配置编辑已暂停"
        detail={
          activeProfile
            ? '上次读取的配置文件仍显示在导航中，但当前结果未经重新确认，因此页面保持只读阻断，保存按钮和快捷键不会挂载。'
            : '当前无法确认要编辑的配置文件，因此页面、保存按钮和快捷键均未挂载。'
        }
        error={error ?? '无法读取配置文件列表'}
        onRetry={() => void reload()}
      />
    );
  }

  if (access === 'empty') {
    return (
      <ProfileScopeState
        title="没有可编辑的配置文件"
        detail="当前没有已确认的配置文件作用域。请返回首次设置或配置文件管理页检查状态。"
      />
    );
  }

  return children;
}

function ProfileScopeState({
  title,
  detail,
  error,
  busy,
  onRetry,
}: {
  title: string;
  detail: string;
  error?: string;
  busy?: boolean;
  onRetry?: () => void;
}) {
  function signOut() {
    navigateWithUnsavedGuard(() => {
      clearAdminKey();
      window.location.href = '/login';
    }, true);
  }

  return (
    <section
      className="panel"
      style={{ width: 'min(620px, 100%)', margin: 'clamp(24px, 8vh, 80px) auto' }}
      role={error ? 'alert' : 'status'}
      aria-live={error ? 'assertive' : 'polite'}
      aria-busy={busy || undefined}
    >
      <div className="panel-body">
        <span className={`pill ${error ? 'err' : busy ? 'idle' : 'warn'}`}>
          {error ? '读取失败' : busy ? '确认中' : '未确认'}
        </span>
        <h1 style={{ margin: '16px 0 8px', fontSize: 24 }}>{title}</h1>
        <p style={{ margin: 0, color: 'var(--muted)', lineHeight: 1.7 }}>{detail}</p>
        {error && (
          <p style={{ margin: '14px 0 0', color: 'var(--danger)', overflowWrap: 'anywhere' }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
          {onRetry && (
            <button type="button" className="btn primary" onClick={onRetry}>
              重新读取
            </button>
          )}
          {error && (
            <button type="button" className="btn" onClick={signOut}>
              退出登录
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
