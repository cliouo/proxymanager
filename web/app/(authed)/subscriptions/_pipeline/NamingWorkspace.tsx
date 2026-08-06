'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageTopbar } from '@/components/PageChrome';
import { ApiError, api } from '@/lib/client/api';
import { NAMING_FIELDS, validateTemplate, type NamingField } from '@/lib/proxies/naming';
import {
  namingAnalysisRequest,
  type NamingSuggestion,
  type ScrubbedPayload,
} from '@/schemas/namingAnalysis';
import styles from './naming.module.css';

/** Field help shown in the chips legend (mirrors naming.ts docs). */
const FIELD_HELP: Record<NamingField, string> = {
  emoji: '国旗（按识别地区）',
  region: '地区中文名（香港）',
  region_code: '地区代码（HK）',
  entry: '入口提示（仅命中「入口」时）',
  route: '路由（中转 / 直连 / 落地 / 入口）',
  vendor: '服务商（保守词表）',
  source: '来源订阅别名',
  protocol: '协议类型（vless…）',
  rate: '倍率（默认省略 1x）',
  index: '按来源稳定序号',
  note: '识别后的残余名称片段',
};

const KIND_LABELS: Record<string, string> = {
  intrinsic: '结构化',
  derived: '识别',
  'ai-rule': '规则',
  assigned: '指派',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** Authoritative activation state: absent | disabled | enabled. */
type Activation = 'absent' | 'disabled' | 'enabled';

interface NamingPolicyFields {
  template: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: Array<{ pattern: string; field: string; value: string }>;
}

interface WorkspaceData {
  entity: { type: 'subscription' | 'collection'; ref: string; label: string };
  aggregate: boolean;
  managed: { present: boolean; disabled?: boolean } & Partial<NamingPolicyFields>;
  recommended: string;
  /**
   * Persisted prior state — rollback target (real rollback, not draft reset).
   * hadManaged:false means "no managed naming existed before the latest
   * apply"; rollback then REMOVES the operator again.
   */
  priorPlan: { present: boolean; hadManaged?: boolean } & Partial<NamingPolicyFields>;
  health: Array<{
    sourceKey: string;
    sourceLabel: string;
    nodeCount: number;
    fields: Array<{
      field: string;
      label: string;
      present: number;
      total: number;
      percent: number;
      confidence: { high: number; medium: number; low: number };
      samples: Array<{ value: string; count: number; kind: string; confidence: string }>;
    }>;
    nodeFacts: Array<{
      node: string;
      field: string;
      value: string | null;
      confidence: string | null;
      kind: string | null;
      ambiguous: boolean;
    }>;
    unavailable: string[];
    partial: string[];
    ambiguousCount: number;
    drift: Array<{ field: string; count: number; samples: string[] }>;
  }>;
  diagnostics: {
    nodeCount: number;
    changed: number;
    collisions: string[];
    deduped: Array<{ kept: string; dropped: string; sourceKey?: string }>;
    beforeNames: string[];
    afterNames: string[];
    truncated: boolean;
  };
  references: {
    consumingProfiles: Array<{ id: string; name: string }>;
    orphaned: Array<{ node: string; kind: string; via: string }>;
  };
}

interface PreviewResult {
  after: { count: number; names: string[]; truncated: boolean };
  issues: Array<{
    code: string;
    name?: string;
    count?: number;
    kept?: string;
    dropped?: string;
    node?: string;
    via?: string;
  }>;
}

interface AiState {
  running: boolean;
  error: string | null;
  suggestion: NamingSuggestion | null;
  payload: ScrubbedPayload | null;
}

/**
 * The workspace's ACTUAL AI request path (the button handler calls this):
 * one strict `{ ref }` body through the injected api implementation — raw
 * type/id never leaves the workspace. Exported so the UI acceptance tests
 * drive the real request with a capturing api for both entity kinds.
 */
export async function runNamingAnalysisRequest(
  apiImpl: <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>,
  entityRef: string,
): Promise<{ suggestion: NamingSuggestion; payload: ScrubbedPayload }> {
  return apiImpl<{ data: { suggestion: NamingSuggestion; payload: ScrubbedPayload } }>(
    '/api/v1/assistant/naming-analysis',
    { method: 'POST', body: namingAnalysisRequest(entityRef) },
  ).then((res) => res.data);
}

/** The current managed policy (tw2cn/aliases/rules) — template edits keep it. */
function policyOf(data: WorkspaceData): {
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules: Array<{ pattern: string; field: string; value: string }>;
} {
  return {
    tw2cn: data.managed.tw2cn,
    sourceAliases: data.managed.sourceAliases,
    recognitionRules: data.managed.recognitionRules ?? [],
  };
}

/** The COMPLETE naming plan: template plus every non-template policy field.
 * Non-template fields are optional because the equality normalization treats
 * unset values as their defaults (tw2cn false, aliases {}, rules []). */
export interface CompleteNamingPlan {
  template: string;
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules?: Array<{ pattern: string; field: string; value: string }>;
}

/**
 * Normalized complete-plan equality — the ONE comparison behind Apply
 * dirty/applyability (round-7 HIGH-1): applying an AI suggestion replaces
 * the FULL plan (template + tw2cn + sourceAliases + recognitionRules), so an
 * enabled stored plan whose suggestion keeps the template but changes any
 * other policy partition is a real, applyable change. Normalization of
 * defaults: tw2cn unset ≡ false (both mean keep the TW flag), an
 * empty/absent sourceAliases map is the same as undefined, and rules
 * compare in stored order (recognition rules are ordered).
 */
/** The COMPLETE policy draft an AI suggestion produces (round-7 HIGH-A):
 * every non-template partition explicit — missing tw2cn at the
 * model-output boundary normalizes to explicit false (a suggestion is a
 * COMPLETE plan, same default as empty aliases/rules), and the empty alias
 * map stays {} so Apply always sends the full plan. applyAi stores this
 * exact object; nothing here can be undefined, so the preview/apply body
 * always serializes an own `tw2cn` key. */
export function completeDraftFromSuggestion(suggestion: {
  template: string;
  /** May be absent at the model-output boundary; normalized to explicit false. */
  tw2cn?: boolean;
  sourceAliases: Record<string, string>;
  recognitionRules: Array<{ pattern: string; field: string; value: string }>;
}): {
  tw2cn: boolean;
  sourceAliases: Record<string, string>;
  recognitionRules: Array<{ pattern: string; field: string; value: string }>;
} {
  return {
    tw2cn: suggestion.tw2cn ?? false,
    sourceAliases: suggestion.sourceAliases,
    recognitionRules: suggestion.recognitionRules,
  };
}

/** The policy partition of the preview/apply body — the ONE builder both
 * runPreview and applyDraft use, so the sent plan is always exactly the
 * current complete draft. An explicit false tw2cn serializes as its own
 * JSON key; undefined (manual template-only edits, non-AI callers) stays
 * absent so the server's absent-field patch semantics are preserved. */
export function policyBody(policy: {
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules: Array<{ pattern: string; field: string; value: string }>;
}): {
  tw2cn?: boolean;
  sourceAliases?: Record<string, string>;
  recognitionRules: Array<{ pattern: string; field: string; value: string }>;
} {
  return {
    tw2cn: policy.tw2cn,
    sourceAliases: policy.sourceAliases,
    recognitionRules: policy.recognitionRules,
  };
}

export function namingPlanEquals(a: CompleteNamingPlan, b: CompleteNamingPlan): boolean {
  if (a.template !== b.template) return false;
  if ((a.tw2cn ?? false) !== (b.tw2cn ?? false)) return false;
  const aliasesA = Object.entries(a.sourceAliases ?? {}).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  const aliasesB = Object.entries(b.sourceAliases ?? {}).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  if (aliasesA.length !== aliasesB.length) return false;
  for (let i = 0; i < aliasesA.length; i += 1) {
    if (aliasesA[i][0] !== aliasesB[i][0] || aliasesA[i][1] !== aliasesB[i][1]) return false;
  }
  const rulesA = a.recognitionRules ?? [];
  const rulesB = b.recognitionRules ?? [];
  if (rulesA.length !== rulesB.length) return false;
  for (let i = 0; i < rulesA.length; i += 1) {
    const ra = rulesA[i];
    const rb = rulesB[i];
    if (ra.pattern !== rb.pattern || ra.field !== rb.field || ra.value !== rb.value) return false;
  }
  return true;
}

export function NamingWorkspace({
  workspacePath,
  backHref,
  crumbPrefix,
  initialData,
}: {
  /** Dedicated workspace contract: GET state + POST preview/apply/rollback. */
  workspacePath: string;
  backHref: string;
  crumbPrefix: string;
  /** Test seam: render from a fixed payload without the fetch (static markup). */
  initialData?: WorkspaceData;
}) {
  const [data, setData] = useState<WorkspaceData | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>(() =>
    initialData
      ? initialData.managed.present && initialData.managed.template
        ? initialData.managed.template
        : initialData.recommended
      : '',
  );
  // Full-plan draft: the template plus the complete policy (tw2cn / source
  // aliases / recognition rules). Template edits keep the current policy;
  // an AI suggestion replaces ALL of it (AI only replaces the full draft).
  const [policyDraft, setPolicyDraft] = useState<{
    tw2cn?: boolean;
    sourceAliases?: Record<string, string>;
    recognitionRules: Array<{ pattern: string; field: string; value: string }>;
  }>(() => (initialData ? policyOf(initialData) : { recognitionRules: [] }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [ai, setAi] = useState<AiState>({
    running: false,
    error: null,
    suggestion: null,
    payload: null,
  });
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initialData) return;
    let cancelled = false;
    api<{ data: WorkspaceData }>(workspacePath)
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setDraft(
          res.data.managed.present && res.data.managed.template
            ? res.data.managed.template
            : res.data.recommended,
        );
        setPolicyDraft(policyOf(res.data));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, initialData]);

  const validation = useMemo(() => validateTemplate(draft), [draft]);
  const activation: Activation =
    data === null
      ? 'absent'
      : !data.managed.present
        ? 'absent'
        : data.managed.disabled === true
          ? 'disabled'
          : 'enabled';
  const applied = data?.managed.present ? (data.managed.template ?? '') : (data?.recommended ?? '');
  // COMPLETE-PLAN dirty/applyability (round-7 HIGH-1): the comparison covers
  // the normalized full plan — template + tw2cn + sourceAliases +
  // recognitionRules — because applyAi replaces ALL of it. FIRST-USE /
  // RE-ENABLE semantics are preserved: absent and disabled plans are
  // applyable with the unchanged recommendation / stored plan (Apply creates
  // or re-enables the managed row); only an ENABLED unchanged complete plan
  // is not applyable.
  const planDraft: CompleteNamingPlan = {
    template: draft,
    ...policyBody(policyDraft),
  };
  const planStored: CompleteNamingPlan | null =
    data === null
      ? null
      : {
          template: applied,
          tw2cn: data.managed.tw2cn,
          sourceAliases: data.managed.sourceAliases,
          recognitionRules: data.managed.recognitionRules ?? [],
        };
  const planMatches = planStored !== null && namingPlanEquals(planDraft, planStored);
  const applyable = data !== null && validation.ok && (activation !== 'enabled' || !planMatches);
  const canRollback = data?.priorPlan.present === true;

  const insertField = (field: NamingField) => {
    const el = draftRef.current;
    let next = draft;
    if (el && el.selectionStart !== undefined) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      next = `${draft.slice(0, start)}${'${'}${field}}${draft.slice(end)}`;
      requestAnimationFrame(() => {
        const caret = start + field.length + 3;
        el.setSelectionRange(caret, caret);
        el.focus();
      });
    } else {
      next = `${draft}${draft === '' || /\s$/.test(draft) ? '' : ' '}${'${'}${field}}`;
    }
    setDraft(next);
  };

  const runPreview = useCallback(async () => {
    if (!data || !validation.ok) return;
    setBusy(true);
    setPreviewError(null);
    try {
      // READ-ONLY workspace preview variant: the route builds the SAME
      // managed candidate apply would (shared builder) and dry-runs it with
      // the shared zero-write preview functions — no entity fetch, no
      // client-side candidate assembly.
      const res = await api<{
        data: PreviewResult & {
          candidate?: { id: string; index: number; mode: string };
        };
      }>(workspacePath, {
        method: 'POST',
        body: {
          preview: {
            template: draft,
            ...policyBody(policyDraft),
          },
        },
      });
      setPreview({ after: res.data.after, issues: res.data.issues });
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setBusy(false);
    }
  }, [data, draft, policyDraft, validation.ok, workspacePath]);

  const applyDraft = async () => {
    if (!data || !validation.ok) return;
    setBusy(true);
    setSaveError(null);
    setLastAction(null);
    try {
      // Server-side apply: same shared candidate builder as the preview,
      // preserves the existing op id + every policy field, persists the
      // prior plan, PATCHes through the shared save gate (CAS +
      // all-consumer preflight).
      const res = await api<{ data: WorkspaceData }>(workspacePath, {
        method: 'POST',
        body: {
          apply: {
            template: draft,
            ...policyBody(policyDraft),
          },
        },
      });
      setData(res.data);
      setPolicyDraft(policyOf(res.data));
      setPreview(null);
      setLastAction('applied');
    } catch (err) {
      setSaveError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  const rollback = async () => {
    if (!data || !canRollback) return;
    setBusy(true);
    setRollbackError(null);
    setLastAction(null);
    try {
      const res = await api<{ data: WorkspaceData }>(workspacePath, {
        method: 'POST',
        body: { rollback: true },
      });
      setData(res.data);
      setDraft(res.data.managed.present ? (res.data.managed.template ?? '') : res.data.recommended);
      setPolicyDraft(policyOf(res.data));
      setPreview(null);
      setLastAction('rolled-back');
    } catch (err) {
      setRollbackError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resetDraft = () => {
    setDraft(applied);
    setPolicyDraft(policyOf(data as WorkspaceData));
    setPreview(null);
    setPreviewError(null);
    setLastAction(null);
  };

  const runAi = async () => {
    if (!data) return;
    setAi({ running: true, error: null, suggestion: null, payload: null });
    try {
      // The ONE shared strict request contract: the profile-bound opaque
      // { ref } — raw type/id never leaves this surface.
      const res = await runNamingAnalysisRequest(api, data.entity.ref);
      setAi({
        running: false,
        error: null,
        suggestion: res.suggestion,
        payload: res.payload,
      });
    } catch (err) {
      setAi({
        running: false,
        error: err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err),
        suggestion: null,
        payload: null,
      });
    }
  };

  const applyAi = (suggestion: NamingSuggestion) => {
    // AI only replaces the FULL draft (template + complete policy) — it
    // never writes directly. completeDraftFromSuggestion makes every
    // partition explicit (round-7 HIGH-A): a model output that omitted
    // tw2cn becomes explicit false, so the later Apply body carries an own
    // `tw2cn: false` key and actually clears a stored true instead of being
    // silently patched as preserve-prior. An empty alias map stays {} so
    // Apply always sends the complete plan and the server replaces every
    // partition, including clearing prior aliases.
    setDraft(suggestion.template);
    setPolicyDraft(completeDraftFromSuggestion(suggestion));
    setPreview(null);
    setLastAction(null);
  };

  if (error) {
    return (
      <div>
        <PageTopbar>
          <span className="crumb">
            <a href={backHref}>{crumbPrefix}</a>
            <span className="sep">/</span> 智能命名
          </span>
        </PageTopbar>
        <p className={styles.error} role="alert">
          {error}
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div>
        <PageTopbar>
          <span className="crumb">
            <a href={backHref}>{crumbPrefix}</a>
            <span className="sep">/</span> 智能命名
          </span>
        </PageTopbar>
        <p className={styles.note}>加载中…</p>
      </div>
    );
  }

  const issues = preview?.issues ?? [];
  const issueByCode = (code: string) => issues.filter((i) => i.code === code);

  return (
    <div>
      <PageTopbar>
        <span className="crumb">
          <a href={backHref}>{crumbPrefix}</a>
          <span className="sep">/</span> 智能命名 · {data.entity.label}
        </span>
      </PageTopbar>
      <div className={styles.workspace}>
        {/* 1 · naming health */}
        <section className={styles.card} aria-labelledby="health-title">
          <h2 id="health-title">命名健康</h2>
          {data.health.map((source) => (
            <div key={source.sourceKey} className={styles.healthSource}>
              <h3>{source.sourceLabel}</h3>
              <p className={styles.note}>
                {source.nodeCount} 个节点 · 歧义节点 {source.ambiguousCount}
                {source.unavailable.length > 0 &&
                  ` · 不可用字段：${source.unavailable.map((f) => FIELD_HELP[f as NamingField] ?? f).join('、')}`}
                {source.partial.length > 0 &&
                  ` · 部分覆盖：${source.partial.map((f) => FIELD_HELP[f as NamingField] ?? f).join('、')}`}
              </p>
              <table className={styles.matrix}>
                <caption className={styles.srOnly}>字段覆盖率矩阵</caption>
                <thead>
                  <tr>
                    <th scope="col">字段</th>
                    <th scope="col">覆盖</th>
                    <th scope="col">置信度分布</th>
                    <th scope="col">代表值（脱敏）</th>
                  </tr>
                </thead>
                <tbody>
                  {source.fields.map((field) => (
                    <tr key={field.field}>
                      <th scope="row">{field.label}</th>
                      <td>
                        {field.present}/{field.total}（{field.percent}%）
                      </td>
                      <td>
                        {field.confidence.high > 0 && `高 ${field.confidence.high}`}
                        {field.confidence.medium > 0 && ` · 中 ${field.confidence.medium}`}
                        {field.confidence.low > 0 && ` · 低 ${field.confidence.low}`}
                        {field.confidence.high + field.confidence.medium + field.confidence.low ===
                          0 && '—'}
                      </td>
                      <td className={styles.samples}>
                        {field.samples.length > 0
                          ? field.samples.map((s) => (
                              <span
                                key={s.value}
                                className="mono"
                                title={`${KIND_LABELS[s.kind] ?? s.kind} · 置信 ${CONFIDENCE_LABELS[s.confidence] ?? s.confidence}`}
                              >
                                {s.value}×{s.count}
                              </span>
                            ))
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {source.nodeFacts.length > 0 && (
                <details className={styles.details}>
                  <summary>逐节点事实（不透明句柄 · 有界）</summary>
                  <ul className={styles.factList}>
                    {source.nodeFacts.slice(0, 20).map((fact, i) => (
                      <li key={`${fact.node}-${fact.field}-${i}`} className="mono">
                        {fact.node.slice(0, 8)} ·{' '}
                        {FIELD_HELP[fact.field as NamingField] ?? fact.field} ·{' '}
                        {fact.value ?? '未知'} ·{' '}
                        {CONFIDENCE_LABELS[fact.confidence ?? ''] ?? '未知'} ·{' '}
                        {KIND_LABELS[fact.kind ?? ''] ?? '未知'}
                        {fact.ambiguous ? ' · 歧义' : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {source.drift.length > 0 && (
                <div className={styles.warn} role="status">
                  <b>漂移提示：</b>
                  {source.drift
                    .map(
                      (d) =>
                        `${FIELD_HELP[d.field as NamingField] ?? d.field}：${d.samples.join(' / ')}`,
                    )
                    .join('；')}
                </div>
              )}
            </div>
          ))}
        </section>

        {/* 2 · template editor + full-plan policy */}
        <section className={styles.card} aria-labelledby="editor-title">
          <h2 id="editor-title">命名模板</h2>
          {activation === 'absent' && (
            <p className={styles.warn} role="status">
              尚未启用「名称统一」。推荐模板（确定性生成，无需 AI）已填入，可直接预览并应用。
            </p>
          )}
          {activation === 'disabled' && (
            <p className={styles.warn} role="status">
              「名称统一」当前已停用。已保存的方案已填入，可直接重新应用（无需其他修改）。
            </p>
          )}
          <textarea
            ref={draftRef}
            className={`input mono ${styles.templateInput}`}
            value={draft}
            rows={3}
            aria-label="命名模板"
            aria-describedby="workspace-validation"
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p
            id="workspace-validation"
            className={validation.ok ? styles.note : styles.error}
            role={validation.ok ? 'note' : 'alert'}
          >
            {validation.ok
              ? '模板合法：${字段} 必选，${?字段: 内容} 可选（字段缺失时整段消失），$$ 转义字面 $，分隔符写在模板里。'
              : validation.message}
          </p>
          <div className={styles.chips} role="group" aria-label="占位符">
            {NAMING_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                className="chip"
                onClick={() => insertField(field)}
                title={FIELD_HELP[field]}
              >
                {'${'}
                {field}
                {'}'}
              </button>
            ))}
          </div>
          <p className={styles.note}>
            序号优先复用上游编号（香港 01 → 01），否则由服务端分配并持久化，上游重排不会翻动名称。
            同配置节点只保留一次（按来源优先级）；格式化重名用「来源-序号」有意义地消歧。
            保存只改模板时，已有的来源别名 / 识别规则 / 台湾旗策略全部保留；AI
            建议会整份替换模板与策略。
          </p>
        </section>

        {/* 3 · AI suggestion (full-plan draft replacement, truthful disclosure) */}
        <section className={styles.card} aria-labelledby="ai-title">
          <h2 id="ai-title">AI 建议</h2>
          <div className={styles.row}>
            <button
              type="button"
              className="btn"
              onClick={runAi}
              disabled={ai.running}
              aria-busy={ai.running}
            >
              {ai.running ? '分析中…' : 'AI 建议模板'}
            </button>
            <span className={styles.note}>
              可选：让 AI 根据脱敏后的节点特征建议完整方案（模板 + 台湾旗策略 + 来源别名 +
              识别规则）， 应用后会整份替换当前草稿，仍需你保存才生效。
            </span>
          </div>
          {ai.error && (
            <p className={styles.error} role="alert">
              {ai.error}（手动配置不受影响）
            </p>
          )}
          {ai.suggestion && ai.payload && (
            <AiAnalysisPanel suggestion={ai.suggestion} payload={ai.payload} onApply={applyAi} />
          )}
        </section>

        {/* 4 · raw → facts → final preview */}
        <section className={styles.card} aria-labelledby="preview-title">
          <h2 id="preview-title">原始 → 事实 → 最终名称</h2>
          <div className={styles.row}>
            <button
              type="button"
              className="btn primary"
              onClick={runPreview}
              disabled={busy || !validation.ok}
            >
              {busy ? '预览中…' : '预览全部节点'}
            </button>
            <span className={styles.note}>只读试算，不会保存。</span>
          </div>
          {previewError && (
            <p className={styles.error} role="alert">
              {previewError}
            </p>
          )}
          {preview && (
            <div>
              <p className={styles.note} role="status">
                共 {preview.after.count} 个节点
                {preview.after.truncated ? '（仅显示前 300 个名称）' : ''}
              </p>
              {issueByCode('duplicate-final-name').length > 0 && (
                <div className={styles.warn} role="status">
                  最终名称仍有重名（保存会被拒绝）：
                  {issueByCode('duplicate-final-name')
                    .map((i) => i.name)
                    .join('、')}
                </div>
              )}
              {issueByCode('rename-collision-resolved').length > 0 && (
                <div className={styles.warn} role="status">
                  已用「来源-序号」消歧：
                  {issueByCode('rename-collision-resolved')
                    .map((i) => i.name)
                    .join('、')}
                </div>
              )}
              {issueByCode('true-dedup').length > 0 && (
                <div className={styles.warn} role="status">
                  同配置节点已去重（{issueByCode('true-dedup').length} 条）：保留{' '}
                  {issueByCode('true-dedup')
                    .slice(0, 3)
                    .map((i) => i.kept)
                    .join('、')}
                </div>
              )}
              {issueByCode('orphaned-reference').length > 0 && (
                <div className={styles.error} role="alert">
                  改名会让引用悬空（链式代理后端悬空会导致整份配置无法加载）：
                  {issueByCode('orphaned-reference')
                    .slice(0, 5)
                    .map((i) => `${i.node}（${i.via}）`)
                    .join('、')}
                </div>
              )}
              <ul className={styles.nameList}>
                {preview.after.names.slice(0, 20).map((name, i) => (
                  <li key={i} className="mono">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* 5 · diagnostics (current state) */}
        {data.diagnostics.collisions.length + data.diagnostics.deduped.length > 0 && (
          <section className={styles.card} aria-labelledby="diag-title">
            <h2 id="diag-title">当前模板诊断</h2>
            {data.diagnostics.collisions.length > 0 && (
              <div className={styles.warn} role="status">
                当前模板下 {data.diagnostics.collisions.length} 个格式化重名已按「来源-序号」消歧。
              </div>
            )}
            {data.diagnostics.deduped.length > 0 && (
              <div className={styles.warn} role="status">
                当前模板下 {data.diagnostics.deduped.length} 个同配置节点已按来源优先级去重：
                {data.diagnostics.deduped
                  .slice(0, 3)
                  .map((d) => `「${d.kept}」← 「${d.dropped}」`)
                  .join('；')}
              </div>
            )}
          </section>
        )}

        {/* 6 · reference impact */}
        <section className={styles.card} aria-labelledby="refs-title">
          <h2 id="refs-title">消费方与引用影响</h2>
          <p className={styles.note}>
            消费该来源的配置文件：
            {data.references.consumingProfiles.length > 0
              ? data.references.consumingProfiles.map((p) => p.name).join('、')
              : '无（保存仅走 CAS）'}
          </p>
          {data.references.orphaned.length > 0 && (
            <div className={styles.error} role="alert">
              当前模板会令以下按名引用悬空：
              {data.references.orphaned
                .slice(0, 5)
                .map((r) => `${r.node}（${r.via}）`)
                .join('、')}
            </div>
          )}
        </section>

        {/* 7 · apply state + persisted rollback */}
        <section className={styles.card} aria-labelledby="apply-title">
          <h2 id="apply-title">应用</h2>
          <div className={styles.row}>
            <button
              type="button"
              className="btn primary"
              onClick={applyDraft}
              disabled={busy || !validation.ok || !applyable}
              title={activation === 'enabled' && planMatches ? '方案未变化，无需保存' : undefined}
            >
              保存并应用模板
            </button>
            <button
              type="button"
              className="btn"
              onClick={rollback}
              disabled={busy || !canRollback}
            >
              回滚到上一方案
            </button>
            <button
              type="button"
              className="btn"
              onClick={resetDraft}
              disabled={!applyable && activation !== 'enabled'}
            >
              放弃未保存修改
            </button>
            <span className={styles.note} role="status">
              {lastAction === 'applied' && '已保存并生效。'}
              {lastAction === 'rolled-back' && '已回滚到上一方案。'}
              {!lastAction && activation === 'absent' && '首次使用：推荐模板可直接应用。'}
              {!lastAction && activation === 'disabled' && '已停用：已保存方案可直接重新应用。'}
              {!lastAction && activation === 'enabled' && applyable && '有未保存的修改。'}
              {!lastAction && activation === 'enabled' && !applyable && '已与保存状态一致。'}
            </span>
          </div>
          {saveError && (
            <p className={styles.error} role="alert">
              {saveError}
            </p>
          )}
          {rollbackError && (
            <p className={styles.error} role="alert">
              {rollbackError}
            </p>
          )}
          <p className={styles.note}>
            {canRollback
              ? data.priorPlan.hadManaged === false
                ? '服务端已持久化上一状态（未启用命名），可一键回滚并移除「名称统一」步骤。'
                : '服务端已持久化上一方案（含来源别名 / 识别规则 / 台湾旗策略），可随时一键回滚。'
              : '暂无持久化的上一方案：首次应用后，之前的完整状态（含“未启用”）会成为回滚目标。'}
            保存前会对每个消费方配置文件用同一候选做完整预检（共享来源不被静默改写），并按配置版本
            CAS 提交。旧版（成分/预设）配置会自动投影为等价模板，首次保存后持久化为模板形态。
          </p>
        </section>
      </div>
    </div>
  );
}

/**
 * Presentational AI suggestion panel — rendered from the exact response the
 * route returned. Truthful disclosure: the payload sent to the configured
 * model contains bounded, structurally redacted ORIGINAL display names and
 * safe source labels; sources render as `label ?? id` — never [object
 * Object], never credentials/endpoints/internal ids.
 */
export function AiAnalysisPanel({
  suggestion,
  payload,
  onApply,
}: {
  suggestion: NamingSuggestion;
  payload: ScrubbedPayload;
  onApply: (suggestion: NamingSuggestion) => void;
}) {
  return (
    <div className={styles.aiResult}>
      <p className={styles.note} role="note">
        {suggestion.reason}
      </p>
      <p className={`mono ${styles.aiTemplate}`}>{suggestion.template}</p>
      <div className={styles.row}>
        <button type="button" className="btn primary" onClick={() => onApply(suggestion)}>
          应用建议（替换整份草稿）
        </button>
        <span className={styles.note}>应用后仍需保存才生效；不会直接写入。</span>
      </div>
      <details className={styles.details}>
        <summary>查看本次发送给 AI 的数据（已脱敏）</summary>
        <ul className={styles.aiPayloadList}>
          <li>
            样本 {payload.sampled}/{payload.nodeCount} 个节点
          </li>
          <li>
            来源：
            {payload.sources.length > 0
              ? payload.sources.map((source) => source.label ?? source.id).join('、')
              : '无'}
          </li>
          {payload.regions.length > 0 && (
            <li>地区分布：{payload.regions.map((r) => `${r.code}×${r.count}`).join('、')}</li>
          )}
          {payload.rates.length > 0 && <li>识别到的倍率：{payload.rates.join('、')}</li>}
          {payload.nodes.slice(0, 5).map((node) =>
            node.name ? (
              <li key={`${node.i}-${node.name}`} className="mono">
                示例：{node.name}
              </li>
            ) : null,
          )}
        </ul>
        <p className={styles.note}>
          发送内容：每条节点经结构化脱敏后的有界原始显示名（URL / 服务器 / IP / 端口 / UUID / 令牌 /
          密钥等凭据形状的内容已删除，普通名字如 HK-01、IPLC、家宽 会原样保留）与安全的来源显示标签
          （无显示名时用不透明标识）。不会发送订阅
          URL、服务器地址、凭据或内部标识；残片仅以布尔形式存在。
        </p>
      </details>
    </div>
  );
}
