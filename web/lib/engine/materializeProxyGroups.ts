import { parse, stringify } from 'yaml';
import { validateFinalRenderedConfig } from '@/lib/engine/resolve';
import { ProblemDetailsError } from '@/lib/http/problem';
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

function adapterType(type: string): string {
  switch (type) {
    case 'ss':
      return 'shadowsocks';
    case 'ssr':
      return 'shadowsocksr';
    case 'select':
      return 'selector';
    default:
      return type.toLowerCase().replaceAll('-', '');
  }
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
  const groupNames: string[] = [];
  try {
    const document = parse(content);
    if (
      !isYamlMap(document) ||
      !Array.isArray(document.proxies) ||
      !Array.isArray(document['proxy-groups'])
    ) {
      validateFinalRenderedConfig(content);
      return content;
    }

    const nodeNames = document.proxies.flatMap((proxy) =>
      isYamlMap(proxy) && typeof proxy.name === 'string' ? [proxy.name] : [],
    );
    const memberTypes = new Map<string, string>([
      ['DIRECT', 'direct'],
      ['REJECT', 'reject'],
      ['REJECT-DROP', 'rejectdrop'],
      ['COMPATIBLE', 'compatible'],
      ['PASS', 'pass'],
      ['PASS-RULE', 'passrule'],
    ]);
    for (const member of [...document.proxies, ...document['proxy-groups']]) {
      if (isYamlMap(member) && typeof member.name === 'string' && typeof member.type === 'string') {
        memberTypes.set(member.name, adapterType(member.type));
      }
    }
    let changed = false;
    const hasProviders =
      isYamlMap(document['proxy-providers']) && Object.keys(document['proxy-providers']).length > 0;

    for (const group of document['proxy-groups']) {
      if (!isYamlMap(group)) continue;
      if (group['include-all-proxies'] !== true && group['include-all'] !== true) continue;
      groupNames.push(typeof group.name === 'string' ? group.name : '(unnamed)');
      if (
        stringMembers(group.use).length > 0 ||
        (hasProviders && (group['include-all'] === true || group['include-all-providers'] === true))
      )
        continue;

      const filter = typeof group.filter === 'string' ? group.filter : undefined;
      const excludeFilter =
        typeof group['exclude-filter'] === 'string' ? group['exclude-filter'] : undefined;
      const { matched, error } = matchFilter(nodeNames, filter, excludeFilter);
      if (error) {
        throw new Error(
          `无法展开策略组 ${typeof group.name === 'string' ? group.name : '(unnamed)'}: ${error}`,
        );
      }

      const explicit = matchFilter(stringMembers(group.proxies), undefined, excludeFilter);
      if (explicit.error) throw new Error(explicit.error);

      const excludedTypes = new Set(
        typeof group['exclude-type'] === 'string'
          ? group['exclude-type'].toLowerCase().split('|')
          : [],
      );
      const members = [...new Set([...explicit.matched, ...matched])].filter(
        (name) => !excludedTypes.has(memberTypes.get(name) ?? ''),
      );
      if (members.length === 0) {
        if (typeof group['empty-fallback'] === 'string') {
          members.push(group['empty-fallback']);
        } else {
          continue;
        }
      }
      group.proxies = members;
      delete group['include-all-proxies'];
      delete group['include-all'];
      delete group['empty-fallback'];
      delete group.filter;
      delete group['exclude-filter'];
      delete group['exclude-type'];
      changed = true;
    }

    const output = changed ? stringify(document) : content;
    validateFinalRenderedConfig(output);
    return output;
  } catch {
    throw ProblemDetailsError.unprocessable(
      `无法展开策略组 ${groupNames.join('、') || '(unnamed)'}：展开后的配置未通过最终校验。`,
    );
  }
}
