import { parse, stringify } from 'yaml';
import { matchFilter } from '@/lib/proxies/filterMatch';

type YamlMap = Record<string, unknown>;

function isYamlMap(value: unknown): value is YamlMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringMembers(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Expands Mihomo's dynamic `include-all-proxies` groups into explicit members.
 *
 * Some clients, including Shadowrocket, retain the group type but do not
 * populate its members.  This is a delivery-only transformation: the stored
 * profile keeps its dynamic filters and each download is matched against the
 * current injected proxy list.
 */
export function materializeDynamicProxyGroups(content: string): string {
  const document = parse(content);
  if (
    !isYamlMap(document) ||
    !Array.isArray(document.proxies) ||
    !Array.isArray(document['proxy-groups'])
  ) {
    return content;
  }

  const nodeNames = document.proxies.flatMap((proxy) =>
    isYamlMap(proxy) && typeof proxy.name === 'string' ? [proxy.name] : [],
  );
  let changed = false;

  for (const group of document['proxy-groups']) {
    if (!isYamlMap(group)) continue;
    if (group['include-all-proxies'] !== true && group['include-all'] !== true) continue;

    const filter = typeof group.filter === 'string' ? group.filter : undefined;
    const excludeFilter =
      typeof group['exclude-filter'] === 'string' ? group['exclude-filter'] : undefined;
    const { matched, error } = matchFilter(nodeNames, filter, excludeFilter);
    if (error) {
      throw new Error(
        `无法展开策略组 ${typeof group.name === 'string' ? group.name : '(unnamed)'}: ${error}`,
      );
    }

    // Combine explicit members with the currently-matched names, then keep the
    // original filter so clients that understand it can re-filter on top of
    // the delivered list. Members are rewritten rather than deleted, which
    // keeps Shadowrocket happy, while Mihomo/Clash.Meta semantics are kept
    // by retaining `filter` and `exclude-filter` (they continue to apply to
    // `include-all`-style dynamic pools).
    const members = [...new Set([...stringMembers(group.proxies), ...matched])];
    group.proxies = members;
    delete group['include-all-proxies'];
    delete group['include-all'];
    delete group['empty-fallback'];
    if (filter === undefined) delete group.filter;
    if (excludeFilter === undefined) delete group['exclude-filter'];
    changed = true;
  }

  return changed ? stringify(document) : content;
}
