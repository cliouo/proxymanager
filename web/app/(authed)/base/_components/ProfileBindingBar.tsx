'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import type { Profile } from '@/schemas';

/**
 * Per-profile subscription binding strip — Phase 1 of multi-profile management.
 * Shows every subscription as a toggle chip; click flips its membership in the
 * default profile's `subscription_ids`. Empty binding falls back to "every
 * enabled sub" (resolveConfig's pre-Profile behaviour) so removing it all is
 * legitimate, not broken.
 *
 * If no `default` profile record exists yet (pre `npm run init:default-profile`),
 * we render a hint instead — resolve still works (legacy fallback) but binding
 * isn't authored yet.
 */

interface SubLite {
  id: string;
  name: string;
  enabled: boolean;
}

export function ProfileBindingBar() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [subs, setSubs] = useState<SubLite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profiles, subList] = await Promise.all([
        api<{ data: Profile[] }>('/api/v1/profiles'),
        api<{ data: SubLite[] }>('/api/v1/subscriptions'),
      ]);
      const def = profiles.data.find((p) => p.name === 'default') ?? null;
      setProfile(def);
      setSubs(subList.data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (subId: string) => {
    if (!profile || busy) return;
    const has = profile.subscription_ids.includes(subId);
    const next = has
      ? profile.subscription_ids.filter((id) => id !== subId)
      : [...profile.subscription_ids, subId];
    const prior = profile;
    // optimistic
    setProfile({ ...profile, subscription_ids: next });
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/profiles/${profile.id}`, {
        method: 'PATCH',
        body: { subscription_ids: next },
      });
    } catch (err) {
      setProfile(prior);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  if (!profile) {
    return (
      <div className="shrink-0 px-6 py-2 text-[12px] border-b border-[var(--color-border)] bg-[#F5E5C9]/40 text-[var(--color-warn)]">
        默认 profile 未初始化 ——{' '}
        <code className="font-mono">npm run init:default-profile -- --commit</code> 后刷新。
        在此之前所有 <code className="font-mono">enabled</code> 订阅源都会注入(legacy fallback)。
      </div>
    );
  }

  return (
    <div className="shrink-0 px-6 py-2.5 border-b border-[var(--color-border)] flex items-center gap-2 flex-wrap">
      <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] shrink-0 mr-1">
        绑定订阅源
      </span>
      {subs.length === 0 ? (
        <span className="text-[12px] text-[var(--color-muted)]">
          (无订阅源,先到「订阅源」页添加)
        </span>
      ) : (
        subs.map((s) => {
          const bound = profile.subscription_ids.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              disabled={busy}
              onClick={() => toggle(s.id)}
              title={!s.enabled ? '该订阅源已停用 — 即使绑定也不会注入' : undefined}
              className={`px-2.5 py-0.5 rounded border text-[12px] transition-colors ${
                bound
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-fg)]'
              } ${!s.enabled ? 'opacity-60' : ''}`}
            >
              {bound ? '✓ ' : ''}
              {s.name}
              {!s.enabled ? ' (停用)' : ''}
            </button>
          );
        })
      )}
      <span className="text-[11px] text-[var(--color-muted)] ml-auto whitespace-nowrap">
        {profile.subscription_ids.length === 0
          ? '空绑定 = 用全部 enabled'
          : `已绑 ${profile.subscription_ids.length}/${subs.length}`}
      </span>
      {error && (
        <span className="text-[11px] text-[var(--color-danger)] w-full">{error}</span>
      )}
    </div>
  );
}
