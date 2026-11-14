'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { useGroups, useProfiles } from '@/ui/data/hooks';
import type { Profile } from '@/ui/data/types';
import { LineColorProvider } from '@/ui/viz/lines';

const LAST_PROFILE = 'pm.last-profile';

export function rememberProfile(name: string) {
  try {
    window.localStorage.setItem(LAST_PROFILE, name);
  } catch {
    /* ignore */
  }
}

export function lastProfileName(): string | null {
  try {
    return window.localStorage.getItem(LAST_PROFILE);
  } catch {
    return null;
  }
}

export const profilePath = (name: string, sub?: string) =>
  `/p/${encodeURIComponent(name)}${sub ? `/${sub.replace(/^\//, '')}` : ''}`;

interface ScopeValue {
  profile: Profile;
  profileId: string;
  profiles: Profile[];
  path: (sub?: string) => string;
}

const ScopeContext = createContext<ScopeValue | null>(null);

/** Profile name from the URL (`/p/[profile]/…`), or null outside a profile scope. */
export function useRouteProfileName(): string | null {
  const params = useParams<{ profile?: string }>();
  return params?.profile ? decodeURIComponent(params.profile) : null;
}

export function ScopeProvider({ profile, profiles, children }: { profile: Profile; profiles: Profile[]; children: ReactNode }) {
  useEffect(() => rememberProfile(profile.name), [profile.name]);
  return (
    <ScopeContext.Provider
      value={{ profile, profileId: profile.id, profiles, path: (sub) => profilePath(profile.name, sub) }}
    >
      {children}
    </ScopeContext.Provider>
  );
}

/**
 * Line colours follow the active profile's groups, app-wide (palette, panels, pages).
 * The order depends only on group definitions — never on rules — so a group keeps its
 * colour while rules change. Groups people route traffic to (manual picks, bound
 * sources) claim distinct colours first; node pools (filter / all) fill in after, by rank.
 */
export function ActiveLineColors({ children }: { children: ReactNode }) {
  const profile = useActiveProfile();
  const groups = useGroups(profile?.id ?? null);
  const names = (groups.data ?? [])
    .slice()
    .sort((a, b) => {
      const pa = a.kind === 'filter' || a.kind === 'all' ? 1 : 0;
      const pb = b.kind === 'filter' || b.kind === 'all' ? 1 : 0;
      return pa - pb || a.rank - b.rank;
    })
    .map((g) => g.name);
  return <LineColorProvider groupNames={names}>{children}</LineColorProvider>;
}

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext);
  if (!value) throw new Error('useScope must be used inside a /p/[profile] route');
  return value;
}

export function useOptionalScope(): ScopeValue | null {
  return useContext(ScopeContext);
}

/** Active profile for global pages: the URL one, else the remembered one, else the first. */
export function useActiveProfile(): Profile | null {
  const routeName = useRouteProfileName();
  const { data: profiles } = useProfiles();
  if (!profiles?.length) return null;
  const wanted = routeName ?? (typeof window !== 'undefined' ? lastProfileName() : null);
  return (
    profiles.find((p) => p.name === wanted) ??
    profiles.find((p) => p.name === 'default' && p.kind !== 'template') ??
    profiles.find((p) => p.kind !== 'template') ??
    profiles[0]
  );
}
