'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';

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

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ data: Profile[] }>('/api/v1/profiles');
      setProfiles(r.data);
    } catch (caught) {
      // Keep the last successful list, but never present a first-load failure
      // as an empty instance or manufacture a default profile.
      setError(caught instanceof Error ? caught.message : '无法读取配置文件列表');
    } finally {
      setLoading(false);
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
  const scopeConfirmed = loaded && !loading && !error && activeProfile !== null;

  const setActiveProfile = useCallback((name: string, redirectTo?: string) => {
    // Persist for the server (resolveScopeProfile) and reload so every
    // scope-reading fetch re-runs under the new cookie.
    document.cookie = `${ACTIVE_PROFILE_COOKIE}=${encodeURIComponent(name)}; path=/; max-age=31536000; SameSite=Lax`;
    // 只接受站内路径("/x" 而非 "//host" 或绝对 URL),杜绝未来调用方引入 open redirect。
    if (redirectTo && redirectTo.startsWith('/') && !redirectTo.startsWith('//')) {
      window.location.href = redirectTo;
    } else {
      window.location.reload();
    }
  }, []);

  const clearActiveProfile = useCallback(() => {
    // Drop the cookie (max-age=0) and fall back to `current` in memory, so a
    // deleted active profile can't leave a stale cookie that 404s scoped routes.
    document.cookie = `${ACTIVE_PROFILE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    setActiveName(null);
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
    clearAdminKey();
    window.location.href = '/login';
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
