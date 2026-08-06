'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageTopbar } from '@/components/PageChrome';
import { ApiError, api } from '@/lib/client/api';
import type { OperatorStep } from '@/lib/proxies/operators';
import {
  hasFlagRedundancy,
  matchesRenamedAt,
  renamedAfterManaged,
} from '@/lib/proxies/pipelineWarnings';
import {
  buildSaveCandidate,
  pipelineStatusMessage,
  saveBlockedBy,
} from '@/lib/proxies/pipelineSaveCandidate';
import { REGIONS } from '@/lib/proxies/regions';
import {
  hasOwnCompatibilityIssue,
  isCurrentRenameTemplateOperator,
  isParkedOperator,
  OperatorSchema,
  PARKED_OPERATOR_KIND,
  PROXY_TYPES,
  STORED_OPERATOR_COMPATIBILITY_ISSUE,
  STORED_OPERATOR_DUPLICATE_ISSUE,
  type Operator,
  type OperatorKind,
  type RenameTemplateOp,
  type StoredOperator,
} from '@/schemas/operator';
import { RenameTemplateEditor } from './RenameTemplateEditor';
import styles from './pipeline.module.css';

/* ─── meta ─────────────────────────────────────────────────────────── */

/**
 * Two work areas — 名称统一 (name-only ops) vs 其他处理 (node-set/list/property
 * ops). A pure VIEW grouping: the backend stays one ordered operators[]
 * pipeline, the list below always shows every step in array order, and
 * reordering across areas is the same move as within one.
 */
type WorkArea = 'naming' | 'other';

const AREA_META: Record<WorkArea, { title: string; desc: string }> = {
  naming: {
    title: '名称统一',
    desc: '只改节点名称：模板命名 / 正则重命名 / 国旗 Emoji',
  },
  other: {
    title: '其他处理',
    desc: '增删、排序与属性：过滤 / 去重 / 排序 / 设置属性',
  },
};

const KIND_META: Record<
  OperatorKind | typeof PARKED_OPERATOR_KIND,
  { title: string; desc: string }
> = {
  'rename-template': { title: '模板命名', desc: '按地区 / 倍率 / 来源等成分统一生成名称' },
  'rename-regex': { title: '正则重命名', desc: '正则替换节点名（替换为空 = 删除）' },
  'flag-emoji': { title: '国旗 Emoji', desc: '按地区在名称前加上或移除国旗' },
  'filter-regex': { title: '正则过滤', desc: '按名称正则保留或排除节点' },
  'filter-useless': { title: '去除无用节点', desc: '丢弃流量 / 到期 / 官网等信息节点' },
  'filter-type': { title: '类型过滤', desc: '按协议类型保留或排除节点' },
  'filter-region': { title: '地区过滤', desc: '按识别出的地区保留或排除' },
  dedup: { title: '处理重复节点', desc: '按名称或 server:port 去重' },
  sort: { title: '排序', desc: '按名称 / 类型 / 服务器 / 地区排序' },
  'set-prop': { title: '设置属性', desc: '强制 UDP / TFO / 跳过证书校验' },
  [PARKED_OPERATOR_KIND]: {
    title: '无法解码的步骤',
    desc: '历史数据无法识别，已停用且不执行（可直接删除）',
  },
};

/** Work area of each operator kind (UI categorization only). */
const AREA_OF_KIND: Record<OperatorKind | typeof PARKED_OPERATOR_KIND, WorkArea> = {
  'rename-template': 'naming',
  'rename-regex': 'naming',
  'flag-emoji': 'naming',
  'filter-regex': 'other',
  'filter-useless': 'other',
  'filter-type': 'other',
  'filter-region': 'other',
  dedup: 'other',
  sort: 'other',
  'set-prop': 'other',
  [PARKED_OPERATOR_KIND]: 'other',
};

/**
 * The managed rename-template row is NOT generically addable — it is
 * created/enabled exclusively through the 智能命名 workspace (the server
 * gate rejects generic creation/touch/delete/move). Exported for the UI
 * acceptance tests: the generic add menu must never offer it.
 */
export const ADDABLE_KINDS: Record<WorkArea, OperatorKind[]> = {
  naming: ['rename-regex', 'flag-emoji'],
  other: [
    'filter-regex',
    'filter-useless',
    'filter-type',
    'filter-region',
    'dedup',
    'sort',
    'set-prop',
  ],
};

function makeOperator(kind: OperatorKind, aggregate: boolean): Operator {
  const id = crypto.randomUUID();
  switch (kind) {
    case 'filter-regex':
      return { id, kind, mode: 'keep', pattern: '', flags: 'i' };
    case 'filter-useless':
      return { id, kind, extra: [] };
    case 'rename-regex':
      return { id, kind, pattern: '', replacement: '', flags: 'gi' };
    case 'flag-emoji':
      return { id, kind, action: 'add' };
    case 'filter-type':
      return { id, kind, mode: 'keep', types: [] };
    case 'sort':
      return { id, kind, by: 'name', order: 'asc' };
    case 'set-prop':
      return { id, kind };
    case 'dedup':
      return { id, kind, by: 'name', action: 'drop' };
    case 'filter-region':
      return { id, kind, mode: 'keep', regions: [] };
    case 'rename-template':
      void aggregate;
      // Unreachable: rename-template is not in ADDABLE_KINDS — the managed
      // row comes from the naming workspace only.
      return { id, kind, template: '', recognitionRules: [] };
  }
}

/** A step is sendable to preview only when its required fields are filled + valid. */
function isComplete(op: StoredOperator): boolean {
  if (isParkedOperator(op)) return false;
  if (hasOwnCompatibilityIssue(op)) {
    // Runtime-parked history is editable: complete only once the CURRENT
    // schema accepts the edited shape (unsafe regex / oversized aliases…).
    // The save then strips the diagnostic field (Object.hasOwn prevents
    // inherited values/getters from promoting a historical row).
    return OperatorSchema.safeParse(op).success;
  }
  switch (op.kind) {
    case 'filter-regex':
    case 'rename-regex': {
      const p = op.pattern?.trim();
      if (!p) return false;
      try {
        new RegExp(p, op.flags ?? '');
        return true;
      } catch {
        return false;
      }
    }
    case 'filter-type':
      return op.types.length > 0;
    case 'filter-region':
      return op.regions.length > 0;
    default:
      return true;
  }
}

function summarize(op: StoredOperator): string {
  if (isParkedOperator(op)) {
    return `历史数据无法解码（${op.compatibility_issue}），已停用`;
  }
  switch (op.kind) {
    case 'filter-regex':
      return `${op.mode === 'keep' ? '保留' : '排除'} · /${op.pattern || '…'}/${op.flags ?? ''}`;
    case 'filter-useless':
      return op.extra.length ? `内置 + ${op.extra.length} 额外关键词` : '内置规则';
    case 'rename-regex':
      return `/${op.pattern || '…'}/ → ${op.replacement === '' ? '（删除）' : op.replacement}`;
    case 'flag-emoji':
      return op.action === 'add' ? (op.tw2cn ? '添加国旗 · 台湾→🇨🇳' : '添加国旗') : '移除国旗';
    case 'rename-template': {
      return op.template.trim() === '' ? '未填模板' : op.template;
    }
    case 'filter-type':
      return `${op.mode === 'keep' ? '保留' : '排除'} · ${op.types.join(' ') || '未选类型'}`;
    case 'sort':
      return `${{ name: '名称', type: '类型', server: '服务器', region: '地区' }[op.by]} ${op.order === 'asc' ? '↑' : '↓'}`;
    case 'set-prop': {
      const bits: string[] = [];
      if (op.udp !== undefined) bits.push(`UDP ${op.udp ? '开' : '关'}`);
      if (op.tfo !== undefined) bits.push(`TFO ${op.tfo ? '开' : '关'}`);
      if (op.skipCertVerify !== undefined) bits.push(`跳过证书 ${op.skipCertVerify ? '开' : '关'}`);
      return bits.join(' · ') || '未设置';
    }
    case 'dedup':
      return `${op.by === 'name' ? '按名称' : '按 server:port'} · ${op.action === 'drop' ? '丢弃' : '重命名'}`;
    case 'filter-region':
      return `${op.mode === 'keep' ? '保留' : '排除'} · ${op.regions.join(' ') || '未选地区'}`;
  }
}
/**
 * The ONE shared logical-managed predicate (round-9): delegates to the
 * schema-level isCurrentRenameTemplateOperator — the identical predicate
 * used by the stored decoder, snapshot classifier, and mutation policy.
 * An inherited Object.prototype value/getter never demotes a valid managed
 * row nor promotes a historical one.
 */
export function isLogicalManagedOperator(op: StoredOperator): boolean {
  return isCurrentRenameTemplateOperator(op);
}

/**
 * The immutable managed rename-template anchor — ordinary rows must never
 * swap across it (round-7 HIGH-2). The managed row itself renders no move
 * controls, but an adjacent ordinary row could still move onto/over it: the
 * retained server gate rejects that state, so the rendered UI must make such
 * moves unavailable. Same-side reorder on either side of the anchor stays
 * valid. ONE shared predicate (isLogicalManagedOperator) drives both the
 * rendered controls and the acceptance tests — the server mutation gate is
 * unchanged.
 */
export function canMoveStep(operators: StoredOperator[], index: number, dir: -1 | 1): boolean {
  const j = index + dir;
  if (j < 0 || j >= operators.length) return false;
  return !isLogicalManagedOperator(operators[index]) && !isLogicalManagedOperator(operators[j]);
}

type PreviewIssue =
  | { code: 'duplicate-final-name'; name: string; count: number }
  | { code: 'rename-collision-resolved'; name: string }
  | {
      code: 'orphaned-reference';
      kind: 'chain-backend' | 'proxy-group-member' | 'rule-policy';
      node: string;
      via: string;
    };

interface PreviewData {
  before: { count: number; names: string[]; truncated: boolean };
  after: { count: number; names: string[]; truncated: boolean };
  steps: OperatorStep[];
  memberErrors?: { name: string; error: string }[];
  issues?: PreviewIssue[];
}

/** The loaded entity shape the workbench reads (subscription or collection). */
export interface WorkbenchEntity {
  name?: string;
  display_name?: string;
  operators?: StoredOperator[];
  updated_at?: number;
}

export interface WorkbenchConfig {
  entityId: string;
  loadPath: string; // `/api/v1/subscriptions/${id}` | `/api/v1/collections/${id}`
  previewPath: string; // `${loadPath}/preview`
  savePath: string; // same as loadPath (PATCH)
  backHref: string; // '/subscriptions'
  crumbPrefix: string; // '订阅源' | '订阅源 / 聚合订阅'
  introNoun: string; // '订阅源' | '聚合订阅'
  /** True for collection pages — shapes rename-template defaults (source alias). */
  aggregate: boolean;
  // sub: data.display_name || data.name ; collection: data.name
  pickLabel: (data: WorkbenchEntity) => string;
  /** Test seam: render from a fixed entity payload without the fetch. */
  initialEntity?: WorkbenchEntity;
}

export function OperatorWorkbench(cfg: WorkbenchConfig) {
  const router = useRouter();

  // Test seam (static markup): an initialEntity payload seeds every state
  // lazily so renderToStaticMarkup sees the real pipeline without effects.
  const [label, setLabel] = useState<string | null>(() =>
    cfg.initialEntity ? cfg.pickLabel(cfg.initialEntity) : null,
  );
  const [operators, setOperators] = useState<StoredOperator[]>(() => {
    const seeded = cfg.initialEntity?.operators ?? [];
    return seeded.length > 0 ? (seeded as StoredOperator[]) : [];
  });
  const [savedKey, setSavedKey] = useState(() =>
    JSON.stringify(cfg.initialEntity?.operators ?? []),
  );
  const [loaded, setLoaded] = useState(() => cfg.initialEntity !== undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // P2-2 If-Match: the entity's last-known updated_at, refreshed from every
  // successful load/save — a concurrent editor's write then 412s instead of
  // being silently overwritten.
  const [entityVersion, setEntityVersion] = useState<number | undefined>(
    () => cfg.initialEntity?.updated_at,
  );
  const [area, setArea] = useState<WorkArea>('naming');
  const listRef = useRef<HTMLDivElement | null>(null);
  const entityType: 'subscription' | 'collection' = cfg.aggregate ? 'collection' : 'subscription';

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const reqId = useRef(0);

  const operatorsKey = useMemo(() => JSON.stringify(operators), [operators]);
  const dirty = operatorsKey !== savedKey;
  const incompleteCount = operators.filter((op) => !isParkedOperator(op) && !isComplete(op)).length;

  /* load */
  useEffect(() => {
    if (cfg.initialEntity) return; // seeded lazily above — no fetch
    (async () => {
      try {
        const res = await api<{ data: WorkbenchEntity }>(cfg.loadPath);
        const ops = res.data.operators ?? [];
        setLabel(cfg.pickLabel(res.data));
        setOperators(ops);
        setSavedKey(JSON.stringify(ops));
        setEntityVersion(res.data.updated_at);
      } catch (err) {
        setLoadError(err instanceof ApiError ? err.message : String(err));
      } finally {
        setLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.loadPath]);

  /* preview — only complete operators are sendable; disabled ones still go
     so the engine reports an applied:false step aligned by id. */
  const runPreview = useCallback(
    async (ops: StoredOperator[]) => {
      const payload = ops.filter(isComplete) as Operator[];
      const my = ++reqId.current;
      setPreviewing(true);
      setPreviewError(null);
      try {
        const res = await api<{ data: PreviewData }>(cfg.previewPath, {
          method: 'POST',
          body: { operators: payload },
        });
        if (my === reqId.current) setPreview(res.data);
      } catch (err) {
        if (my === reqId.current) {
          setPreviewError(
            err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err),
          );
        }
      } finally {
        if (my === reqId.current) setPreviewing(false);
      }
    },
    [cfg.previewPath],
  );

  /* debounced auto-preview; resuming edits clears any prior save error */
  useEffect(() => {
    if (!loaded || loadError) return;
    setSaveError(null);
    const t = setTimeout(() => runPreview(JSON.parse(operatorsKey) as Operator[]), 450);
    return () => clearTimeout(t);
  }, [operatorsKey, loaded, loadError, runPreview]);

  /* warn on unsaved navigation */
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  /* mutations — ordinary operators only, 64-step cap (client mirror of the
     server list schema; the server remains the authoritative gate). The
     managed rename-template row is never generically addable. */
  const atStepLimit = operators.length >= 64;
  const addOp = (kind: OperatorKind) => {
    if (atStepLimit) return;
    const op = makeOperator(kind, cfg.aggregate);
    setOperators((prev) => [...prev, op]);
    setExpandedId(op.id);
    setAddOpen(false);
  };

  /* save guards mirroring the server list contract (parked history is never
     silently dropped or saved; over-limit history gets an actionable message) */
  // Authoritative gate: the STRIPPED candidate must satisfy the shared list
  // contract (64 cap, rename-template uniqueness, unique ids) — per-item
  // checks alone cannot catch a stored duplicate rename-template. The status
  // message is the VISIBLE role=status text; at-limit (exactly 64 valid steps)
  // is informational — it blocks Add, never Save.
  const status = useMemo(() => pipelineStatusMessage(operators), [operators]);
  const saveBlockReason = useMemo(() => saveBlockedBy(operators), [operators]);

  /* derived pipeline facts (criterion 7): does a filter-regex match raw names
     or already-renamed names, depending on its position? */
  const renamedAt = useMemo(() => matchesRenamedAt(operators), [operators]);

  /* flag redundancy warning (criterion 7): rename-template with flag + flag-emoji add */
  const flagRedundant = useMemo(() => hasFlagRedundancy(operators), [operators]);
  const renamedAfter = useMemo(() => renamedAfterManaged(operators), [operators]);

  /* tab click = scroll to the area's first step; the full pipeline stays visible */
  const selectArea = (next: WorkArea) => {
    setArea(next);
    setAddOpen(false);
    const index = operators.findIndex((op) => AREA_OF_KIND[op.kind] === next);
    if (index === -1 || !listRef.current) return;
    listRef.current
      .querySelector(`[data-step-index="${index}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const updateOp = (i: number, next: StoredOperator) =>
    setOperators((prev) => prev.map((o, idx) => (idx === i ? next : o)));
  const removeOp = (i: number) => setOperators((prev) => prev.filter((_, idx) => idx !== i));
  const toggleOp = (i: number) =>
    setOperators((prev) =>
      prev.map((o, idx) =>
        idx === i && !isParkedOperator(o) ? ({ ...o, disabled: !o.disabled } as StoredOperator) : o,
      ),
    );
  const moveOp = (i: number, dir: -1 | 1) =>
    setOperators((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  async function save() {
    if (incompleteCount > 0) return;
    if (saveBlockReason) {
      setSaveError(`${saveBlockReason} 未保存任何更改。`);
      return;
    }
    // The candidate the API would actually receive — diagnostics stripped,
    // parked placeholders excluded (already blocked above).
    const saveBody = buildSaveCandidate(operators);
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api<{ data: WorkbenchEntity }>(cfg.savePath, {
        method: 'PATCH',
        body: { operators: saveBody },
        headers: entityVersion !== undefined ? { 'If-Match': `"${entityVersion}"` } : undefined,
      });
      const nextLabel = cfg.pickLabel(res.data);
      if (nextLabel) setLabel(nextLabel);
      setSavedKey(JSON.stringify(operators));
      setEntityVersion(res.data.updated_at);
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        // Stale editor: the record or the rendered config moved underneath us.
        // Surface clearly and KEEP the unsaved edits — never silently replace
        // the user's work or claim the save landed.
        setSaveError(
          '保存被并发修改拦截（412）：该订阅或相关配置已被其他人修改，请刷新页面加载最新状态后再保存。当前编辑内容已保留。',
        );
      } else {
        setSaveError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  function leave() {
    if (dirty && !confirm('有未保存的改动，确定离开？')) return;
    router.push(cfg.backHref);
  }

  const stepById = useMemo(() => {
    const m = new Map<string, OperatorStep>();
    for (const s of preview?.steps ?? []) m.set(s.id, s);
    return m;
  }, [preview]);

  return (
    <div>
      <PageTopbar>
        <h1>节点处理</h1>
        <span className="crumb">
          <a
            className={styles.crumbLink}
            href={cfg.backHref}
            onClick={(e) => {
              e.preventDefault();
              leave();
            }}
          >
            {cfg.crumbPrefix}
          </a>{' '}
          / {label ?? '…'}
        </span>
        {dirty ? (
          <span className={styles.saveMark}>
            <span className={styles.saveDot} />
            未保存
          </span>
        ) : (
          loaded &&
          !loadError && <span className={`${styles.saveMark} ${styles.clean}`}>已是最新</span>
        )}
        <div className="grow" />
        <button
          type="button"
          className="btn"
          onClick={() => runPreview(operators)}
          disabled={previewing}
        >
          {previewing ? '预览中…' : '预览结果'}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={save}
          disabled={saving || !dirty || incompleteCount > 0 || !!saveBlockReason}
          title={
            saveBlockReason ??
            (incompleteCount > 0 ? `有 ${incompleteCount} 个步骤未填写完整` : undefined)
          }
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </PageTopbar>

      <div className={styles.intro}>
        <p>
          拉取 <code className="mono">{label ?? `该${cfg.introNoun}`}</code>{' '}
          的节点后，按顺序逐个应用处理步骤，再并入最终配置。步骤只在渲染时执行，不会改动上游内容。
        </p>
      </div>

      {loadError && <div className={styles.loadErr}>{loadError}</div>}
      {saveError && (
        <div className={styles.saveErr} role="alert">
          {saveError}
        </div>
      )}

      <div className={styles.workbenchGrid}>
        {/* ── left: pipeline ── */}
        <section className={styles.pipelinePane} aria-labelledby="pipeline-heading">
          <header className={styles.pipelineHeader}>
            <div>
              <span className={styles.sectionLabel}>处理流程</span>
              <div className={styles.pipelineHeadingRow}>
                <h2 id="pipeline-heading">
                  {operators.length === 0 ? '建立处理流程' : `已配置 ${operators.length} 个步骤`}
                </h2>
                <span>从上到下依次执行</span>
              </div>
            </div>
            <div className={styles.areaTabs} role="group" aria-label="工作区">
              {(['naming', 'other'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  aria-pressed={area === a}
                  className={`${styles.areaTab}${area === a ? ` ${styles.active}` : ''}`}
                  onClick={() => selectArea(a)}
                >
                  {AREA_META[a].title}
                </button>
              ))}
            </div>
            <span className={styles.stepCount}>{operators.length} 步</span>
          </header>

          <div className={styles.pipelineBody}>
            {status && (
              <p className={styles.saveState} role="status">
                {status.message}
              </p>
            )}
            {renamedAfter.length > 0 && (
              <div className={styles.flagWarn} role="status">
                <span aria-hidden="true">⚠</span>
                <span>
                  「名称统一」是最终改名阶段：它之后的第 {renamedAfter.map((i) => i + 1).join('、')}{' '}
                  个步骤（正则重命名 / 国旗 Emoji）会二次改名，保存会被拒绝 ——
                  请把它们移到「名称统一」之前。
                </span>
              </div>
            )}
            {flagRedundant && (
              <div className={styles.flagWarn} role="status">
                <span aria-hidden="true">⚠</span>
                <span>
                  「模板命名」已包含国旗成分，同时保留「国旗 Emoji（添加）」步骤会重复加旗。
                  两者都会按原顺序执行，不会自动删除 —— 建议关掉其中一个。
                </span>
              </div>
            )}
            {operators.length === 0 ? (
              <div className={styles.empty}>
                <div className={styles.emptyTrack} aria-hidden="true">
                  <span className={styles.emptyNode}>＋</span>
                  <span className={styles.emptyLine} />
                </div>
                <div className={styles.emptyContent}>
                  <h3>从第一个处理步骤开始</h3>
                  <p>
                    添加过滤、重命名、排序等步骤。每一步都会使用上一阶段的结果，右侧预览会同步更新。
                    所有步骤（名称统一 + 其他处理）按同一个顺序执行。
                  </p>
                  <AddOperatorControl
                    open={addOpen}
                    primary
                    onToggle={() => setAddOpen((v) => !v)}
                    onClose={() => setAddOpen(false)}
                    onAdd={addOp}
                    atStepLimit={atStepLimit}
                  />
                </div>
              </div>
            ) : (
              <>
                <div className={styles.pipelineList} ref={listRef}>
                  {operators.map((op, i) => (
                    <div key={`${i}-${op.id}`} data-step-index={i}>
                      <OperatorCard
                        op={op}
                        index={i}
                        total={operators.length}
                        step={stepById.get(op.id)}
                        complete={isComplete(op)}
                        expanded={expandedId === op.id}
                        highlighted={AREA_OF_KIND[op.kind] === area}
                        matchesRenamed={renamedAt[i]}
                        entityType={entityType}
                        entityId={cfg.entityId}
                        onToggleExpand={() =>
                          setExpandedId((cur) => (cur === op.id ? null : op.id))
                        }
                        onChange={(next) => updateOp(i, next)}
                        onToggle={() => toggleOp(i)}
                        onRemove={() => removeOp(i)}
                        canMoveUp={canMoveStep(operators, i, -1)}
                        canMoveDown={canMoveStep(operators, i, 1)}
                        onMoveUp={() => moveOp(i, -1)}
                        onMoveDown={() => moveOp(i, 1)}
                      />
                    </div>
                  ))}
                </div>
                <AddOperatorControl
                  open={addOpen}
                  tail
                  onToggle={() => setAddOpen((v) => !v)}
                  onClose={() => setAddOpen(false)}
                  onAdd={addOp}
                  atStepLimit={atStepLimit}
                />
              </>
            )}
          </div>
        </section>

        {/* ── right: preview ── */}
        <PreviewPane
          preview={preview}
          previewing={previewing}
          error={previewError}
          loaded={loaded && !loadError}
        />
      </div>
    </div>
  );
}

function AddOperatorControl({
  open,
  primary = false,
  tail = false,
  onToggle,
  onClose,
  onAdd,
  atStepLimit,
}: {
  open: boolean;
  primary?: boolean;
  tail?: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAdd: (kind: OperatorKind) => void;
  atStepLimit: boolean;
}) {
  return (
    <div
      className={`${styles.addWrap} ${primary ? styles.addEmpty : ''} ${tail ? styles.addTail : ''}`}
    >
      <button
        type="button"
        className={primary ? styles.addPrimary : styles.addSecondary}
        aria-expanded={open}
        aria-controls="operator-kind-options"
        onClick={onToggle}
      >
        <span aria-hidden="true">＋</span>
        {primary ? '添加第一个步骤' : '继续添加步骤'}
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="关闭添加步骤菜单"
            tabIndex={-1}
            className={styles.addScrim}
            onClick={onClose}
          />
          <div id="operator-kind-options" className={styles.addMenu} aria-label="选择处理步骤">
            {(['naming', 'other'] as const).map((areaKey) => (
              <div key={areaKey} role="group" aria-label={AREA_META[areaKey].title}>
                <div className={styles.addGroupLabel}>
                  {AREA_META[areaKey].title}
                  <span className={styles.addGroupHint}>
                    {areaKey === 'naming' ? '只改名称' : '增删 / 排序 / 属性'}
                  </span>
                </div>
                {ADDABLE_KINDS[areaKey].map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={styles.addItem}
                    disabled={atStepLimit}
                    title={atStepLimit ? '已达 64 个步骤上限' : undefined}
                    onClick={() => onAdd(kind)}
                  >
                    <span className={styles.addItemTitle}>{KIND_META[kind].title}</span>
                    <span className={styles.addItemDescription}>{KIND_META[kind].desc}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ─── operator card ────────────────────────────────────────────────── */

function OperatorCard({
  op,
  index,
  total,
  step,
  complete,
  expanded,
  highlighted,
  matchesRenamed,
  entityType,
  entityId,
  onToggleExpand,
  onChange,
  onToggle,
  onRemove,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  op: StoredOperator;
  index: number;
  total: number;
  step?: OperatorStep;
  complete: boolean;
  expanded: boolean;
  /** Selected work area — subtle emphasis only; the card is always visible. */
  highlighted: boolean;
  /** filter-regex only: true when an enabled rename step precedes it. */
  matchesRenamed: boolean;
  entityType: 'subscription' | 'collection';
  entityId: string;
  /** Anchor-boundary-aware move availability (round-7 HIGH-2): false when
   * the move would cross the immutable managed rename-template row. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggleExpand: () => void;
  onChange: (next: StoredOperator) => void;
  onToggle: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const disabled = !!op.disabled;
  const parked = isParkedOperator(op);
  // the logical-managed rename-template row is IMMUTABLE here: the generic
  // workbench renders a summary + 智能命名 link only — create/edit/toggle/
  // delete/move are the naming workspace's authority (the server gate
  // rejects any generic managed mutation regardless).
  const managed = isCurrentRenameTemplateOperator(op);
  // A non-managed rename-template row with an own compatibility_issue is a
  // historical template — visible but offers only movement and deletion.
  // hasOwnCompatibilityIssue implies NOT managed (managed rows lack it).
  const historicalRename = !parked && op.kind === 'rename-template' && hasOwnCompatibilityIssue(op);
  const historicalIssue: string | undefined =
    historicalRename && typeof (op as Record<string, unknown>).compatibility_issue === 'string'
      ? ((op as Record<string, unknown>).compatibility_issue as string)
      : undefined;
  const idxClass = parked ? styles.off : !complete ? styles.bad : disabled ? styles.off : '';
  const cardClass = [
    styles.card,
    !complete ? styles.bad : expanded ? styles.open : '',
    disabled ? styles.disabled : '',
    highlighted ? styles.areaFocus : '',
  ]
    .filter(Boolean)
    .join(' ');
  const areaKey = AREA_OF_KIND[op.kind];

  return (
    <div className={styles.step}>
      <div className={styles.rail}>
        <div className={`${styles.idx} ${idxClass}`}>{index + 1}</div>
        {index < total - 1 && <div className={styles.line} />}
      </div>

      <div className={cardClass}>
        <div className={styles.head}>
          {/* Movement: available for non-managed rows; managed row has no generic movement */}
          {!managed && (
            <div className={styles.stepper}>
              <button
                type="button"
                onClick={onMoveUp}
                disabled={!canMoveUp}
                title="上移"
                aria-label="上移"
              >
                ⌃
              </button>
              <button
                type="button"
                onClick={onMoveDown}
                disabled={!canMoveDown}
                title="下移"
                aria-label="下移"
              >
                ⌄
              </button>
            </div>
          )}

          {/* Title: button for ordinary expandable rows; non-interactive span for managed/historical/parked rows */}
          {parked || historicalRename || managed ? (
            <span className={styles.titleBtn}>
              <b>{KIND_META[op.kind].title}</b>
              <span
                className={`${styles.areaChip} ${areaKey === 'naming' ? styles.areaNaming : ''}`}
                title={AREA_META[areaKey].desc}
              >
                {AREA_META[areaKey].title}
              </span>
              {parked && <span className="pill idle plain">无法解码</span>}
              {!complete && <span className="pill warn plain">待填写</span>}
              {disabled && <span className="pill idle plain">已停用</span>}
              <span className={styles.summary}>{summarize(op)}</span>
            </span>
          ) : (
            <button
              type="button"
              className={styles.titleBtn}
              onClick={onToggleExpand}
              aria-expanded={expanded}
            >
              <b>{KIND_META[op.kind].title}</b>
              <span
                className={`${styles.areaChip} ${areaKey === 'naming' ? styles.areaNaming : ''}`}
                title={AREA_META[areaKey].desc}
              >
                {AREA_META[areaKey].title}
              </span>
              {!complete && <span className="pill warn plain">待填写</span>}
              {disabled && <span className="pill idle plain">已停用</span>}
              <span className={styles.summary}>{summarize(op)}</span>
            </button>
          )}

          {op.kind === 'filter-regex' && (
            <span
              className={`${styles.renamePos} ${matchesRenamed ? styles.renamePosAfter : ''}`}
              title={
                matchesRenamed
                  ? '前面已有启用中的重命名步骤 —— 本步骤匹配的是重命名后的名称'
                  : '前面没有重命名步骤 —— 本步骤匹配原始名称'
              }
            >
              {matchesRenamed ? '匹配重命名后' : '匹配原始名'}
            </span>
          )}

          <TraceChip step={step} disabled={disabled} />

          <div className={styles.tools}>
            {/* Toggle: only for ordinary non-managed, non-historical, non-parked rows */}
            {!managed && !historicalRename && !parked && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onToggle}
                title={disabled ? '启用' : '停用'}
                aria-label={disabled ? '启用' : '停用'}
              >
                {disabled ? '▶' : '⏸'}
              </button>
            )}
            {/* Delete: available for non-managed rows (historical and ordinary); parked also deletable */}
            {!managed && (
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.danger}`}
                onClick={onRemove}
                title="删除"
                aria-label="删除"
              >
                ✕
              </button>
            )}
            {/* Expand: only for ordinary non-managed, non-historical, non-parked rows */}
            {!managed && !historicalRename && !parked && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={onToggleExpand}
                aria-label={expanded ? '收起' : '展开'}
              >
                <span aria-hidden className={`${styles.chev} ${expanded ? styles.on : ''}`}>
                  ▸
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Historical template recovery messages (round-9) */}
        {historicalRename && historicalIssue === STORED_OPERATOR_COMPATIBILITY_ISSUE && (
          <div className={styles.editor}>
            <p className={styles.note}>
              历史模板不符合当前规则，已停用且不会执行。请删除此行；如需普通处理步骤，可删除后重新添加并保存；如需统一命名，请保存后前往智能命名重新建立方案。
            </p>
          </div>
        )}
        {historicalRename && historicalIssue === STORED_OPERATOR_DUPLICATE_ISSUE && (
          <div className={styles.editor}>
            <p className={styles.note}>
              这是重复的历史名称统一步骤，已停用且不会执行。请删除此行并保存；有效命名方案只能在唯一的托管步骤中修改。
            </p>
          </div>
        )}

        {/* Managed row or expanded ordinary row gets the editor */}
        {(managed || (!parked && !historicalRename && expanded)) && (
          <div className={styles.editor}>
            <OperatorEditor
              op={op}
              onChange={onChange}
              entityType={entityType}
              entityId={entityId}
              managed={managed}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function TraceChip({ step, disabled }: { step?: OperatorStep; disabled: boolean }) {
  if (disabled || !step || !step.applied) return <span className={styles.trace} />;
  if (step.dropped > 0) {
    return <span className={`${styles.trace} ${styles.drop}`}>−{step.dropped}</span>;
  }
  if (step.changed > 0) {
    return <span className={`${styles.trace} ${styles.change}`}>✎{step.changed}</span>;
  }
  return <span className={styles.trace}>—</span>;
}

/* ─── operator editors ─────────────────────────────────────────────── */

function OperatorEditor({
  op,
  onChange,
  entityType,
  entityId,
  managed = false,
}: {
  op: StoredOperator;
  onChange: (next: StoredOperator) => void;
  entityType: 'subscription' | 'collection';
  entityId: string;
  /** Immutable managed rename-template row — summary + 智能命名 link only. */
  managed?: boolean;
}) {
  if (isParkedOperator(op)) {
    return (
      <div className={styles.fieldRow}>
        <p className={styles.note} role="note">
          这个步骤的历史数据无法解码（诊断码：{op.compatibility_issue}），已停用且不会执行；
          删除后其余步骤会保持原有顺序。
        </p>
      </div>
    );
  }
  switch (op.kind) {
    case 'filter-regex':
      return (
        <div className={styles.fieldRow}>
          <EditorField label="模式">
            <Segmented
              value={op.mode}
              onChange={(v) => onChange({ ...op, mode: v as 'keep' | 'drop' })}
              options={[
                { value: 'keep', label: '保留匹配' },
                { value: 'drop', label: '排除匹配' },
              ]}
            />
          </EditorField>
          <EditorField label="正则表达式">
            <input
              className="input mono"
              value={op.pattern}
              onChange={(e) => onChange({ ...op, pattern: e.target.value })}
              placeholder="香港|HK|🇭🇰"
            />
          </EditorField>
          <FlagToggle flags={op.flags} onChange={(f) => onChange({ ...op, flags: f })} />
        </div>
      );

    case 'filter-useless':
      return (
        <div className={styles.fieldRow}>
          <p className={styles.note}>
            自动丢弃含「剩余流量 / 到期 / 重置 / 官网 / 续费 / 客服 / 群组 /
            网址」等关键词的信息节点。
          </p>
          <EditorField label="额外关键词（逗号分隔）">
            <input
              className="input mono"
              value={op.extra.join(', ')}
              onChange={(e) =>
                onChange({
                  ...op,
                  extra: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="可选，如 测试, 体验"
            />
          </EditorField>
        </div>
      );

    case 'rename-regex':
      return (
        <div className={styles.fieldRow}>
          <div className={styles.twoCol}>
            <EditorField label="匹配正则">
              <input
                className="input mono"
                value={op.pattern}
                onChange={(e) => onChange({ ...op, pattern: e.target.value })}
                placeholder="\[.*?\]"
              />
            </EditorField>
            <EditorField label="替换为（留空 = 删除）">
              <input
                className="input mono"
                value={op.replacement}
                onChange={(e) => onChange({ ...op, replacement: e.target.value })}
                placeholder=""
              />
            </EditorField>
          </div>
          <FlagToggle flags={op.flags} onChange={(f) => onChange({ ...op, flags: f })} />
        </div>
      );

    case 'flag-emoji':
      return (
        <div className={styles.fieldRow}>
          <EditorField label="操作">
            <Segmented
              value={op.action}
              onChange={(v) => onChange({ ...op, action: v as 'add' | 'remove' })}
              options={[
                { value: 'add', label: '添加国旗' },
                { value: 'remove', label: '移除国旗' },
              ]}
            />
          </EditorField>
          {op.action === 'add' && (
            <EditorField label="台湾节点旗帜">
              <Segmented
                value={op.tw2cn ? 'cn' : 'tw'}
                onChange={(v) => onChange({ ...op, tw2cn: v === 'cn' })}
                options={[
                  { value: 'tw', label: '🇹🇼 台湾旗' },
                  { value: 'cn', label: '🇨🇳 中国旗' },
                ]}
              />
            </EditorField>
          )}
        </div>
      );

    case 'filter-type':
      return (
        <div className={styles.fieldRow}>
          <EditorField label="模式">
            <Segmented
              value={op.mode}
              onChange={(v) => onChange({ ...op, mode: v as 'keep' | 'drop' })}
              options={[
                { value: 'keep', label: '保留所选' },
                { value: 'drop', label: '排除所选' },
              ]}
            />
          </EditorField>
          <EditorField label="协议类型">
            <div className={styles.chips}>
              {PROXY_TYPES.map((t) => (
                <ToggleChip
                  key={t}
                  active={op.types.includes(t)}
                  onClick={() =>
                    onChange({
                      ...op,
                      types: op.types.includes(t)
                        ? op.types.filter((x) => x !== t)
                        : [...op.types, t],
                    })
                  }
                >
                  {t}
                </ToggleChip>
              ))}
            </div>
          </EditorField>
        </div>
      );

    case 'sort':
      return (
        <div className={styles.twoCol}>
          <EditorField label="排序依据">
            <Segmented
              value={op.by}
              onChange={(v) => onChange({ ...op, by: v as 'name' | 'type' | 'server' | 'region' })}
              options={[
                { value: 'name', label: '名称' },
                { value: 'region', label: '地区' },
                { value: 'type', label: '类型' },
                { value: 'server', label: '服务器' },
              ]}
            />
          </EditorField>
          <EditorField label="顺序">
            <Segmented
              value={op.order}
              onChange={(v) => onChange({ ...op, order: v as 'asc' | 'desc' })}
              options={[
                { value: 'asc', label: '升序 ↑' },
                { value: 'desc', label: '降序 ↓' },
              ]}
            />
          </EditorField>
        </div>
      );

    case 'set-prop':
      return (
        <div className={styles.fieldRow}>
          <TriRow label="UDP" value={op.udp} onChange={(v) => onChange({ ...op, udp: v })} />
          <TriRow
            label="TCP Fast Open"
            value={op.tfo}
            onChange={(v) => onChange({ ...op, tfo: v })}
          />
          <TriRow
            label="跳过证书校验"
            value={op.skipCertVerify}
            onChange={(v) => onChange({ ...op, skipCertVerify: v })}
          />
        </div>
      );

    case 'dedup':
      return (
        <div className={styles.twoCol}>
          <EditorField label="判定依据">
            <Segmented
              value={op.by}
              onChange={(v) => onChange({ ...op, by: v as 'name' | 'server-port' })}
              options={[
                { value: 'name', label: '名称' },
                { value: 'server-port', label: 'server:port' },
              ]}
            />
          </EditorField>
          <EditorField label="对重复项">
            <Segmented
              value={op.action}
              onChange={(v) => onChange({ ...op, action: v as 'drop' | 'rename' })}
              options={[
                { value: 'drop', label: '丢弃' },
                { value: 'rename', label: '加序号' },
              ]}
            />
          </EditorField>
        </div>
      );

    case 'filter-region':
      return (
        <div className={styles.fieldRow}>
          <EditorField label="模式">
            <Segmented
              value={op.mode}
              onChange={(v) => onChange({ ...op, mode: v as 'keep' | 'drop' })}
              options={[
                { value: 'keep', label: '保留所选' },
                { value: 'drop', label: '排除所选' },
              ]}
            />
          </EditorField>
          <EditorField label="地区">
            <div className={styles.chips}>
              {REGIONS.map((r) => (
                <ToggleChip
                  key={r.code}
                  active={op.regions.includes(r.code)}
                  onClick={() =>
                    onChange({
                      ...op,
                      regions: op.regions.includes(r.code)
                        ? op.regions.filter((x) => x !== r.code)
                        : [...op.regions, r.code],
                    })
                  }
                >
                  <span style={{ marginRight: 4 }}>{r.emoji}</span>
                  {r.zh}
                </ToggleChip>
              ))}
            </div>
          </EditorField>
        </div>
      );

    case 'rename-template':
      // Only the real managed row reaches this branch — callers guard upstream.
      if (!managed) return null;
      return (
        <RenameTemplateEditor
          op={op as RenameTemplateOp}
          entityType={entityType}
          entityId={entityId}
        />
      );
  }
}

/** Caption + control stack. A div (not a label) so it can safely wrap button groups. */
function EditorField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className={styles.cap}>{label}</span>
      {children}
    </div>
  );
}

/** Segmented single-select — uses the shared .seg / .opt vocabulary. */
function Segmented({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`opt${o.value === value ? ' on' : ''}`}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Case-insensitive (`i`) flag toggle for regex operators; preserves other flags. */
function FlagToggle({ flags, onChange }: { flags?: string; onChange: (f: string) => void }) {
  const ci = (flags ?? '').includes('i');
  const toggle = () => {
    const set = new Set((flags ?? '').split('').filter(Boolean));
    if (ci) set.delete('i');
    else set.add('i');
    onChange([...set].join(''));
  };
  return (
    <label className={styles.ci}>
      <input type="checkbox" checked={ci} onChange={toggle} />
      <span>
        忽略大小写 <span className={styles.flag}>(i)</span>
      </span>
    </label>
  );
}

/** Multi-select toggle — uses the shared .chip vocabulary. */
function ToggleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`chip${active ? ' on' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Tri-state row: 不变 / 开 / 关 mapping to undefined / true / false. */
function TriRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | undefined;
  onChange: (v: boolean | undefined) => void;
}) {
  const cur = value === undefined ? 'keep' : value ? 'on' : 'off';
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{label}</span>
      <Segmented
        value={cur}
        onChange={(v) => onChange(v === 'keep' ? undefined : v === 'on')}
        options={[
          { value: 'keep', label: '不变' },
          { value: 'on', label: '开' },
          { value: 'off', label: '关' },
        ]}
      />
    </div>
  );
}

/* ─── preview pane ─────────────────────────────────────────────────── */

const ISSUE_KIND_LABELS: Record<PreviewIssue['code'], string> = {
  'duplicate-final-name': '最终名称重复',
  'rename-collision-resolved': '模板命名已自动消重',
  'orphaned-reference': '引用将悬空',
};

function PreviewPane({
  preview,
  previewing,
  error,
  loaded,
}: {
  preview: PreviewData | null;
  previewing: boolean;
  error: string | null;
  loaded: boolean;
}) {
  const [side, setSide] = useState<'after' | 'before'>('after');
  const list = preview ? preview[side] : null;
  const delta = preview ? preview.after.count - preview.before.count : 0;
  const memberErrors = preview?.memberErrors ?? [];
  const issues = preview?.issues ?? [];

  return (
    <aside className={styles.previewPane} aria-labelledby="preview-heading">
      <header className={styles.previewHeader}>
        <div>
          <span className={styles.sectionLabel}>实时结果</span>
          <h2 id="preview-heading">处理预览</h2>
        </div>
        {previewing && <span className={styles.previewing}>运行中…</span>}
        <div className={styles.previewTabs}>
          <button
            type="button"
            className={`${styles.previewTab} ${side === 'after' ? styles.active : ''}`}
            aria-pressed={side === 'after'}
            onClick={() => setSide('after')}
          >
            处理后
          </button>
          <button
            type="button"
            className={`${styles.previewTab} ${side === 'before' ? styles.active : ''}`}
            aria-pressed={side === 'before'}
            onClick={() => setSide('before')}
          >
            处理前
          </button>
        </div>
      </header>

      <div className={styles.previewBody}>
        {preview && (
          <div className={styles.delta}>
            <span className={styles.deltaFrom}>{preview.before.count}</span>
            <span className={styles.deltaArrow}>→</span>
            <span className={styles.deltaTo}>{preview.after.count}</span>
            <span className={styles.deltaUnit}>节点</span>
            {delta !== 0 && (
              <span className={delta < 0 ? styles.minus : styles.plus}>
                {delta > 0 ? `+${delta}` : delta}
              </span>
            )}
          </div>
        )}

        {issues.length > 0 && (
          <div className={styles.issueList}>
            {issues.map((issue, i) => (
              <div
                key={`${issue.code}-${i}`}
                className={`${styles.issueRow} ${issue.code === 'orphaned-reference' ? styles.issueDanger : ''}`}
              >
                <span className={styles.issueTag}>{ISSUE_KIND_LABELS[issue.code]}</span>
                {issue.code === 'duplicate-final-name' && (
                  <span className={styles.issueText}>
                    「{issue.name}」出现 {issue.count} 次 —— mihomo 要求节点名唯一
                  </span>
                )}
                {issue.code === 'rename-collision-resolved' && (
                  <span className={styles.issueText}>「{issue.name}」已自动追加序号消重</span>
                )}
                {issue.code === 'orphaned-reference' && (
                  <span className={styles.issueText}>
                    「{issue.node}」被{' '}
                    {issue.kind === 'chain-backend'
                      ? '链式代理后端'
                      : issue.kind === 'proxy-group-member'
                        ? '策略组成员'
                        : '规则策略'}{' '}
                    「{issue.via}」引用 —— 改名/删除后引用会悬空
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {preview && preview.steps.length > 0 && (
          <details className={styles.stepTrace}>
            <summary>每步数量变化（{preview.steps.length} 步）</summary>
            <div className={styles.stepTraceList}>
              {preview.steps.map((s, i) => (
                <div key={s.id} className={styles.stepTraceRow}>
                  <span className={styles.stepTraceIndex}>{i + 1}</span>
                  <span className={styles.stepTraceName}>{KIND_META[s.kind].title}</span>
                  {s.applied ? (
                    <span className={styles.stepTraceCounts}>
                      {s.before} → {s.after}
                      {s.dropped > 0 && <span className={styles.traceDrop}>−{s.dropped}</span>}
                      {s.changed > 0 && <span className={styles.traceChange}>✎{s.changed}</span>}
                    </span>
                  ) : (
                    <span className={styles.stepTraceOff}>已停用</span>
                  )}
                  {s.applied && s.samples && s.samples.length > 0 && (
                    <span className={styles.stepTraceSamples}>
                      {s.samples.map((sample, si) => (
                        <span
                          key={si}
                          className={styles.stepTraceSample}
                          title="名称示例（已脱敏）"
                        >
                          {sample.before || '∅'} → {sample.after || '∅'}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </details>
        )}

        {memberErrors.length > 0 && (
          <div className={styles.memberWarn}>
            <div className={styles.memberWarnTitle}>
              {memberErrors.length} 个成员拉取失败，已跳过
            </div>
            <ul>
              {memberErrors.map((m, i) => (
                <li key={`${i}-${m.name}`}>{m.name}</li>
              ))}
            </ul>
          </div>
        )}

        <div style={{ marginTop: preview ? 12 : 0 }}>
          {error ? (
            <div className={styles.previewErr}>{error}</div>
          ) : !loaded || !list ? (
            <p className={styles.previewMuted}>加载中…</p>
          ) : list.names.length === 0 ? (
            <p className={styles.previewMuted} style={{ fontStyle: 'italic' }}>
              无节点
            </p>
          ) : (
            <>
              <div className={styles.nodeList}>
                {list.names.map((name, i) => (
                  <div key={`${i}-${name}`} className={styles.nodeLi}>
                    <span className={styles.nodeIndex}>{i + 1}</span>
                    <span className={styles.nodeName}>{name}</span>
                  </div>
                ))}
              </div>
              {list.truncated && (
                <div className={styles.previewMeta}>
                  … 仅显示前 {list.names.length} 个，共 {list.count} 个
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
