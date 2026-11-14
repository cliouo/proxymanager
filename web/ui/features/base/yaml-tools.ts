import { isMap, parseDocument } from 'yaml';

/**
 * Text-level helpers for the base skeleton and the rendered config: marker
 * scanning (mirrors lib/engine/parser's per-line patterns), top-level section
 * outline, client-side YAML syntax check with positions, and edit planners that
 * never split an existing block.
 */

/* ─── markers ────────────────────────────────────────────────────────── */

const MARKER_LINE = /^[ \t]*#\s*===\s*(?:ANCHOR:\s*([\w-]+)|(RULE-PROVIDERS)|(PROXY-GROUPS))\s*===[ \t]*$/;

export type MarkerKind = 'anchor' | 'rule-providers' | 'proxy-groups';

export interface Marker {
  kind: MarkerKind;
  /** Anchor name, or the marker keyword. */
  name: string;
  /** 1-based line number. */
  line: number;
}

export const isMarkerLine = (text: string) => MARKER_LINE.test(text);

export function scanMarkers(content: string): Marker[] {
  const out: Marker[] = [];
  content.split('\n').forEach((raw, index) => {
    const match = MARKER_LINE.exec(raw.replace(/\r$/, ''));
    if (!match) return;
    if (match[1]) out.push({ kind: 'anchor', name: match[1], line: index + 1 });
    else if (match[2]) out.push({ kind: 'rule-providers', name: 'RULE-PROVIDERS', line: index + 1 });
    else out.push({ kind: 'proxy-groups', name: 'PROXY-GROUPS', line: index + 1 });
  });
  return out;
}

export const MARKER_TEXT = {
  anchor: (name: string) => `# === ANCHOR: ${name} ===`,
  'rule-providers': '# === RULE-PROVIDERS ===',
  'proxy-groups': '# === PROXY-GROUPS ===',
} as const;

/* ─── top-level outline ──────────────────────────────────────────────── */

const TOP_KEY = /^([A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):(?=\s|$)(.*)$/;

export interface TopSection {
  key: string;
  line: number;
  /** `key:` followed by a nested block (vs. an inline scalar value). */
  block: boolean;
  /** Direct children of a block (list items / mapping keys). */
  count: number | null;
}

function countChildren(lines: string[], start: number): number {
  let indent: number | null = null;
  let count = 0;
  for (let j = start + 1; j < lines.length; j++) {
    const text = lines[j];
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const lead = text.length - text.trimStart().length;
    if (lead === 0) {
      // A block sequence may sit at column 0 under its key (`rules:\n- …`).
      if (/^-(\s|$)/.test(text) && (indent === null || indent === 0)) {
        indent = 0;
        count++;
        continue;
      }
      break;
    }
    if (indent === null) indent = lead;
    if (lead === indent) count++;
  }
  return count;
}

export function topLevelSections(content: string): TopSection[] {
  const lines = content.split('\n');
  const out: TopSection[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = TOP_KEY.exec(lines[i].replace(/\r$/, ''));
    if (!match) continue;
    const key = match[1].replace(/^["']|["']$/g, '');
    const rest = match[2].trim();
    const block = rest === '' || rest.startsWith('#');
    out.push({ key, line: i + 1, block, count: block ? countChildren(lines, i) : null });
  }
  return out;
}

export function hasTopKey(content: string, key: string): number | null {
  const hit = topLevelSections(content).find((s) => s.key === key);
  return hit ? hit.line : null;
}

/** Friendly names for well-known Mihomo top-level keys. */
export const SECTION_LABEL: Record<string, string> = {
  proxies: '节点',
  'proxy-groups': '策略组',
  rules: '规则',
  'rule-providers': '规则集',
  'proxy-providers': '节点集',
  'sub-rules': '子规则',
  dns: 'DNS',
  tun: 'TUN',
  sniffer: '嗅探',
  hosts: 'Hosts',
  profile: '存档',
  experimental: '实验特性',
  'geox-url': 'GeoData',
  ntp: 'NTP',
  tls: 'TLS',
  listeners: '入站',
  tunnels: '隧道',
};

/* ─── YAML syntax (client-side, with positions) ──────────────────────── */

export interface SyntaxIssue {
  line: number;
  col: number;
  message: string;
  /** Original parser message (English) for the curious. */
  detail?: string;
}

const YAML_ERROR_COPY: Record<string, string> = {
  DUPLICATE_KEY: '同一层里有重复的键',
  TAB_AS_INDENT: '不能用 Tab 缩进，请改用空格',
  BAD_INDENT: '缩进没有对齐',
  MISSING_CHAR: '缺少配对的符号（引号、括号或冒号）',
  MULTIPLE_DOCS: '只能有一份 YAML 文档，不要用 --- 分隔',
  BAD_DQ_ESCAPE: '双引号里有无效的转义字符',
  BLOCK_AS_IMPLICIT_KEY: '这一行的写法无法解析',
  MULTILINE_IMPLICIT_KEY: '键不能跨行，可能缺了冒号或缩进不对',
  UNEXPECTED_TOKEN: '这里出现了意外的字符',
  BAD_SCALAR_START: '值不能以这个字符开头，试试加引号',
  BAD_ALIAS: 'YAML 别名（*name）用法有误',
  MULTIPLE_ANCHORS: 'YAML 锚点（&name）用法有误',
  KEY_OVER_1024_CHARS: '键太长了',
};

export function checkYamlSyntax(content: string): SyntaxIssue | null {
  if (!content.trim()) return { line: 1, col: 1, message: '内容为空' };
  let doc;
  try {
    doc = parseDocument(content);
  } catch (error) {
    return { line: 1, col: 1, message: 'YAML 无法解析', detail: (error as Error).message };
  }
  const error = doc.errors[0];
  if (error) {
    const pos = error.linePos?.[0];
    return {
      line: pos?.line ?? 1,
      col: pos?.col ?? 1,
      message: YAML_ERROR_COPY[error.code] ?? 'YAML 语法错误',
      detail: error.message.split('\n')[0],
    };
  }
  if (!isMap(doc.contents)) {
    return { line: 1, col: 1, message: '顶层必须是「键: 值」形式的映射' };
  }
  return null;
}

/** Turn the server's (deliberately terse, English) base parse issues into copy. */
export function describeServerParseIssue(message: string): string {
  if (/merge keys/i.test(message)) return '不支持 YAML 合并键（<<）';
  const seq = /"([^"]+)" must be a sequence/.exec(message);
  if (seq) return `「${seq[1]}」必须是列表`;
  const map = /"([^"]+)" must be a mapping/.exec(message);
  if (map) return `「${map[1]}」必须是映射`;
  if (/root must be a mapping/i.test(message)) return '顶层必须是「键: 值」形式的映射';
  if (/^Invalid base YAML: /.test(message)) return `节点定义有误：${message.replace(/^Invalid base YAML: /, '')}`;
  if (/^Invalid base YAML$/.test(message)) return 'YAML 无法解析';
  return message;
}

/* ─── edit planners ──────────────────────────────────────────────────── */

export interface TextEdit {
  /** Character offset to insert at. */
  from: number;
  insert: string;
  /** 1-based lines to select after the edit. */
  selectFrom: number;
  selectTo: number;
}

function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

/** Insert whole lines before line index `at` (0-based; may equal lines.length to append). */
function insertLinesAt(content: string, at: number, block: string[]): TextEdit {
  const lines = content.split('\n');
  const starts = lineStarts(lines);
  if (at >= lines.length) {
    const needsBreak = content.length > 0 && !content.endsWith('\n');
    const insert = `${needsBreak ? '\n' : ''}${block.join('\n')}\n`;
    const firstLine = lines.length + (needsBreak ? 1 : 0);
    return { from: content.length, insert, selectFrom: firstLine, selectTo: firstLine + block.length - 1 };
  }
  return {
    from: starts[at],
    insert: `${block.join('\n')}\n`,
    selectFrom: at + 1,
    selectTo: at + block.length,
  };
}

const RULES_KEY = /^rules:\s*(#.*)?$/;
const TOP_LINE = /^[A-Za-z0-9_"'#]/;

/** Index of the last line that belongs to the `rules:` block (or -1 when absent). */
function rulesBlockEnd(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => RULES_KEY.test(l));
  if (start === -1) return null;
  let end = start;
  for (let j = start + 1; j < lines.length; j++) {
    const text = lines[j];
    if (!text.trim()) continue;
    if (/^\s/.test(text) || /^-(\s|$)/.test(text)) {
      end = j;
      continue;
    }
    break;
  }
  return { start, end };
}

/**
 * Put an anchor marker back where it used to be: after the anchor that preceded
 * it in the saved version (if that one still exists), else before the one that
 * followed it, else at the end of the `rules:` block (creating it if needed).
 */
export function restoreAnchorEdit(content: string, saved: string, name: string): TextEdit {
  const lines = content.split('\n');
  const marker = `  ${MARKER_TEXT.anchor(name)}`;
  const current = scanMarkers(content).filter((m) => m.kind === 'anchor');
  const previous = scanMarkers(saved)
    .filter((m) => m.kind === 'anchor')
    .map((m) => m.name);
  const at = previous.indexOf(name);
  if (at !== -1) {
    for (let i = at - 1; i >= 0; i--) {
      const hit = current.find((m) => m.name === previous[i]);
      if (hit) {
        const indent = /^[ \t]*/.exec(lines[hit.line - 1])?.[0] ?? '  ';
        return insertLinesAt(content, hit.line, [`${indent}${MARKER_TEXT.anchor(name)}`]);
      }
    }
    for (let i = at + 1; i < previous.length; i++) {
      const hit = current.find((m) => m.name === previous[i]);
      if (hit) {
        const indent = /^[ \t]*/.exec(lines[hit.line - 1])?.[0] ?? '  ';
        return insertLinesAt(content, hit.line - 1, [`${indent}${MARKER_TEXT.anchor(name)}`]);
      }
    }
  }
  const block = rulesBlockEnd(lines);
  if (!block) {
    const pad = content.trim() && !/\n[ \t]*\n[ \t]*$/.test(content) ? [''] : [];
    return insertLinesAt(content, documentEnd(content), [...pad, 'rules:', marker]);
  }
  return insertLinesAt(content, block.end + 1, [marker]);
}

/** Line index where appended text should start (the phantom line after a trailing newline). */
function documentEnd(content: string): number {
  const lines = content.split('\n');
  return content.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Top-level injection markers go before `rules:` (providers ahead of groups). */
export function injectionMarkerEdit(content: string, kind: 'rule-providers' | 'proxy-groups'): TextEdit {
  const lines = content.split('\n');
  const markers = scanMarkers(content);
  if (kind === 'rule-providers') {
    const groups = markers.find((m) => m.kind === 'proxy-groups');
    if (groups) return insertLinesAt(content, groups.line - 1, [MARKER_TEXT['rule-providers'], '']);
  } else {
    const providers = markers.find((m) => m.kind === 'rule-providers');
    if (providers) return insertLinesAt(content, providers.line, ['', MARKER_TEXT['proxy-groups']]);
  }
  const rules = lines.findIndex((l) => RULES_KEY.test(l));
  if (rules !== -1) return insertLinesAt(content, rules, [MARKER_TEXT[kind], '']);
  return insertLinesAt(content, documentEnd(content), ['', MARKER_TEXT[kind]]);
}

/** Where settings snippets go when the cursor hasn't been placed: ahead of the managed sections. */
function defaultSnippetLine(content: string): number {
  const lines = content.split('\n');
  const managed = lines.findIndex(
    (l) => isMarkerLine(l) || /^(rules|proxies|proxy-groups|rule-providers|proxy-providers):/.test(l),
  );
  return managed === -1 ? documentEnd(content) + 1 : managed + 1;
}

/**
 * Insert a top-level snippet at the cursor without splitting a block: on a
 * blank line that is followed by top-level content we insert right there,
 * otherwise before the next top-level line (or at the end). Without a cursor
 * the snippet lands ahead of the managed sections.
 */
export function snippetEdit(content: string, cursorLine: number | null, body: string): TextEdit {
  const lines = content.split('\n');
  const count = documentEnd(content);
  const snippet = body.replace(/\n+$/, '').split('\n');
  const isTop = (text: string) => TOP_LINE.test(text);
  let at = Math.max(0, Math.min((cursorLine ?? defaultSnippetLine(content)) - 1, count));
  if (cursorLine !== null) {
    let next = at;
    while (next < count && !lines[next].trim()) next++;
    const safeHere = at < count && !lines[at].trim() && (next >= count || isTop(lines[next]));
    if (!safeHere) {
      let j = at + 1;
      while (j < count && !isTop(lines[j])) j++;
      at = Math.min(j, count);
    }
  }
  const before = at > 0 && lines[at - 1].trim() ? [''] : [];
  const after = at < count && lines[at].trim() ? [''] : [];
  const edit = insertLinesAt(content, at, [...before, ...snippet, ...after]);
  return {
    ...edit,
    selectFrom: edit.selectFrom + before.length,
    selectTo: edit.selectFrom + before.length + snippet.length - 1,
  };
}

/* ─── starter skeleton & snippets ────────────────────────────────────── */

export const STARTER_BASE = `allow-lan: false
mode: rule
log-level: info

# === RULE-PROVIDERS ===

# === PROXY-GROUPS ===

rules:
  # === ANCHOR: prelude ===
  # === ANCHOR: manual ===
  # === ANCHOR: late ===
`;

export interface Snippet {
  id: string;
  label: string;
  description: string;
  /** Top-level keys it introduces (used to detect "already there"). */
  keys: string[];
  body: string;
}

export const SNIPPETS: Snippet[] = [
  {
    id: 'dns',
    label: 'DNS · fake-ip',
    description: '加密 DNS，fake-ip 模式，局域网域名不走假 IP',
    keys: ['dns'],
    body: `dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '*.lan'
    - '+.local'
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query`,
  },
  {
    id: 'tun',
    label: 'TUN',
    description: '接管整机流量，自动设置路由并劫持 DNS',
    keys: ['tun'],
    body: `tun:
  enable: true
  stack: mixed
  auto-route: true
  auto-detect-interface: true
  dns-hijack:
    - any:53`,
  },
  {
    id: 'sniffer',
    label: '域名嗅探',
    description: '从 HTTP / TLS / QUIC 握手里还原域名，让域名规则对 IP 连接也生效',
    keys: ['sniffer'],
    body: `sniffer:
  enable: true
  parse-pure-ip: true
  sniff:
    HTTP:
      ports: [80, 8080-8880]
      override-destination: true
    TLS:
      ports: [443, 8443]
    QUIC:
      ports: [443, 8443]`,
  },
  {
    id: 'ports',
    label: '端口与面板',
    description: '混合代理端口 7890，本机 9090 控制面板',
    keys: ['mixed-port', 'external-controller'],
    body: `mixed-port: 7890
external-controller: 127.0.0.1:9090`,
  },
];
