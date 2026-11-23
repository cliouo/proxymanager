'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CircleCheck, Inbox, Plus, RotateCcw, TriangleAlert, Workflow } from 'lucide-react';
import { api, ApiError } from '@/ui/data/api';
import { keys, refreshShared } from '@/ui/data/hooks';
import { setQueryData } from '@/ui/data/query';
import type { Operator, OperatorStepTrace, StoredOperator } from '@/ui/data/types';
import { stableKey } from '@/ui/features/sources/model';
import { navigateWithGuard, PIPELINE_LEAVE_CONFIRMATION, registerDirtyCheck } from '@/ui/features/groups/guard';
import { Button, Menu, notify, Tooltip } from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { SaveBar } from '@/ui/shell/page';
import { setUi } from '@/ui/shell/state';
import { Connector, FlowTerminal, StepCard, addStepItems } from './flow';
import {
  appendIndex,
  createStep,
  crossesNaming,
  hasDiagnostic,
  isMovable,
  MAX_STEPS,
  previewCandidate,
  renameAllowedAt,
  saveBlockReason,
  saveCandidate,
  validateSteps,
  type StepKind,
} from './model';
import { PreviewPanel } from './preview-panel';
import { usePipelinePreview, type PipelineTarget } from './use-preview';

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export async function navigateFromPipeline(navigate: () => void) {
  await navigateWithGuard(() => {
    if (typeof window === 'undefined' || !window.matchMedia('(min-width: 1280px)').matches) {
      setUi({ assistantOpen: false });
    }
    navigate();
  });
}

/** Map server validation issues (`path: [index, field]`) back to step ids. */
function issuesByStep(error: unknown, sent: Operator[]): Record<string, string> {
  if (!(error instanceof ApiError) || error.status !== 422) return {};
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = Array.isArray(issue.path) ? issue.path : [];
    const index = typeof path[0] === 'number' ? path[0] : -1;
    const id = sent[index]?.id;
    if (id && !out[id]) out[id] = issue.message;
  }
  return out;
}

interface Snapshot {
  key: string;
  base: StoredOperator[];
  updatedAt: number | undefined;
}

const snapshotKey = (ops: StoredOperator[], updatedAt: number | undefined) =>
  `${updatedAt ?? 0}:${stableKey(ops)}`;

export function PipelineEditor({
  target,
  operators,
  updatedAt,
  namingHref,
  onDirtyChange,
  active = true,
  originHint,
}: {
  target: PipelineTarget;
  /** Saved pipeline as served by the API. */
  operators: StoredOperator[];
  updatedAt: number | undefined;
  namingHref: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** Only the visible tab handles ⌘S. */
  active?: boolean;
  originHint?: string;
}) {
  const router = useRouter();
  const incomingKey = snapshotKey(operators, updatedAt);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    key: incomingKey,
    base: operators,
    updatedAt,
  });
  const [draft, setDraft] = useState<StoredOperator[]>(operators);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);

  const dirty = stableKey(draft) !== stableKey(snapshot.base);
  useEffect(() => registerDirtyCheck(() => dirty, PIPELINE_LEAVE_CONFIRMATION), [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download') || anchor.origin !== window.location.origin) return;
      if (anchor.pathname === window.location.pathname && anchor.search === window.location.search) return;
      event.preventDefault();
      event.stopPropagation();
      void navigateFromPipeline(() => router.push(anchor.pathname + anchor.search + anchor.hash));
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, router]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

  // The saved pipeline changed underneath us (refetch after save, another tab…).
  const incomingIsOlder =
    updatedAt !== undefined && snapshot.updatedAt !== undefined && updatedAt < snapshot.updatedAt;
  if (snapshot.key !== incomingKey && !incomingIsOlder) {
    if (!dirty) {
      setSnapshot({ key: incomingKey, base: operators, updatedAt });
      setDraft(operators);
      setConflict(false);
    } else {
      setSnapshot((current) => ({ ...current, key: incomingKey }));
      if (updatedAt !== snapshot.updatedAt) setConflict(true);
    }
  }

  const errors = useMemo(() => validateSteps(draft), [draft]);
  const candidate = useMemo(() => previewCandidate(draft), [draft]);
  const valid = Object.keys(errors).length === 0;
  const candidateKey = valid ? stableKey(candidate) : null;
  const preview = usePipelinePreview(target, candidateKey);
  const previewErrors = useMemo(
    () => issuesByStep(preview.error, candidate),
    [preview.error, candidate],
  );
  const blockReason = saveBlockReason(draft, errors);

  const traces = useMemo(() => {
    const map = new Map<string, OperatorStepTrace>();
    if (!preview.stale) for (const step of preview.data?.steps ?? []) map.set(step.id, step);
    return map;
  }, [preview.data, preview.stale]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /* ─── edits ───────────────────────────────────────────────────────── */

  const edit = (next: StoredOperator[]) => {
    setDraft(next);
    if (Object.keys(saveErrors).length) setSaveErrors({});
  };

  const update = (id: string, patch: Partial<Record<string, unknown>>) => {
    edit(
      draft.map((op) => {
        if (op.id !== id) return op;
        const next = { ...op, ...patch } as StoredOperator & { compatibility_issue?: string };
        // Once the user touches a step that failed the current checks it becomes a
        // normal (still disabled) step; the server re-validates it on save.
        if (hasDiagnostic(op)) delete next.compatibility_issue;
        return next as StoredOperator;
      }),
    );
  };

  const insertAt = (kind: StepKind, index: number) => {
    if (draft.length >= MAX_STEPS) {
      notify.warn(`最多 ${MAX_STEPS} 个步骤`);
      return;
    }
    const next = draft.slice();
    next.splice(index, 0, createStep(kind) as StoredOperator);
    edit(next);
  };

  const remove = (id: string) => edit(draft.filter((op) => op.id !== id));

  const onDragEnd = ({ active: dragged, over }: DragEndEvent) => {
    setDragging(false);
    if (!over || dragged.id === over.id) return;
    const from = draft.findIndex((op) => op.id === dragged.id);
    const to = draft.findIndex((op) => op.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(draft, from, to);
    if (crossesNaming(draft, next)) {
      notify.info(
        '步骤不能越过「智能命名」',
        '智能命名前后的步骤各自保持在原来那一侧，可以在同一侧内调整顺序。',
      );
      return;
    }
    edit(next);
  };

  /* ─── save ────────────────────────────────────────────────────────── */

  const discard = () => {
    setDraft(snapshot.base);
    setSaveErrors({});
  };

  const reloadLatest = () => {
    setSnapshot({ key: incomingKey, base: operators, updatedAt });
    setDraft(operators);
    setConflict(false);
    setSaveErrors({});
  };

  const save = async () => {
    if (saving) return;
    if (blockReason) {
      notify.warn('暂时无法保存', blockReason);
      return;
    }
    const sent = saveCandidate(draft);
    setSaving(true);
    try {
      const path =
        target.kind === 'subscription'
          ? `/subscriptions/${target.id}`
          : `/collections/${target.id}`;
      const view = await api.patch<{ operators?: StoredOperator[]; updated_at?: number }>(
        path,
        { operators: sent },
        undefined,
        snapshot.updatedAt !== undefined ? { 'If-Match': String(snapshot.updatedAt) } : undefined,
      );
      const next = view?.operators ?? sent;
      // Hand the parent the saved record right away so it never re-renders us with the pre-save copy.
      if (view)
        setQueryData(
          target.kind === 'subscription' ? keys.source(target.id) : keys.pool(target.id),
          view,
        );
      setSnapshot({
        key: snapshotKey(next, view?.updated_at),
        base: next,
        updatedAt: view?.updated_at,
      });
      setDraft(next);
      setConflict(false);
      refreshShared();
      notify.success('处理流程已保存', '客户端下次更新订阅时就会用上新的节点列表。');
    } catch (error) {
      setSaveErrors(issuesByStep(error, sent));
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  useHotkey('mod+s', () => void save(), { enabled: active && dirty });

  /* ─── flow numbers ────────────────────────────────────────────────── */

  const data = preview.data;
  const beforeCount = data ? data.before.count : null;
  const flows: Array<number | null> = [];
  let carry: number | null = beforeCount;
  for (const op of draft) {
    const trace = traces.get(op.id);
    flows.push(trace ? Number(trace.before ?? carry) : carry);
    carry = trace ? Number(trace.after ?? carry) : carry;
  }
  const lastOut = carry;
  const finalCount = data && !preview.stale ? data.after.count : null;
  const mergedAway =
    finalCount !== null && lastOut !== null && lastOut > finalCount ? lastOut - finalCount : 0;
  const max = Math.max(beforeCount ?? 0, ...flows.map((n) => n ?? 0), 1);
  const dim = preview.stale || preview.loading;
  const movableIds = draft.filter(isMovable).map((op) => op.id);
  const atLimit = draft.length >= MAX_STEPS;
  const executable = draft.filter((op) => !op.disabled).length;

  const appendKind = (kind: StepKind) => insertAt(kind, appendIndex(draft, kind));

  return (
    <div>
      <div className="grid gap-6 @3xl/main:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          {conflict && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-ink">
              <TriangleAlert size={16} className="shrink-0 text-warn" />
              <span className="min-w-0 flex-1">
                这个处理流程刚在别处被修改过。保存会被拒绝，载入最新版本会丢弃你未保存的修改。
              </span>
              <Button size="sm" variant="secondary" icon={RotateCcw} onClick={reloadLatest}>
                载入最新版本
              </Button>
            </div>
          )}

          <FlowTerminal
            icon={Inbox}
            title="原始节点"
            hint={originHint}
            count={beforeCount}
            dim={dim && beforeCount !== null}
          />

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[verticalOnly]}
            onDragStart={() => setDragging(true)}
            onDragCancel={() => setDragging(false)}
            onDragEnd={onDragEnd}
          >
            <SortableContext items={movableIds} strategy={verticalListSortingStrategy}>
              <ol className="flex flex-col">
                {draft.map((op, index) => (
                  <StepCard
                    key={op.id}
                    op={op}
                    index={index}
                    trace={traces.get(op.id)}
                    errors={errors[op.id]}
                    serverError={saveErrors[op.id] ?? previewErrors[op.id]}
                    namingHref={namingHref}
                    connector={
                      <Connector
                        count={flows[index]}
                        max={max}
                        dim={dim}
                        quiet={dragging}
                        insert={
                          atLimit
                            ? undefined
                            : addStepItems(
                                (kind) => insertAt(kind, index),
                                renameAllowedAt(draft, index),
                              )
                        }
                      />
                    }
                    onChange={(patch) => update(op.id, patch)}
                    onToggle={(enabled) => update(op.id, { disabled: enabled ? undefined : true })}
                    onRemove={() => remove(op.id)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>

          <Connector
            count={lastOut}
            max={max}
            dim={dim}
            quiet={dragging}
            insert={
              atLimit
                ? undefined
                : addStepItems(
                    (kind) => insertAt(kind, draft.length),
                    renameAllowedAt(draft, draft.length),
                  )
            }
          />
          <FlowTerminal
            icon={draft.length === 0 ? Workflow : CircleCheck}
            tone="end"
            title={finalCount !== null ? `最终 ${finalCount} 个节点` : '最终节点'}
            hint={
              mergedAway > 0
                ? `另有 ${mergedAway} 个配置完全相同的节点被自动合并`
                : draft.length === 0
                  ? '还没有处理步骤，节点原样输出'
                  : `${executable} 个步骤生效`
            }
            count={finalCount}
            dim={dim && finalCount !== null}
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Tooltip content={atLimit ? `最多 ${MAX_STEPS} 个步骤` : undefined}>
              <span>
                <Menu
                  align="start"
                  items={addStepItems(appendKind, true)}
                  trigger={
                    <Button variant="secondary" icon={Plus} disabled={atLimit}>
                      添加步骤
                    </Button>
                  }
                />
              </span>
            </Tooltip>
            <span className="text-xs text-ink-3">
              步骤自上而下依次执行；拖动左侧把手调整顺序，悬停连线可在中间插入。
            </span>
          </div>
        </div>

        <aside className="min-w-0 @3xl/main:sticky @3xl/main:top-6 @3xl/main:self-start">
          <PreviewPanel
            preview={preview}
            paused={!valid}
            dirty={dirty}
            showMembers={target.kind === 'collection'}
          />
        </aside>
      </div>
      <SaveBar
        visible={dirty}
        saving={saving}
        onSave={() => void save()}
        onDiscard={discard}
        message={blockReason ?? '处理流程有未保存的修改'}
      />
    </div>
  );
}
