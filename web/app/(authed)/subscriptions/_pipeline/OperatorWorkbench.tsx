'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageTopbar } from '@/components/PageChrome';
import { ApiError, api } from '@/lib/client/api';
import type { OperatorStep } from '@/lib/proxies/operators';
import { REGIONS } from '@/lib/proxies/regions';
import { PROXY_TYPES, type Operator, type OperatorKind } from '@/schemas/operator';
import styles from './pipeline.module.css';

/* ─── meta ─────────────────────────────────────────────────────────── */

const KIND_META: Record<OperatorKind, { title: string; desc: string }> = {
  'filter-regex': { title: '正则过滤', desc: '按名称正则保留或排除节点' },
  'filter-useless': { title: '去除无用节点', desc: '丢弃流量 / 到期 / 官网等信息节点' },
  'rename-regex': { title: '正则重命名', desc: '正则替换节点名（替换为空 = 删除）' },
  'flag-emoji': { title: '国旗 Emoji', desc: '按地区在名称前加上或移除国旗' },
  'filter-type': { title: '类型过滤', desc: '按协议类型保留或排除节点' },
  sort: { title: '排序', desc: '按名称 / 类型 / 服务器 / 地区排序' },
  'set-prop': { title: '设置属性', desc: '强制 UDP / TFO / 跳过证书校验' },
  dedup: { title: '处理重复节点', desc: '按名称或 server:port 去重' },
  'filter-region': { title: '地区过滤', desc: '按识别出的地区保留或排除' },
};

/** Operator menu order = the feature numbering 1–9. */
const KIND_ORDER: OperatorKind[] = [
  'filter-regex',
  'filter-useless',
  'rename-regex',
  'flag-emoji',
  'filter-type',
  'sort',
  'set-prop',
  'dedup',
  'filter-region',
];

function makeOperator(kind: OperatorKind): Operator {
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
  }
}

/** A step is sendable to preview only when its required fields are filled + valid. */
function isComplete(op: Operator): boolean {
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

function summarize(op: Operator): string {
  switch (op.kind) {
    case 'filter-regex':
      return `${op.mode === 'keep' ? '保留' : '排除'} · /${op.pattern || '…'}/${op.flags ?? ''}`;
    case 'filter-useless':
      return op.extra.length ? `内置 + ${op.extra.length} 额外关键词` : '内置规则';
    case 'rename-regex':
      return `/${op.pattern || '…'}/ → ${op.replacement === '' ? '（删除）' : op.replacement}`;
    case 'flag-emoji':
      return op.action === 'add' ? (op.tw2cn ? '添加国旗 · 台湾→🇨🇳' : '添加国旗') : '移除国旗';
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

/* ─── workbench ────────────────────────────────────────────────────── */

interface PreviewData {
  before: { count: number; names: string[]; truncated: boolean };
  after: { count: number; names: string[]; truncated: boolean };
  steps: OperatorStep[];
  memberErrors?: { name: string; error: string }[];
}

/** The loaded entity shape the workbench reads (subscription or collection). */
export interface WorkbenchEntity {
  name?: string;
  display_name?: string;
  operators?: Operator[];
}

export interface WorkbenchConfig {
  entityId: string;
  loadPath: string; // `/api/v1/subscriptions/${id}` | `/api/v1/collections/${id}`
  previewPath: string; // `${loadPath}/preview`
  savePath: string; // same as loadPath (PATCH)
  backHref: string; // '/subscriptions'
  crumbPrefix: string; // '订阅源' | '订阅源 / 聚合订阅'
  introNoun: string; // '订阅源' | '聚合订阅'
  // sub: data.display_name || data.name ; collection: data.name
  pickLabel: (data: WorkbenchEntity) => string;
}

export function OperatorWorkbench(cfg: WorkbenchConfig) {
  const router = useRouter();

  const [label, setLabel] = useState<string | null>(null);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [savedKey, setSavedKey] = useState('[]');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const reqId = useRef(0);

  const operatorsKey = useMemo(() => JSON.stringify(operators), [operators]);
  const dirty = operatorsKey !== savedKey;
  const incompleteCount = operators.filter((op) => !isComplete(op)).length;

  /* load */
  useEffect(() => {
    (async () => {
      try {
        const res = await api<{ data: WorkbenchEntity }>(cfg.loadPath);
        const ops = res.data.operators ?? [];
        setLabel(cfg.pickLabel(res.data));
        setOperators(ops);
        setSavedKey(JSON.stringify(ops));
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
    async (ops: Operator[]) => {
      const payload = ops.filter(isComplete);
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

  /* debounced auto-preview */
  useEffect(() => {
    if (!loaded || loadError) return;
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

  /* mutations */
  const addOp = (kind: OperatorKind) => {
    const op = makeOperator(kind);
    setOperators((prev) => [...prev, op]);
    setExpandedId(op.id);
    setAddOpen(false);
  };
  const updateOp = (i: number, next: Operator) =>
    setOperators((prev) => prev.map((o, idx) => (idx === i ? next : o)));
  const removeOp = (i: number) => setOperators((prev) => prev.filter((_, idx) => idx !== i));
  const toggleOp = (i: number) =>
    setOperators((prev) =>
      prev.map((o, idx) => (idx === i ? ({ ...o, disabled: !o.disabled } as Operator) : o)),
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
    setSaving(true);
    try {
      const res = await api<{ data: WorkbenchEntity }>(cfg.savePath, {
        method: 'PATCH',
        body: { operators },
      });
      const nextLabel = cfg.pickLabel(res.data);
      if (nextLabel) setLabel(nextLabel);
      setSavedKey(JSON.stringify(operators));
    } catch (err) {
      setPreviewError(err instanceof ApiError ? (err.problem.detail ?? err.message) : String(err));
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
            <span className="dot" />
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
          disabled={saving || !dirty || incompleteCount > 0}
          title={incompleteCount > 0 ? `有 ${incompleteCount} 个步骤未填写完整` : undefined}
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

      <div className="md-grid" style={{ gridTemplateColumns: '1fr 320px' }}>
        {/* ── left: pipeline ── */}
        <div>
          {operators.length === 0 ? (
            <div className={styles.empty}>
              <div className="t">还没有处理步骤</div>
              <div className="d">
                点下方「＋ 添加步骤」添加第一个处理步骤，节点会按从上到下的顺序流过。
              </div>
            </div>
          ) : (
            operators.map((op, i) => (
              <OperatorCard
                key={op.id}
                op={op}
                index={i}
                total={operators.length}
                step={stepById.get(op.id)}
                complete={isComplete(op)}
                expanded={expandedId === op.id}
                onToggleExpand={() => setExpandedId((cur) => (cur === op.id ? null : op.id))}
                onChange={(next) => updateOp(i, next)}
                onToggle={() => toggleOp(i)}
                onRemove={() => removeOp(i)}
                onMoveUp={() => moveOp(i, -1)}
                onMoveDown={() => moveOp(i, 1)}
              />
            ))
          )}

          <div className={styles.addWrap}>
            <button type="button" className="btn" onClick={() => setAddOpen((v) => !v)}>
              ＋ 添加步骤
            </button>
            {addOpen && (
              <>
                <button
                  type="button"
                  aria-label="关闭菜单"
                  className={styles.addScrim}
                  onClick={() => setAddOpen(false)}
                />
                <div className={styles.addMenu}>
                  {KIND_ORDER.map((kind, n) => (
                    <button
                      key={kind}
                      type="button"
                      className={styles.addItem}
                      onClick={() => addOp(kind)}
                    >
                      <span className="n">{n + 1}</span>
                      <span>
                        <span className="t">{KIND_META[kind].title}</span>
                        <span className="d">{KIND_META[kind].desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

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

/* ─── operator card ────────────────────────────────────────────────── */

function OperatorCard({
  op,
  index,
  total,
  step,
  complete,
  expanded,
  onToggleExpand,
  onChange,
  onToggle,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  op: Operator;
  index: number;
  total: number;
  step?: OperatorStep;
  complete: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onChange: (next: Operator) => void;
  onToggle: () => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const disabled = !!op.disabled;
  const idxClass = !complete ? styles.bad : disabled ? styles.off : '';
  const cardClass = [
    styles.card,
    !complete ? styles.bad : expanded ? styles.open : '',
    disabled ? styles.disabled : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.step}>
      <div className={styles.rail}>
        <div className={`${styles.idx} ${idxClass}`}>{index + 1}</div>
        {index < total - 1 && <div className={styles.line} />}
      </div>

      <div className={cardClass}>
        <div className={styles.head}>
          <div className={styles.stepper}>
            <button
              type="button"
              onClick={onMoveUp}
              disabled={index === 0}
              title="上移"
              aria-label="上移"
            >
              ⌃
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={index === total - 1}
              title="下移"
              aria-label="下移"
            >
              ⌄
            </button>
          </div>

          <button
            type="button"
            className={styles.titleBtn}
            onClick={onToggleExpand}
            aria-expanded={expanded}
          >
            <b>{KIND_META[op.kind].title}</b>
            {!complete && <span className="pill warn plain">待填写</span>}
            {disabled && <span className="pill idle plain">已停用</span>}
            <span className={styles.summary}>{summarize(op)}</span>
          </button>

          <TraceChip step={step} disabled={disabled} />

          <div className={styles.tools}>
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onToggle}
              title={disabled ? '启用' : '停用'}
              aria-label={disabled ? '启用' : '停用'}
            >
              {disabled ? '▶' : '⏸'}
            </button>
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.danger}`}
              onClick={onRemove}
              title="删除"
              aria-label="删除"
            >
              ✕
            </button>
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
          </div>
        </div>

        {expanded && (
          <div className={styles.editor}>
            <OperatorEditor op={op} onChange={onChange} />
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

function OperatorEditor({ op, onChange }: { op: Operator; onChange: (next: Operator) => void }) {
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`opt${o.value === value ? ' on' : ''}`}
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
    <button type="button" className={`chip${active ? ' on' : ''}`} onClick={onClick}>
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

  return (
    <aside className="panel" style={{ position: 'sticky', top: 74 }}>
      <div className="panel-head">
        <h2>处理预览</h2>
        {previewing && <span className="sub">运行中…</span>}
        <div className="grow" />
        <div className="seg">
          <button
            type="button"
            className={`opt${side === 'after' ? ' on' : ''}`}
            onClick={() => setSide('after')}
          >
            处理后
          </button>
          <button
            type="button"
            className={`opt${side === 'before' ? ' on' : ''}`}
            onClick={() => setSide('before')}
          >
            处理前
          </button>
        </div>
      </div>

      <div className="panel-body" style={{ padding: '14px 16px' }}>
        {preview && (
          <div className={styles.delta}>
            <span className="from">{preview.before.count}</span>
            <span className="arrow">→</span>
            <span className="to">{preview.after.count}</span>
            <span className="unit">节点</span>
            {delta !== 0 && (
              <span className={delta < 0 ? styles.minus : styles.plus}>
                {delta > 0 ? `+${delta}` : delta}
              </span>
            )}
          </div>
        )}

        {memberErrors.length > 0 && (
          <div className={styles.memberWarn}>
            <div className="t">{memberErrors.length} 个成员拉取失败，已跳过</div>
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
                    <span className="n">{i + 1}</span>
                    <span className="name">{name}</span>
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
