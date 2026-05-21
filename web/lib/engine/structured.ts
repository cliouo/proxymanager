/**
 * Structured projection of base.yaml — exposes proxies and proxy-groups in
 * enough detail for scenario UIs (chained-proxy, regional-groups, ...) to
 * build their own views without each parsing the YAML themselves.
 *
 * Keep this read-only and fast — handlers call it on every request.
 */

import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

export interface ProxySummary {
  name: string;
  /** Mihomo proxy type (`ss`, `vmess`, `vless`, `direct`, ...). */
  type: string;
  /** Mihomo chain field. Points at either a proxy name (fixed chain) or a proxy-group name (pool chain). */
  dialerProxy?: string;
  /** Sub-host shown to disambiguate similarly-named nodes. */
  server?: string;
}

export interface ProxyGroupSummary {
  name: string;
  /** `select`, `url-test`, `fallback`, `load-balance`, etc. */
  type: string;
  /** Member names in order. */
  proxies: string[];
  dialerProxy?: string;
}

export interface StructuredBase {
  proxies: ProxySummary[];
  proxyGroups: ProxyGroupSummary[];
}

export function extractStructured(content: string): StructuredBase {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML: ${doc.errors[0].message}`);
  }
  return {
    proxies: extractProxies(doc),
    proxyGroups: extractProxyGroups(doc),
  };
}

function extractProxies(doc: Document): ProxySummary[] {
  const seq = doc.get('proxies', true);
  if (!isSeq(seq)) return [];
  const out: ProxySummary[] = [];
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const name = scalarString(item.get('name', true));
    if (!name) continue;
    out.push({
      name,
      type: scalarString(item.get('type', true)) ?? 'unknown',
      dialerProxy: scalarString(item.get('dialer-proxy', true)),
      server: scalarString(item.get('server', true)),
    });
  }
  return out;
}

function extractProxyGroups(doc: Document): ProxyGroupSummary[] {
  const seq = doc.get('proxy-groups', true);
  if (!isSeq(seq)) return [];
  const out: ProxyGroupSummary[] = [];
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const name = scalarString(item.get('name', true));
    if (!name) continue;
    const members: string[] = [];
    const proxiesNode = item.get('proxies', true);
    if (isSeq(proxiesNode)) {
      for (const m of proxiesNode.items) {
        if (isScalar(m) && typeof m.value === 'string') members.push(m.value);
      }
    }
    out.push({
      name,
      type: scalarString(item.get('type', true)) ?? 'unknown',
      proxies: members,
      dialerProxy: scalarString(item.get('dialer-proxy', true)),
    });
  }
  return out;
}

function scalarString(node: unknown): string | undefined {
  if (!node) return undefined;
  if (isScalar(node) && typeof node.value === 'string') return node.value;
  return undefined;
}
