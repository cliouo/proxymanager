import { parseProxyUriList } from '../../lib/proxies/uriToClash';
import { validateMihomoProxyList } from '../../lib/proxies/mihomoProxyValidator';
import { buildBase64Subscription, proxiesToShareUris } from '../../lib/proxies/clashToUri';

export interface Result {
  name: string;
  server: string;
  parse: string;
  validate: string;
  test: string;
  startup: string;
  connect: string;
  notes: string[];
  exportStatus?: string;
  roundTrip?: string;
  linkTest?: string;
  linkConnect?: string;
  realityTrue?: string;
  singClient?: string;
  xrayClient?: string;
  clientNotes?: string[];
}

export function fieldDiff(before: unknown, after: unknown, path = ''): string[] {
  if (Object.is(before, after)) return [];
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().flatMap((key) => {
      const field = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(b, key)) return [`lost ${field}`];
      if (!Object.hasOwn(a, key)) return [`added ${field}`];
      return fieldDiff(a[key], b[key], field);
    });
  }
  return [`changed ${path || '(root)'}`];
}

export function analyzeExport(proxies: Record<string, unknown>[]) {
  const share = proxiesToShareUris(proxies);
  const subscription = buildBase64Subscription(proxies);
  if (share.lines.length !== 1 || subscription.lineCount !== 1)
    return {
      status: 'SKIP',
      diff: 'N/A',
      content: '',
      lines: share.lines,
      notes: share.skipped.map((s) => s.reason),
    };
  const parsed = parseProxyUriList(share.lines[0]);
  if (parsed.errors.length || parsed.proxies.length !== 1)
    return {
      status: 'FAIL',
      diff: 're-parse failed',
      content: subscription.content,
      lines: share.lines,
      notes: parsed.errors.map((e) => e.error),
    };
  const differences = fieldDiff(proxies[0], parsed.proxies[0]);
  return {
    status: 'PASS',
    diff: differences.join('; ') || 'identical',
    content: subscription.content,
    lines: share.lines,
    notes: [] as string[],
  };
}

export function parseFixture(uri: string): Record<string, unknown>[] {
  const parsed = parseProxyUriList(uri);
  if (parsed.errors.length) throw new Error(parsed.errors.map((e) => e.error).join('; '));
  if (parsed.proxies.length !== 1)
    throw new Error(`expected one node, got ${parsed.proxies.length}`);
  return validateMihomoProxyList(parsed.proxies);
}

export function markdown(results: Result[]): string {
  const cell = (s: string) => s.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  return [
    '| case | server used | parse | mihomo -t | YAML connect (flag unset) | Reality flag true | export | round-trip diff | link import -t | link import connect | sing-box client | Xray client | per-core fields / gaps | notes |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${[
          r.name,
          r.server,
          `${r.parse} / validate ${r.validate}`,
          r.test,
          r.connect,
          r.realityTrue ?? 'N/A',
          r.exportStatus ?? 'SKIP',
          r.roundTrip ?? 'N/A',
          r.linkTest ?? 'SKIP',
          r.linkConnect ?? 'SKIP',
          r.singClient ?? 'SKIP',
          r.xrayClient ?? 'SKIP',
          (r.clientNotes ?? []).join('; '),
          [`server: ${r.startup}`, ...r.notes].join('; '),
        ]
          .map(cell)
          .join(' | ')} |`,
    ),
    '',
  ].join('\n');
}
