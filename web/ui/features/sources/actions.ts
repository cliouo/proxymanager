'use client';

import { api, request } from '@/ui/data/api';
import { refreshShared } from '@/ui/data/hooks';
import type { CollectionUpdate, SourceUsage, SubscriptionUpdate } from '@/ui/data/types';
import { confirmAction, notify } from '@/ui/primitives';
import { sourceTitle, type Pool, type Source } from './model';

export const ifMatch = (updatedAt: number | undefined) =>
  updatedAt !== undefined ? { 'If-Match': String(updatedAt) } : undefined;

export function patchSource(source: Pick<Source, 'id' | 'updated_at'>, patch: SubscriptionUpdate) {
  return api.patch<Source>(`/subscriptions/${source.id}`, patch, undefined, ifMatch(source.updated_at));
}

export function patchPool(pool: Pick<Pool, 'id' | 'updated_at'>, patch: CollectionUpdate) {
  return api.patch<Pool>(`/collections/${pool.id}`, patch, undefined, ifMatch(pool.updated_at));
}

/** Server-side fetch of the upstream right now (remote, auto mode only). */
export async function refreshSource(source: Source, quiet = false): Promise<boolean> {
  try {
    const res = await request<{ data: Source; meta?: { proxyCount?: number } }>(`/subscriptions/${source.id}/refresh`, {
      method: 'POST',
      body: {},
    });
    if (!quiet) notify.success(`已刷新「${sourceTitle(source)}」`, res.meta?.proxyCount !== undefined ? `拉到 ${res.meta.proxyCount} 个节点` : undefined);
    return true;
  } catch (error) {
    if (!quiet) notify.error(error, `「${sourceTitle(source)}」刷新失败`);
    return false;
  } finally {
    refreshShared();
  }
}

export async function setSourceEnabled(source: Source, enabled: boolean): Promise<boolean> {
  try {
    await patchSource(source, { enabled });
    notify.success(enabled ? `已启用「${sourceTitle(source)}」` : `已停用「${sourceTitle(source)}」`);
    return true;
  } catch (error) {
    notify.error(error, enabled ? '启用失败' : '停用失败');
    return false;
  } finally {
    refreshShared();
  }
}

export async function setPoolEnabled(pool: Pool, enabled: boolean): Promise<boolean> {
  try {
    await patchPool(pool, { enabled });
    notify.success(enabled ? `已启用「${pool.name}」` : `已停用「${pool.name}」`);
    return true;
  } catch (error) {
    notify.error(error, enabled ? '启用失败' : '停用失败');
    return false;
  } finally {
    refreshShared();
  }
}

function usageSentence(usage: SourceUsage | null): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.profiles.length) parts.push(`${usage.profiles.length} 个配置文件（${usage.profiles.map((p) => p.name).join('、')}）`);
  if (usage.collections.length) parts.push(`${usage.collections.length} 个聚合订阅（${usage.collections.map((c) => c.name).join('、')}）`);
  return parts.length ? `它正被 ${parts.join('和')}使用，删除后这些地方会失去它提供的节点。` : '目前没有配置文件或聚合订阅用到它。';
}

async function deleteWithConfirm(kind: 'subscriptions' | 'collections', id: string, label: string): Promise<boolean> {
  const usage = await api.get<SourceUsage>(`/${kind}/${id}/usage`).catch(() => null);
  const ok = await confirmAction({
    title: `删除「${label}」？`,
    description: `${usageSentence(usage)}删除后无法恢复，它的分发链接也会失效。`,
    confirmText: '确认永久删除',
    confirmHint: `永久删除「${label}」`,
    tone: 'danger',
  });
  if (!ok) return false;
  try {
    const result = await api.del<{ warnings?: string[] }>(`/${kind}/${id}`);
    notify.success(`已删除「${label}」`);
    for (const warning of result?.warnings ?? []) notify.warn('请留意', warning);
    return true;
  } catch (error) {
    notify.error(error, '删除失败');
    return false;
  } finally {
    refreshShared();
  }
}

export const deleteSource = (source: Source) => deleteWithConfirm('subscriptions', source.id, sourceTitle(source));
export const deletePool = (pool: Pool) => deleteWithConfirm('collections', pool.id, pool.name);
