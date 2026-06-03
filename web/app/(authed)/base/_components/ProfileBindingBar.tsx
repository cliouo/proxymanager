'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Select } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';
import type { Collection } from '@/lib/types/collection';
import type { Profile, ProfileSource } from '@/schemas';

/**
 * Per-profile source binding — single-select. A profile pulls nodes from
 * exactly one source: unbound (`none`, the default — injects no subscription
 * nodes), one single subscription, or one 聚合订阅 (collection, whose members
 * merge). Want a hand-picked multi-airport set? Build a collection on the 订阅源
 * page and bind it here — the profile never fans out to an ad-hoc list.
 *
 * If no `default` profile record exists yet (pre `npm run init:default-profile`),
 * we render a hint instead — resolve still works (legacy all-enabled fallback)
 * but binding isn't authored yet.
 */

interface SubLite {
  id: string;
  name: string;
  enabled: boolean;
}

const NONE_VALUE = 'none';
const SUB_PREFIX = 'sub:';
const COL_PREFIX = 'col:';

function sourceToValue(s: ProfileSource | undefined): string {
  if (!s || s.type === 'none') return NONE_VALUE;
  return (s.type === 'subscription' ? SUB_PREFIX : COL_PREFIX) + s.id;
}

function valueToSource(v: string): ProfileSource {
  if (v.startsWith(SUB_PREFIX)) return { type: 'subscription', id: v.slice(SUB_PREFIX.length) };
  if (v.startsWith(COL_PREFIX)) return { type: 'collection', id: v.slice(COL_PREFIX.length) };
  return { type: 'none' };
}

export function ProfileBindingBar() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [subs, setSubs] = useState<SubLite[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profiles, subList, colList] = await Promise.all([
        api<{ data: Profile[] }>('/api/v1/profiles'),
        api<{ data: SubLite[] }>('/api/v1/subscriptions'),
        api<{ data: Collection[] }>('/api/v1/collections'),
      ]);
      const def = profiles.data.find((p) => p.name === 'default') ?? null;
      setProfile(def);
      setSubs(subList.data);
      setCollections(colList.data);
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

  const change = async (value: string) => {
    if (!profile || busy) return;
    const next = valueToSource(value);
    const prior = profile;
    setProfile({ ...profile, source: next });
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/profiles/${profile.id}`, {
        method: 'PATCH',
        body: { source: next },
      });
    } catch (err) {
      setProfile(prior);
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const summary = useMemo(() => {
    const src = profile?.source ?? { type: 'none' as const };
    if (src.type === 'none') return '未绑定 · 不注入任何订阅节点';
    if (src.type === 'subscription') {
      const s = subs.find((x) => x.id === src.id);
      if (!s) return '⚠ 绑定的订阅源已不存在';
      return `单订阅 · ${s.name}${s.enabled ? '' : '(已停用)'}`;
    }
    const c = collections.find((x) => x.id === src.id);
    if (!c) return '⚠ 绑定的聚合订阅已不存在';
    return `聚合订阅 · ${c.name} · ${c.subscription_ids.length} 成员`;
  }, [profile, subs, collections]);

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
    <div className="shrink-0 px-6 py-2.5 border-b border-[var(--color-border)] flex items-center gap-3 flex-wrap">
      <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] shrink-0">
        节点来源
      </span>
      <div className="w-64 shrink-0">
        <Select
          value={sourceToValue(profile.source)}
          onChange={(e) => change(e.target.value)}
          disabled={busy}
        >
          <option value={NONE_VALUE}>未绑定(不注入订阅节点)</option>
          {subs.length > 0 && (
            <optgroup label="单订阅">
              {subs.map((s) => (
                <option key={s.id} value={SUB_PREFIX + s.id}>
                  {s.name}
                  {s.enabled ? '' : '(停用)'}
                </option>
              ))}
            </optgroup>
          )}
          {collections.length > 0 && (
            <optgroup label="聚合订阅">
              {collections.map((c) => (
                <option key={c.id} value={COL_PREFIX + c.id}>
                  {c.name}({c.subscription_ids.length})
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </div>
      <span className="text-[12px] text-[var(--color-muted)] truncate">{summary}</span>
      {collections.length === 0 && (
        <span className="text-[11px] text-[var(--color-muted)] ml-auto whitespace-nowrap">
          想合并多个机场?到「订阅源 › 聚合订阅」建一个再来选
        </span>
      )}
      {error && (
        <span className="text-[11px] text-[var(--color-danger)] w-full">{error}</span>
      )}
    </div>
  );
}
