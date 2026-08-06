/**
 * AI-assisted naming analysis (rename-template configuration).
 *
 * Privacy contract (criterion 6):
 *   - The payload sent to the model is built HERE from bounded, redacted
 *     features — never raw node names, never full node objects, never
 *     subscription/proxy URLs, server/host/IP, ports, UUIDs, passwords,
 *     keys, SNI/headers, cookies or session data.
 *   - Every string field must pass `containsSensitivePattern` before it can
 *     leave (or come back): inputs are sanitized, outputs are re-checked.
 *   - Model output is validated against a strict schema and compiled into a
 *     rename-template suggestion. Any failure leaves the deterministic/manual
 *     workflow fully usable — this module only *suggests*.
 *   - Nothing here logs the original input or the AI payload.
 *
 * The model call is injectable (`chat`) so tests can exercise the full
 * pipeline without a network dependency.
 *
 * This one-shot analysis is a convenience surface; the composable naming
 * agent (namingActions) provides the full iterate→preview→apply loop.
 */

import type { AssistantMessage, DeepSeekCallConfig } from '@/lib/ai/deepseek';
import { deepseekChat } from '@/lib/ai/deepseek';
import { recognizeName } from '@/lib/proxies/naming';
import { containsSensitivePattern, redactSensitiveText } from '@/lib/proxies/namingSanitize';
import { buildSourceAliasScope, type TypedHandleScope } from '@/lib/proxies/handleScopes';
import { assertModelPayloadSafe, projectNodeSnapshot } from '@/lib/ai/namingContextProjection';
import { sourceOf, type SourceIdentity } from '@/lib/proxies/provenance';
// The ONE shared strict contract (schemas/namingAnalysis.ts): the opaque
// { ref } request, the exact scrubbed payload and the suggestion shape.
// Re-exported here so existing consumers keep one import surface.
import {
  NameFeatureSchema,
  NamingAnalysisRefSchema,
  NamingAnalysisResponseSchema,
  NamingSuggestionSchema,
  ScrubbedPayloadSchema,
  ScrubbedSourceSchema,
  type NameFeature,
  type NamingSuggestion,
  type ScrubbedPayload,
} from '@/schemas/namingAnalysis';

export {
  NameFeatureSchema,
  NamingAnalysisRefSchema,
  NamingAnalysisResponseSchema,
  NamingSuggestionSchema,
  ScrubbedPayloadSchema,
  ScrubbedSourceSchema,
};
export type {
  NameFeature,
  NamingAnalysisRef,
  NamingAnalysisResponse,
  NamingSuggestion,
  ScrubbedPayload,
  ScrubbedSource,
} from '@/schemas/namingAnalysis';

/** Deterministic sample size — the model gets a bounded view, not the world. */
export const ANALYSIS_NODE_CAP = 80;
/** Total payload size guard (bytes). */
export const ANALYSIS_PAYLOAD_BYTES_CAP = 64 * 1024;

export interface NamingAnalysisResult {
  suggestion: NamingSuggestion;
  /** The exact scrubbed payload that was sent — for the privacy disclosure. */
  payload: ScrubbedPayload;
}

/**
 * Cluster-driven STRATIFIED sampling keeps the view bounded, stable and
 * representative: nodes are grouped by their recognition signature (region /
 * route / vendor / rate / entry + first residual token), then one node is
 * taken per cluster in round-robin order until the cap. A rare name shape is
 * never drowned out by a dominant one, and the sample is deterministic.
 */
function sampleIndexes(proxies: Array<Record<string, unknown>>, cap: number): number[] {
  if (proxies.length <= cap) return Array.from({ length: proxies.length }, (_, i) => i);
  const clusters = new Map<string, number[]>();
  proxies.forEach((proxy, i) => {
    const name = typeof proxy.name === 'string' ? proxy.name : '';
    const r = recognizeName(name);
    const first = (r.base.trim().split(/\s+/)[0] ?? '').slice(0, 16);
    const key = [r.region, r.route, r.vendor, r.rate, r.entry, first].join('|');
    const list = clusters.get(key) ?? [];
    list.push(i);
    clusters.set(key, list);
  });
  // Largest clusters first; then round-robin one index per cluster.
  const ordered = [...clusters.values()].sort((a, b) => b.length - a.length);
  const out: number[] = [];
  let round = 0;
  while (out.length < cap && ordered.some((c) => c.length > round)) {
    for (const cluster of ordered) {
      if (out.length >= cap) break;
      if (cluster.length > round) out.push(cluster[round]);
    }
    round += 1;
  }
  return out.sort((a, b) => a - b);
}

/**
 * Opaque src-handle ⇄ stable source-key index (first-seen order). Only the
 * ids ever enter the model payload; the keys are translated back server-side
 * after strict validation.
 */
export interface OpaqueSourceIndex {
  idToKey: Map<string, string>;
  keyToId: Map<string, string>;
}

/** Shared index builder over an explicit key set (pass-5 blocker): keyed
 * src handles with an in-memory exact reverse map; a MAC collision REJECTS
 * (ambiguous handles fail closed) — never a silent last-write-wins overwrite.
 * Maps stay local to the call; raw keys/slugs never serialize. Round-1:
 * implemented over the typed source-alias HandleScope, which builds ONE
 * collision-checked index over the COMPLETE key set before any lookup. */
export function buildOpaqueSourceIndexFromKeys(keys: Iterable<string>): OpaqueSourceIndex {
  let scope: TypedHandleScope<string>;
  try {
    scope = buildSourceAliasScope(keys);
  } catch {
    // a source-MAC collision is ambiguous — fail closed (legacy message kept
    // for the resolver's bounded ALIAS_ERROR translation)
    throw new Error('Source handle collision: ambiguous opaque source id.');
  }
  const idToKey = new Map<string, string>();
  const keyToId = new Map<string, string>();
  for (const key of keys) {
    if (key === '' || keyToId.has(key)) continue;
    // every forward operation goes through the prebuilt index
    const id = scope.project(key);
    keyToId.set(key, id);
    idToKey.set(id, key);
  }
  return { idToKey, keyToId };
}

export function buildOpaqueSourceIndex(
  proxies: Array<Record<string, unknown>>,
  sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
): OpaqueSourceIndex {
  return buildOpaqueSourceIndexFromKeys(
    proxies
      .map((proxy) => sourceOfProxy(proxy))
      .filter((identity): identity is SourceIdentity => identity !== undefined)
      .map((identity) => identity.key),
  );
}

/**
 * Build the scrubbed, credential-free payload from raw (pre-operator) proxy
 * objects. Round-1: the shared AiSafeNamingContext projector owns the
 * complete-domain node/source indexes and every display-text projection —
 * sampled ORIGINAL display names and source labels survive redaction while
 * credentials never cross; source references stay opaque src- handles.
 */
export function buildScrubbedPayload(
  proxies: Array<Record<string, unknown>>,
  sourceOfProxy: (proxy: unknown) => SourceIdentity | undefined = sourceOf,
): ScrubbedPayload {
  // ONE collision-checked index over the COMPLETE snapshot + complete
  // source-key set BEFORE any cap/slice (round-1 typed HandleScopes): a
  // node/source MAC collision anywhere fails the payload closed, never a
  // capped subset as the collision domain.
  const projection = projectNodeSnapshot(proxies, { sourceOfProxy });
  // Direct key → src-handle map over the COMPLETE source-key set (one pass;
  // never a per-proxy scan — 50000 distinct sources must stay linear).
  const srcIdByKey = new Map<string, string>();
  {
    const allKeys = new Set<string>();
    for (const proxy of proxies) {
      const identity = sourceOfProxy(proxy);
      if (identity && identity.key !== '') allKeys.add(identity.key);
    }
    const sourceScope = buildSourceAliasScope(allKeys);
    for (const key of allKeys) srcIdByKey.set(key, sourceScope.project(key));
  }
  // SEMANTIC TOTALS ARE COMPUTED OVER THE FULL INPUT BEFORE SAMPLING
  // (pass-2 finding): a 50000-node source must report sourcesTotal 50000
  // even though only bounded entries are retained — the sample cap is never
  // the true total. One full pass over every proxy, then the bounded sample.
  const allSources = new Set(projection.sources.map((s) => s.id));
  const allRegionCounts = new Map<string, number>();
  const allRates = new Set<number>();
  for (const proxy of proxies) {
    const name = typeof proxy.name === 'string' ? proxy.name : '';
    if (name === '') continue;
    const redactedName = redactSensitiveText(name);
    const recognized = recognizeName(redactedName);
    if (recognized.region) {
      allRegionCounts.set(recognized.region, (allRegionCounts.get(recognized.region) ?? 0) + 1);
    }
    if (recognized.rate !== null) allRates.add(recognized.rate);
  }

  const indexes = sampleIndexes(proxies, ANALYSIS_NODE_CAP);
  const nodes: NameFeature[] = [];
  const sources = new Set<string>();
  const regionCounts = new Map<string, number>();
  const rates = new Set<number>();

  for (const i of indexes) {
    const proxy = proxies[i];
    const name = typeof proxy.name === 'string' ? proxy.name : '';
    const projected = projection.nodes[i];
    // Canonical protocol allowlist ONLY (pass-4 finding): a raw proxy.type
    // never crosses the boundary — unknown types are rejected (null).
    const type = projected.protocol;
    const source = sourceOfProxy(proxy);
    const src =
      source === undefined || source.key === '' ? null : (srcIdByKey.get(source.key) ?? null);

    let region: string | null = null;
    let rate: number | null = null;
    let route: string | null = null;
    let entry: string | null = null;
    let vendor: string | null = null;
    let hasResidual = false;
    if (name !== '') {
      // REDACT THE FULL RAW NAME FIRST: recognition must never run on raw
      // text — it can split a credential (例子.中国 → region CN + leaked
      // 例子.) and make the residue unrecognizable to the sanitizer.
      const redactedName = redactSensitiveText(name);
      const recognized = recognizeName(redactedName);
      region = recognized.region;
      rate = recognized.rate;
      route = recognized.route;
      entry = recognized.entry;
      vendor = recognized.vendor;
      // pass-3 finding: the residual fragment itself NEVER crosses the
      // model boundary — only the boolean fact that one survived.
      hasResidual = recognized.base.trim() !== '';
    }

    if (src) sources.add(src);
    if (region) regionCounts.set(region, (regionCounts.get(region) ?? 0) + 1);
    if (rate !== null) rates.add(rate);

    nodes.push({
      i,
      name: projected.name,
      src,
      region,
      rate,
      route,
      entry,
      vendor,
      type,
      hasResidual,
    });
  }

  const regionsAll = [...allRegionCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => ({ code, count }));
  const ratesAll = [...allRates].sort((a, b) => a - b);
  return {
    nodeCount: proxies.length,
    sampled: nodes.length,
    nodes,
    sources: projection.sources.slice(0, 32),
    sourcesTotal: allSources.size,
    sourcesTruncated: projection.sources.length > 32,
    regions: regionsAll.slice(0, 8),
    regionsTotal: regionsAll.length,
    regionsTruncated: regionsAll.length > 8,
    rates: ratesAll.slice(0, 16),
    ratesTotal: ratesAll.length,
    ratesTruncated: ratesAll.length > 16,
  };
}

/** Byte budget guard — a future caller that grows the feature set can't blow past it silently. */
export function assertPayloadWithinBudget(payload: ScrubbedPayload): void {
  if (JSON.stringify(payload).length > ANALYSIS_PAYLOAD_BYTES_CAP) {
    throw new Error('Naming analysis payload exceeds its size budget.');
  }
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('No JSON object in model output.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Reject any suggestion whose string fields still carry credential-shaped
 * text — a model echo must never travel back into the app (or a later log).
 */
const EMITTED_HANDLE_RE = /^(?:src|nd|ref|v|r)-[0-9a-f]{16}$/;
function assertSuggestionClean(suggestion: NamingSuggestion): void {
  for (const [key, value] of Object.entries(suggestion.sourceAliases)) {
    // Server-minted opaque handle keys (MAC tokens the payload emitted) are
    // exempt — they are tokens, never credentials; values stay fully checked.
    if (!EMITTED_HANDLE_RE.test(key) && containsSensitivePattern(key)) {
      throw new Error('Model output contains a sensitive pattern.');
    }
    if (containsSensitivePattern(value)) {
      throw new Error('Model output contains a sensitive pattern.');
    }
  }
  for (const rule of suggestion.recognitionRules) {
    if (containsSensitivePattern(rule.pattern) || containsSensitivePattern(rule.value)) {
      throw new Error('Model output contains a sensitive pattern.');
    }
  }
  if (containsSensitivePattern(suggestion.template)) {
    throw new Error('Model output contains a sensitive pattern.');
  }
  if (containsSensitivePattern(suggestion.reason)) {
    throw new Error('Model output contains a sensitive pattern.');
  }
}

const SYSTEM_PROMPT = `你是代理节点命名的分析助手。你会收到一批「已脱敏」的节点样本（原始显示名已做结构化脱敏——URL/服务器/IP/端口/UUID/令牌/密钥等凭据形状的内容已被删除，普通名字如 HK-01、IPLC、Nexitally、2x、家宽 会原样保留；不要假设其中存在任何凭据，也不要编造特征），每条还带来源别名标签、地区、倍率、路由/入口/服务商提示、协议类型、残片布尔。
任务：为「名称统一（模板命名）」算子给出一个模板建议 —— 输出一个 JSON 对象，严格匹配给定 schema，不得包含 schema 之外的键。规则：
- 模板占位符白名单：emoji（国旗）、region（地区中文名）、region_code（地区代码）、entry（入口）、route（路由）、vendor（服务商）、source（来源别名）、protocol（协议）、rate（倍率，默认省略 1x；\${rate:include1x} 显示 1x）、index（来源稳定序号，可用 \${index:03} 设宽度）、note（残余名称片段）。
- 可选片段 \${?字段: 文字与占位符}：字段缺失时整段消失；分隔符写在可选片段内部（如 \${?route: · \${route}}）避免悬空分隔符。\$\$ 是字面 \$ 的转义。
- 国旗与地区是一个视觉块：默认模板形如 \${emoji} \${region}\${?route: · \${route}}\${?source: · \${source}}\${?index: · \${index}}\${?rate: · \${rate}}。
- 只依据收到的特征做判断；不确定的成分就不放进模板（或放进可选片段），绝不臆造地区/服务商/倍率。
- 每个节点带有 hasResidual 布尔值：true 表示该节点名字在识别后仍有残余片段（机场名/线路名等）。若绝大多数节点 hasResidual=false 说明识别已足够；若 hasResidual=true 的节点很多，说明残片普遍有意义的文字，可考虑 \${?note: · \${note}}。
- 识别规则（recognitionRules）只用于修正明显的识别错误（如把某线路关键词识别为地区），pattern 用有界正则、value 是替换的事实标签（≤24 字符），规则数 ≤ 32；不确定就不要给。
- 来源别名（sourceAliases）只用于修正明显不友好的来源标签，别名 ≤ 40 字符；键必须是收到的 sources 列表里出现的 src- 不透明句柄（示例：src-ec328627ed98fa07），不得自造键，也不得使用任何其他形式的来源标识。
- reason 用一句话中文说明建议理由，≤ 200 字符。`;

export interface RunNamingAnalysisOptions {
  proxies: Array<Record<string, unknown>>;
  sourceOfProxy?: (proxy: unknown) => SourceIdentity | undefined;
  /**
   * Injectable model call — tests substitute a fake. Production callers pass
   * the stored assistant config instead (see `config`).
   */
  chat?: typeof deepseekChat;
  /**
   * The user's stored assistant configuration (AI 配置页). When provided the
   * model call uses ITS base URL / model / key — the request never depends on
   * DEEPSEEK_API_KEY in the server env.
   */
  config?: DeepSeekCallConfig;
}

/**
 * One-shot analysis: scrub → (model call) → strict validation → suggestion.
 * Throws plain Errors with safe, credential-free messages; the route maps
 * them to problem responses. Never logs input or payload.
 */
export async function runNamingAnalysis(
  options: RunNamingAnalysisOptions,
): Promise<NamingAnalysisResult> {
  const payload = buildScrubbedPayload(options.proxies, options.sourceOfProxy);
  assertPayloadWithinBudget(payload);
  // round-1: recursive credential-free assertion over the EXACT payload that
  // leaves for the model — no credential-shaped string can cross even if a
  // future caller forgets to sanitize.
  assertModelPayloadSafe(payload);
  const chat =
    options.chat ??
    ((messages, tools, signal) => deepseekChat(messages, tools, signal, options.config));

  const userMessage =
    `以下是某订阅源的节点特征样本（已脱敏，共 ${payload.sampled}/${payload.nodeCount} 个）：\n` +
    JSON.stringify(payload) +
    `\n\n请输出一个 JSON 对象：{"template":"占位符模板字符串","tw2cn":boolean,"sourceAliases":{...},"recognitionRules":[{pattern,field,value}],"reason":"一句话"}`;

  let message: AssistantMessage;
  try {
    message = await chat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
      [],
    );
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === 'Server misconfigured: missing DEEPSEEK_API_KEY.'
        ? 'AI 助手未配置 API Key。'
        : 'AI 分析暂时不可用，请稍后重试或手动配置。',
    );
  }

  if (!message.content) {
    throw new Error('AI 分析没有返回内容，请重试或手动配置。');
  }
  let parsedJson: unknown;
  try {
    parsedJson = extractJsonObject(message.content);
  } catch {
    // Model output is arbitrary text — never echo it into the error.
    throw new Error('AI 分析返回的结果无法识别，请重试或手动配置。');
  }
  const parsed = NamingSuggestionSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error('AI 分析返回的结果无法识别，请重试或手动配置。');
  }
  assertSuggestionClean(parsed.data);
  // pass-5 blocker: sourceAliases stay src-handle-keyed; translation to
  // rename-template executor keys on; an invented/unknown id is rejected —
  // a suggestion that cannot be applied must not silently drop aliases.
  // pass-5 blocker: the suggestion KEEPS the opaque src handles on every
  // external surface. Only a trusted internal service immediately before
  // authorized preview/apply translates an accepted unambiguous handle to a
  // stable source key (sourceAliasResolver). Invented or ambiguous handles
  // are rejected HERE: every alias key must be an emitted src handle.
  const index = buildOpaqueSourceIndex(options.proxies, options.sourceOfProxy);
  for (const [opaqueId] of Object.entries(parsed.data.sourceAliases)) {
    if (!index.idToKey.has(opaqueId)) {
      throw new Error('AI 分析返回的结果无法识别，请重试或手动配置。');
    }
  }
  return {
    // the suggestion KEEPS the opaque src-handle alias keys externally
    suggestion: { ...parsed.data, sourceAliases: parsed.data.sourceAliases },
    payload,
  };
}
