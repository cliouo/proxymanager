'use client';

import { api } from '@/ui/data/api';
import { keys } from '@/ui/data/hooks';
import { setQueryData } from '@/ui/data/query';
import type { Profile, ProfileCreate, ProfileSource, ProfileUpdate } from '@/ui/data/types';

export const profileApi = {
  create: (input: ProfileCreate) => api.post<Profile>('/profiles', input),
  update: (id: string, patch: ProfileUpdate) => api.patch<Profile>(`/profiles/${id}`, patch),
  remove: (id: string) => api.del(`/profiles/${id}`),
};

/** The anchor profile: the server refuses to rename or delete it. */
export const DEFAULT_PROFILE = 'default';

const byName = (a: Profile, b: Profile) => a.name.localeCompare(b.name);

/** Reflect a write in the cached list right away (the server list is refetched right after). */
export function cacheProfile(profile: Profile) {
  setQueryData<Profile[]>(keys.profiles, (list) =>
    [...(list ?? []).filter((p) => p.id !== profile.id), profile].sort(byName),
  );
}

export function uncacheProfile(id: string) {
  setQueryData<Profile[]>(keys.profiles, (list) => (list ?? []).filter((p) => p.id !== id));
}

/* ─── slug ───────────────────────────────────────────────────────────── */

const SLUG = /^[a-z0-9-]+$/;

export function slugError(slug: string, taken: readonly string[]): string | null {
  if (!slug) return '请填写标识';
  if (!SLUG.test(slug)) return '只能用小写字母、数字和 -';
  if (taken.includes(slug)) return '已经有同名的配置文件';
  return null;
}

/** Best-effort ASCII slug ("Travel Lite" → "travel-lite"); empty when nothing usable (e.g. Chinese). */
export function suggestSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** First free `{base}`, `{base}-2`, `{base}-3` … */
export function freeSlug(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
  return base;
}

/* ─── node source draft ──────────────────────────────────────────────── */

export type SourceMode = ProfileSource['type'];

/** Form state for the single-select node source (an id may still be missing while editing). */
export interface SourceDraft {
  mode: SourceMode;
  id: string | null;
}

export function draftOf(source: ProfileSource | undefined): SourceDraft {
  return !source || source.type === 'none' ? { mode: 'none', id: null } : { mode: source.type, id: source.id };
}

/** null while a subscription / collection is chosen but no item picked yet. */
export function sourceOf(draft: SourceDraft): ProfileSource | null {
  if (draft.mode === 'none') return { type: 'none' };
  return draft.id ? { type: draft.mode, id: draft.id } : null;
}

export function sameSource(a: ProfileSource | undefined, b: ProfileSource | null): boolean {
  const left = a ?? { type: 'none' as const };
  if (!b) return false;
  if (left.type !== b.type) return false;
  return left.type === 'none' || (b.type !== 'none' && left.id === b.id);
}
