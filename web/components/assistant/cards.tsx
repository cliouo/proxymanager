'use client';

/**
 * Prefab result components + registry. The assistant never renders raw model
 * HTML/markdown for an action result — the orchestrator emits a typed
 * { kind, data } envelope and we draw it with a trusted component here.
 *
 * To support a new action result: add a component and register it by `kind`.
 */

import { useState, type ComponentType } from 'react';
import { api } from '@/lib/client/api';

/** Terminal outcome of a confirm-write card, lifted to the panel so it persists. */
export type ConfirmResolution =
  | { status: 'executed'; result: { kind: string; data: unknown } }
  | { status: 'cancelled' };

interface CardProps {
  data: unknown;
  /** Only consumed by ConfirmWriteCard; lets the panel record the terminal state. */
  onResolved?: (res: ConfirmResolution) => void;
  /** Only consumed by WriteResultCard; lets the panel persist that this write was undone. */
  onUndone?: () => void;
}

interface RuleView {
  type: string;
  value: string;
  policy: string;
  anchor: string;
  note?: string | null;
}

function Chip({ label, tone = 'default' }: { label: string; tone?: 'default' | 'primary' }) {
  const cls =
    tone === 'primary'
      ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary-hover)]'
      : 'bg-[var(--color-bg-strong)] text-[var(--color-fg-soft)]';
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium leading-none ${cls}`}
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {label}
    </span>
  );
}

function DocCitationCard({ data }: CardProps) {
  const d = data as {
    question?: string;
    repo?: string;
    answer?: string;
    source?: string;
    unavailable?: boolean;
    hint?: string;
  };
  if (d.unavailable) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[13px] text-[var(--color-fg-soft)]">
        <div className="mb-1 text-[var(--color-warn)]">文档检索暂不可用</div>
        {d.hint && <div className="text-[var(--color-muted)]">{d.hint}</div>}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      {/* P3-43: 10–11px 眉标 / 微文原用 --color-muted-strong(=--faint，对比不足)，
          全部改吃 --color-muted 以过 WCAG AA（本文件共 7 处）。 */}
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          mihomo 文档
        </span>
        {d.repo && <Chip label={d.repo.replace('MetaCubeX/', '')} tone="primary" />}
      </div>
      <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-fg-soft)]">
        {d.answer}
      </div>
      {d.source && (
        <a
          href={d.source}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-[12px] text-[var(--color-primary)] hover:text-[var(--color-primary-hover)]"
        >
          来源 ↗
        </a>
      )}
    </div>
  );
}

function RuleListCard({ data }: CardProps) {
  const d = data as {
    anchor?: string | null;
    count?: number;
    rules?: Array<{
      type: string;
      value: string;
      policy: string;
      anchor: string;
      options?: string[];
      enabled?: boolean;
      note?: string | null;
    }>;
  };
  const rules = d.rules ?? [];
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        规则 {d.count ?? rules.length} 条{d.anchor ? ` · 锚点 ${d.anchor}` : ''}
      </div>
      {rules.length === 0 ? (
        <div className="text-[13px] text-[var(--color-muted)]">（无）</div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rules.slice(0, 50).map((r, i) => (
            <li
              key={i}
              className={`flex flex-wrap items-center gap-1.5 text-[12px] ${
                r.enabled === false ? 'opacity-50' : ''
              }`}
            >
              <Chip label={r.type} />
              <span style={{ fontFamily: 'var(--font-mono)' }} className="text-[var(--color-fg)]">
                {r.value || '—'}
              </span>
              {(r.options ?? []).map((o) => (
                <span
                  key={o}
                  className="rounded bg-[var(--color-bg-strong)] px-1 text-[10px] text-[var(--color-plum)]"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {o}
                </span>
              ))}
              <span className="text-[var(--color-muted)]">→</span>
              <Chip label={r.policy} tone="primary" />
              {r.enabled === false && <span className="text-[var(--color-muted)]">· 停用</span>}
              {r.note && <span className="text-[var(--color-muted)]">· {r.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OverviewSection({
  title,
  items,
  tone,
}: {
  title: string;
  items?: string[];
  tone?: 'primary';
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        {title}（{items?.length ?? 0}）
      </div>
      <div className="flex flex-wrap gap-1">
        {(items ?? []).map((x) => (
          <Chip key={x} label={x} tone={tone} />
        ))}
      </div>
    </div>
  );
}

function BaseOverviewCard({ data }: CardProps) {
  const d = data as {
    anchors?: string[];
    policies?: string[];
    proxyProviders?: string[];
    ruleProviders?: string[];
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <OverviewSection title="策略组 / 节点" items={d.policies} tone="primary" />
      <OverviewSection title="规则锚点" items={d.anchors} />
      <OverviewSection title="代理集合" items={d.proxyProviders} />
      <OverviewSection title="规则集" items={d.ruleProviders} />
    </div>
  );
}

function ErrorCard({ data }: CardProps) {
  const d = data as { error?: string };
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[13px] text-[var(--color-danger)]">
      {d.error ?? '出错了'}
    </div>
  );
}

function RuleLine({ r, struck }: { r: RuleView; struck?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
      <Chip label={r.type} />
      <span
        style={{ fontFamily: 'var(--font-mono)' }}
        className={struck ? 'text-[var(--color-muted)] line-through' : 'text-[var(--color-fg)]'}
      >
        {r.value}
      </span>
      <span className="text-[var(--color-muted)]">→</span>
      <Chip label={r.policy} tone="primary" />
      <span className="text-[var(--color-muted)]">· 锚点 {r.anchor}</span>
    </div>
  );
}

function DiffView({ diff }: { diff: unknown }) {
  const d = diff as { op?: string; before?: RuleView; after?: RuleView };
  return (
    <div className="flex flex-col gap-1.5 rounded bg-[var(--color-bg-sunk)] p-2">
      {d.before && (
        <div className="flex items-start gap-2">
          <span className="text-[12px] leading-5 text-[var(--color-danger)]">−</span>
          <RuleLine r={d.before} struck={d.op === 'delete' || d.op === 'update'} />
        </div>
      )}
      {d.after && (
        <div className="flex items-start gap-2">
          <span className="text-[12px] leading-5 text-[var(--color-success)]">+</span>
          <RuleLine r={d.after} />
        </div>
      )}
    </div>
  );
}

type DiffRow = { t: 'ctx' | 'del' | 'add'; text: string };

/**
 * Line-level unified diff via LCS. before/after are whole-section YAML, so a
 * one-line change in a big block shouldn't force the reader to eyeball two full
 * copies. A pure add (before=[]) yields all-'add' rows, a pure delete all-'del'.
 */
function diffLines(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ t: 'del', text: a[i++] });
    } else {
      rows.push({ t: 'add', text: b[j++] });
    }
  }
  while (i < n) rows.push({ t: 'del', text: a[i++] });
  while (j < m) rows.push({ t: 'add', text: b[j++] });
  return rows;
}

const CONTEXT = 3;

/** Mark unchanged lines >CONTEXT away from any change for collapsing. */
function collapseContext(rows: DiffRow[]): Array<DiffRow | { t: 'gap'; n: number }> {
  const keep = rows.map((r) => r.t !== 'ctx');
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].t === 'ctx') continue;
    for (let d = -CONTEXT; d <= CONTEXT; d++) {
      if (k + d >= 0 && k + d < rows.length) keep[k + d] = true;
    }
  }
  const out: Array<DiffRow | { t: 'gap'; n: number }> = [];
  let hidden = 0;
  for (let k = 0; k < rows.length; k++) {
    if (keep[k]) {
      if (hidden > 0) {
        out.push({ t: 'gap', n: hidden });
        hidden = 0;
      }
      out.push(rows[k]);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) out.push({ t: 'gap', n: hidden });
  return out;
}

const ROW_STYLE: Record<DiffRow['t'], { bg?: string; sign: string; color: string }> = {
  ctx: { sign: ' ', color: 'var(--color-muted)' },
  del: { bg: 'color-mix(in srgb, var(--color-danger) 9%, transparent)', sign: '-', color: 'var(--color-danger)' },
  add: { bg: 'color-mix(in srgb, var(--color-success) 14%, transparent)', sign: '+', color: 'var(--color-fg)' },
};

function ConfigDiffView({ diff }: { diff: unknown }) {
  const d = diff as { op?: string; path?: string; beforeYaml?: string; afterYaml?: string };
  const before = d.beforeYaml === undefined ? [] : d.beforeYaml.split('\n');
  const after = d.afterYaml === undefined ? [] : d.afterYaml.split('\n');
  const rows = diffLines(before, after);
  const dels = rows.filter((r) => r.t === 'del').length;
  const adds = rows.filter((r) => r.t === 'add').length;
  const display = collapseContext(rows);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span style={{ fontFamily: 'var(--font-mono)' }} className="text-[var(--color-muted)]">
          {d.path}
        </span>
        {dels > 0 && <span className="text-[var(--color-danger)]">−{dels}</span>}
        {adds > 0 && <span className="text-[var(--color-success)]">+{adds}</span>}
      </div>
      <div
        className="max-h-80 overflow-auto rounded bg-[var(--color-bg-sunk)] py-1 text-[12px] leading-relaxed"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {display.map((row, k) =>
          row.t === 'gap' ? (
            <div
              key={k}
              className="select-none px-2 py-0.5 text-center text-[10px] text-[var(--color-muted)]"
            >
              ⋯ {row.n} 行未变 ⋯
            </div>
          ) : (
            <div key={k} className="flex" style={{ backgroundColor: ROW_STYLE[row.t].bg }}>
              <span
                className="w-4 shrink-0 select-none text-center"
                style={{ color: ROW_STYLE[row.t].color }}
              >
                {ROW_STYLE[row.t].sign}
              </span>
              <span
                className="whitespace-pre pr-2"
                style={{ color: ROW_STYLE[row.t].color }}
              >
                {row.text.length ? row.text : ' '}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function ConfirmWriteCard({ data, onResolved }: CardProps) {
  const d = data as { action: string; summary: string; diff: unknown; token: string };
  // Pick the renderer by diff shape: a YAML line-diff carries before/afterYaml
  // (config-section + rule-provider edits); the rule diff carries before/after
  // rule objects. Shape-based so new YAML-diff actions render without a list here.
  const diffObj = (d.diff ?? {}) as { beforeYaml?: string; afterYaml?: string };
  const isYamlDiff = 'beforeYaml' in diffObj || 'afterYaml' in diffObj;
  const [state, setState] = useState<'idle' | 'busy' | 'cancelled' | 'error'>('idle');
  const [result, setResult] = useState<{ kind: string; data: unknown } | null>(null);
  const [error, setError] = useState('');

  async function approve() {
    setState('busy');
    try {
      const res = await api<{ data: { kind: string; data: unknown } }>(
        '/api/v1/assistant/confirm',
        { method: 'POST', body: { token: d.token }, headers: { 'X-Source': 'ai_chat' } },
      );
      setResult(res.data);
      // Lift the outcome so the panel can replace this card with its settled
      // result — otherwise a refresh restores the (one-time, now-dead) token
      // and shows approve/cancel again for an action already executed.
      onResolved?.({ status: 'executed', result: res.data });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  function cancel() {
    setState('cancelled');
    onResolved?.({ status: 'cancelled' });
  }

  if (result) return <ResultCard kind={result.kind} data={result.data} />;
  if (state === 'cancelled') {
    return <div className="text-[13px] text-[var(--color-muted)]">已取消该改动。</div>;
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] border-l-2 border-l-[var(--color-warn)] bg-[var(--color-surface)] p-3">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-warn)]">
        待你确认的写操作
      </div>
      <div className="mb-2 text-[13px] text-[var(--color-fg)]">{d.summary}</div>
      {isYamlDiff ? <ConfigDiffView diff={d.diff} /> : <DiffView diff={d.diff} />}
      {state === 'error' && (
        <div className="mt-2 text-[12px] text-[var(--color-danger)]">{error}</div>
      )}
      {/* P3-37: 统一到 v2 全局 .btn / .btn.primary,取代手写按钮类(disabled 态由 .btn[disabled] 处理) */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={state === 'busy'}
          className="btn primary"
        >
          {state === 'busy' ? '执行中…' : '批准并执行'}
        </button>
        <button type="button" onClick={cancel} disabled={state === 'busy'} className="btn ghost">
          取消
        </button>
      </div>
    </div>
  );
}

function WriteResultCard({ data, onUndone }: CardProps) {
  const d = data as {
    op?: string;
    summary?: string;
    events?: Array<{ id: string; op: string }>;
    undone?: boolean;
  };
  const eventId = d.events?.[0]?.id;
  // Seed from persisted data so a restored, already-undone write shows 已撤销
  // instead of offering the (idempotency-guarded, but misleading) undo again.
  const [undo, setUndo] = useState<'no' | 'busy' | 'yes' | 'err'>(d.undone ? 'yes' : 'no');

  async function doUndo() {
    if (!eventId) return;
    setUndo('busy');
    try {
      await api(`/api/v1/history/${eventId}/undo`, {
        method: 'POST',
        headers: { 'X-Source': 'ai_chat' },
      });
      setUndo('yes');
      onUndone?.();
    } catch {
      setUndo('err');
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] border-l-2 border-l-[var(--color-success)] bg-[var(--color-surface)] p-3">
      <span className="text-[13px] text-[var(--color-fg)]">
        <span className="text-[var(--color-success)]">✓ </span>
        {d.summary ?? '已写入'}
      </span>
      {eventId && undo === 'no' && (
        <button
          onClick={() => void doUndo()}
          className="shrink-0 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)]"
        >
          撤销
        </button>
      )}
      {undo === 'busy' && (
        <span className="shrink-0 text-[12px] text-[var(--color-muted)]">撤销中…</span>
      )}
      {undo === 'yes' && (
        <span className="shrink-0 text-[12px] text-[var(--color-muted)]">已撤销</span>
      )}
      {undo === 'err' && (
        <span className="shrink-0 text-[12px] text-[var(--color-danger)]">撤销失败</span>
      )}
    </div>
  );
}

interface OutlineEntry {
  key: string;
  kind: 'scalar' | 'map' | 'list-named' | 'list';
  value?: unknown;
  count?: number;
  names?: string[];
  children?: string[];
}

function ConfigOutlineCard({ data }: CardProps) {
  const d = data as { sections?: OutlineEntry[] };
  const sections = d.sections ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
        配置目录
      </div>
      <ul className="flex flex-col gap-1.5">
        {sections.map((s, i) => (
          <li key={i} className="text-[12px]">
            <span style={{ fontFamily: 'var(--font-mono)' }} className="text-[var(--color-fg)]">
              {s.key}
            </span>
            {s.kind === 'scalar' && (
              <span className="text-[var(--color-muted)]">: {String(s.value)}</span>
            )}
            {s.kind === 'list' && (
              <span className="text-[var(--color-muted)]"> · {s.count} 项</span>
            )}
            {(s.kind === 'list-named' || s.kind === 'map') && (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {(s.names ?? s.children ?? []).map((n) => (
                  <Chip key={n} label={n} />
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfigSectionCard({ data }: CardProps) {
  const d = data as { path?: string; found?: boolean; yaml?: string; redacted?: boolean };
  if (d.found === false) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-[13px] text-[var(--color-muted)]">
        路径{' '}
        <code style={{ fontFamily: 'var(--font-mono)' }} className="text-[var(--color-fg)]">
          {d.path}
        </code>{' '}
        不存在
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          style={{ fontFamily: 'var(--font-mono)' }}
          className="text-[12px] text-[var(--color-fg)]"
        >
          {d.path}
        </span>
        {d.redacted && <span className="text-[11px] text-[var(--color-warn)]">🔒 凭证已脱敏</span>}
      </div>
      {/* P3-39: 主题感知代码底色（--code-bg/--code-fg），取代写死暖褐 surface-dark */}
      <pre
        className="overflow-auto rounded border border-[var(--color-border)] bg-[var(--code-bg)] p-2.5 text-[12px] leading-relaxed text-[var(--code-fg)]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {d.yaml}
      </pre>
    </div>
  );
}

function ConfigFullCard({ data }: CardProps) {
  const d = data as { yaml?: string };
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-muted)]">
          完整配置
        </span>
        <span className="text-[11px] text-[var(--color-warn)]">🔒 已脱敏</span>
      </div>
      {/* P3-39: 主题感知代码底色 */}
      <pre
        className="max-h-96 overflow-auto rounded border border-[var(--color-border)] bg-[var(--code-bg)] p-2.5 text-[12px] leading-relaxed text-[var(--code-fg)]"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {d.yaml}
      </pre>
    </div>
  );
}

/** A confirm-write the user declined — the persisted terminal form of a cancel. */
function CancelledCard({ data }: CardProps) {
  const d = data as { summary?: string };
  return (
    <div className="text-[13px] text-[var(--color-muted)]">
      已取消该改动{d.summary ? `：${d.summary}` : ''}。
    </div>
  );
}

const REGISTRY: Record<string, ComponentType<CardProps>> = {
  'doc-citation': DocCitationCard,
  'rule-list': RuleListCard,
  'base-overview': BaseOverviewCard,
  'config-outline': ConfigOutlineCard,
  'config-section': ConfigSectionCard,
  'config-full': ConfigFullCard,
  'confirm-write': ConfirmWriteCard,
  'confirm-cancelled': CancelledCard,
  'write-result': WriteResultCard,
  error: ErrorCard,
};

export function ResultCard({
  kind,
  data,
  onResolved,
  onUndone,
}: {
  kind: string;
  data: unknown;
  onResolved?: (res: ConfirmResolution) => void;
  onUndone?: () => void;
}) {
  const Component = REGISTRY[kind];
  if (Component) return <Component data={data} onResolved={onResolved} onUndone={onUndone} />;
  // Fallback: render unknown envelopes as compact JSON so nothing is lost.
  return (
    // P3-39: 主题感知代码底色
    <pre
      className="overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--code-bg)] p-3 text-[12px] text-[var(--code-fg)]"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

/**
 * Read-action results are the AI's input, not the user's answer — show them
 * as a collapsed "✓ did X" trace the user can expand for transparency, while
 * the model's own Markdown reply (built from the relevant subset) is the
 * primary user-facing content.
 */
export function CollapsibleResult({
  label,
  kind,
  data,
}: {
  label: string;
  kind: string;
  data: unknown;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[12px] text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
      >
        <span className="text-[var(--color-success)]">✓</span>
        {label}
        <span className="text-[10px] text-[var(--color-muted)]">
          {open ? '收起 ▾' : '展开 ▸'}
        </span>
      </button>
      {open && (
        <div className="mt-1.5">
          <ResultCard kind={kind} data={data} />
        </div>
      )}
    </div>
  );
}
