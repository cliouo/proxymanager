'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { useProfiles } from '@/components/profile/ProfileContext';
import type { Collection } from '@/lib/types/collection';
import type { ProfileSource } from '@/schemas';
import styles from '../base.module.css';

/**
 * Per-profile source binding — single-select, for the ACTIVE editing profile
 * (Phase 2). A profile pulls nodes from exactly one source: unbound (`none` —
 * injects no subscription nodes), one single subscription, or one 聚合订阅
 * (collection, whose members merge). Want a hand-picked multi-airport set? Build
 * a collection on the 订阅源 page and bind it here — the profile never fans out
 * to an ad-hoc list.
 *
 * If no profile record exists yet (pre `npm run init:default-profile`), we
 * render a hint instead.
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
  const { activeProfile, reload } = useProfiles();
  const [subs, setSubs] = useState<SubLite[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Optimistic override of the active profile's source while a PATCH is in flight.
  const [pendingSource, setPendingSource] = useState<ProfileSource | null>(null);

  const profile = activeProfile;
  const source: ProfileSource = useMemo(
    () => pendingSource ?? profile?.source ?? { type: 'none' },
    [pendingSource, profile],
  );

  const load = useCallback(async () => {
    try {
      const [subList, colList] = await Promise.all([
        api<{ data: SubLite[] }>('/api/v1/subscriptions'),
        api<{ data: Collection[] }>('/api/v1/collections'),
      ]);
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
    setPendingSource(next);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/profiles/${profile.id}`, {
        method: 'PATCH',
        body: { source: next },
      });
      await reload(); // refresh the shared profiles list (switcher + this bar)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setPendingSource(null);
      setBusy(false);
    }
  };

  const summary = useMemo(() => {
    const src = source;
    if (src.type === 'none') return '未绑定 · 不注入任何订阅节点';
    if (src.type === 'subscription') {
      const s = subs.find((x) => x.id === src.id);
      if (!s) return '⚠ 绑定的订阅源已不存在';
      return `单订阅 · ${s.name}${s.enabled ? '' : '(已停用)'}`;
    }
    const c = collections.find((x) => x.id === src.id);
    if (!c) return '⚠ 绑定的聚合订阅已不存在';
    return `聚合订阅 · ${c.name} · ${c.subscription_ids.length} 成员`;
  }, [source, subs, collections]);

  if (!loaded) return null;

  if (!profile) {
    return (
      <div className={styles.warnStrip}>
        配置文件未初始化 ——{' '}
        <code>npm run init:default-profile -- --commit</code> 后刷新。
      </div>
    );
  }

  return (
    <div className={styles.bindBar}>
      <span className={styles.label}>
        节点来源<span className="sh"> · {profile.name}</span>
      </span>
      <select
        className="input mono"
        style={{ width: 256, flex: 'none' }}
        value={sourceToValue(source)}
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
      </select>
      <span className={styles.summary}>{summary}</span>
      {collections.length === 0 && (
        <span className={styles.hintRight}>
          想合并多个机场?到「订阅源 › 聚合订阅」建一个再来选
        </span>
      )}
      {error && <span className={styles.err}>{error}</span>}
    </div>
  );
}
