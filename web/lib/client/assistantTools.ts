'use client';

/**
 * Browser-side tools — the assistant's "用户算力" tools that run entirely in
 * the page, no server round-trip. Each returns the same `ToolDispatchResult`
 * shape as the server dispatcher so the orchestrator treats them uniformly.
 *
 * `preview_proxy_group_members` is the poster child: pure regex matching over
 * the live node list (already client-available via /api/v1/preview/default),
 * using the shared `matchFilter`. Anything not registered here falls through
 * to POST /api/v1/assistant/tool.
 */

import { api } from '@/lib/client/api';
import { matchFilter } from '@/lib/proxies/filterMatch';
import type { ToolDispatchResult } from '@/lib/ai/toolDispatchTypes';
import type { ProxyGroup } from '@/schemas';

const MAX_PREVIEW_NAMES = 200;

/**
 * Cache the resolved node list per profile for the page session; the model may
 * call preview many times. Keyed by profile so switching scope doesn't serve a
 * stale other-profile node list (P1-9).
 */
const nodeNamesByProfile = new Map<string, Promise<string[]>>();
function getNodeNames(profile: string): Promise<string[]> {
  let promise = nodeNamesByProfile.get(profile);
  if (!promise) {
    promise = api<{ data: { node_names?: string[] } }>(
      `/api/v1/preview/default`, { profileId: profile },
    )
      .then((r) => r.data.node_names ?? [])
      .catch(() => {
        nodeNamesByProfile.delete(profile); // allow retry on next call
        return [];
      });
    nodeNamesByProfile.set(profile, promise);
  }
  return promise;
}

interface PreviewInput {
  id?: string;
  filter?: string;
  exclude_filter?: string;
}

async function previewProxyGroupMembers(input: PreviewInput, profileId: string): Promise<ToolDispatchResult> {
  const names = await getNodeNames(profileId);
  let filter = input.filter;
  let excludeFilter = input.exclude_filter;
  let group: string | null = null;

  if (input.id) {
    try {
      const res = await api<{ data: ProxyGroup }>(`/api/v1/proxy-groups/${input.id}`, { profileId });
      group = res.data.name;
      if (filter === undefined) filter = res.data.filter;
      if (excludeFilter === undefined) excludeFilter = res.data['exclude-filter'];
    } catch {
      const data = { error: `策略组 ${input.id} 不存在或无法读取。` };
      return { kind: 'error', data, modelContent: JSON.stringify(data) };
    }
  }

  const res = matchFilter(names, filter, excludeFilter);
  const truncated = res.matched.length > MAX_PREVIEW_NAMES;
  const data = {
    group,
    filter: filter ?? null,
    'exclude-filter': excludeFilter ?? null,
    poolSize: names.length,
    matchedCount: res.matched.length,
    matched: truncated ? res.matched.slice(0, MAX_PREVIEW_NAMES) : res.matched,
    truncated,
    regexError: res.error,
    hint: names.length === 0 ? '尚未生成解析快照——让用户打开「最终配置」预览一次再查。' : undefined,
  };
  return { kind: 'proxy-group-members', data, modelContent: JSON.stringify(data) };
}

type ClientTool = (input: unknown, profileId: string) => Promise<ToolDispatchResult>;

const CLIENT_TOOLS: Record<string, ClientTool> = {
  preview_proxy_group_members: (input, profileId) => previewProxyGroupMembers((input ?? {}) as PreviewInput, profileId),
};

export function isClientTool(name: string): boolean {
  return name in CLIENT_TOOLS;
}

export function runClientTool(name: string, input: unknown, profileId: string): Promise<ToolDispatchResult> {
  return CLIENT_TOOLS[name](input, profileId);
}
