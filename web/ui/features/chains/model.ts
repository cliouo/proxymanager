/**
 * 链式代理 view model. The chain list comes from GET /scenarios/chained-proxy;
 * writes go through POST /ops (scenario `chained-proxy`).
 */
import { api } from '@/ui/data/api';
import type { ChainSummary, ParsedConfig, ProxyGroup } from '@/ui/data/types';

export const DEFAULT_TEST_URL = 'http://www.gstatic.com/generate_204';
export const DEFAULT_INTERVAL = 300;

export type Strategy = 'fallback' | 'url-test';

export interface SmartSpec {
  strategy: Strategy;
  filter?: string;
  testUrl: string;
  interval: number;
}

export type ChainView =
  | { kind: 'fixed'; chainName: string; backend: string; front: string }
  | { kind: 'pool'; chainName: string; backend: string; poolName: string; members: string[] }
  | { kind: 'smart'; chainName: string; backend: string; poolName: string; smart: SmartSpec };

const POOL_NOTES = /fronts pool/;

/**
 * The summary classifies "wrap points at a non-wrap group" as a pool chain, so a
 * fixed chain whose front is an ordinary group (e.g. 香港节点) shows up as a pool.
 * Deleting that as a pool would also delete the user's group — so only treat it
 * as a pool when the scenario created the pool (its notes / wrap notes say so).
 */
export function chainViews(summary: ChainSummary, groups: ProxyGroup[]): ChainView[] {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const views: ChainView[] = summary.fixedChains.map((c) => ({ kind: 'fixed', ...c }));
  for (const c of summary.poolChains) {
    const pool = byName.get(c.poolName);
    const wrap = byName.get(c.chainName);
    const owned =
      POOL_NOTES.test(pool?.notes ?? '') || (wrap?.notes ?? '').includes('pool-chain wrap') || c.poolName.startsWith('pool:');
    if (!owned) views.push({ kind: 'fixed', chainName: c.chainName, backend: c.backend, front: c.poolName });
    else if (c.smart) views.push({ kind: 'smart', chainName: c.chainName, backend: c.backend, poolName: c.poolName, smart: c.smart });
    else views.push({ kind: 'pool', chainName: c.chainName, backend: c.backend, poolName: c.poolName, members: c.poolMembers });
  }
  return views;
}

export function runChainOp(profileId: string, op: string, payload: Record<string, unknown>) {
  return api.post<Record<string, unknown>>('/ops', { scenario: 'chained-proxy', op, payload }, { profileId });
}

/** Real nodes (chain wraps are realised as cloned proxies with a dialer — skip those). */
export function nodesOf(parsed: ParsedConfig | undefined) {
  return (parsed?.proxies ?? []).filter((p) => !p.dialerProxy);
}

export const REGION_FILTERS: Array<{ label: string; filter: string }> = [
  { label: '香港', filter: '港|HK|Hong ?Kong' },
  { label: '台湾', filter: '台湾|台北|TW|Taiwan' },
  { label: '日本', filter: '日本|东京|大阪|JP|Japan|Tokyo|Osaka' },
  { label: '新加坡', filter: '新加坡|狮城|SG|Singapore' },
  { label: '美国', filter: '美国|洛杉矶|纽约|圣何塞|US|United States' },
  { label: '韩国', filter: '韩国|首尔|KR|Korea' },
];

export const STRATEGY_META: Record<Strategy, { label: string; description: string }> = {
  fallback: { label: '故障转移', description: '固定用第一个可用的前置，出口更稳定' },
  'url-test': { label: '自动测速', description: '总是切到延迟最低的前置，速度优先' },
};

export function defaultNames(mode: 'fixed' | 'pool' | 'smart', front: string, backend: string) {
  if (mode === 'fixed') return { chainName: `chain:${front || '前置'}-to-${backend || '落地'}`, poolName: '' };
  return { chainName: `chain:pool-to-${backend || '落地'}`, poolName: `pool:${backend || '落地'}` };
}

export function urlError(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : '只支持 http 或 https';
  } catch {
    return '不是合法的网址';
  }
}
