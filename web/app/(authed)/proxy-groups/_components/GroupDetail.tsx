'use client';

import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { ProxyGroup, ProxyGroupTemplate } from '@/schemas';
import {
  escapeRegex,
  KIND_LABELS,
  TYPE_GLYPH,
  yamlPreview,
  type SubscriptionLite,
} from '../_lib/model';
import { memberStat } from '../_lib/useAvailableMembers';
import type { RefSummary } from './GroupEditor';

export function GroupDetail({
  group,
  templates,
  nodeNames,
  subs,
  refSummary,
  busy,
  onEdit,
  onDelete,
}: {
  group: ProxyGroup;
  templates: ProxyGroupTemplate[];
  nodeNames: string[];
  subs: SubscriptionLite[];
  refSummary: RefSummary | null;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tpl = group.template_id ? templates.find((t) => t.id === group.template_id) ?? null : null;
  const stat = useMemo(
    () => memberStat(group, nodeNames, subs),
    [group, nodeNames, subs],
  );

  const effective = useMemo(() => {
    const e: Record<string, unknown> = { ...group };
    if (group.kind === 'single-sub' && group.bound_subscription_id) {
      const sub = subs.find((s) => s.id === group.bound_subscription_id);
      if (sub?.node_prefix) {
        e['include-all-proxies'] = true;
        e.filter = `^${escapeRegex(sub.node_prefix)}`;
      }
    }
    return e;
  }, [group, subs]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="font-serif text-[20px] tracking-[-0.01em] text-[var(--color-ink)]">
          {group.name}
        </h2>
        <Badge tone="accent">{KIND_LABELS[group.kind]}</Badge>
        <Badge tone="neutral">
          {TYPE_GLYPH[group.type]} {group.type}
        </Badge>
        {tpl && <Badge tone="neutral">模板:{tpl.name}</Badge>}
        {group.section && <Badge tone="neutral">{group.section}</Badge>}
        <div className="ml-auto flex gap-2">
          <Button onClick={onEdit} disabled={busy}>
            编辑
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={busy}>
            删除
          </Button>
        </div>
      </div>

      {group.notes && <p className="text-[13px] text-[var(--color-muted)]">{group.notes}</p>}

      {/* Member summary */}
      <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] bg-[var(--color-bg-sunk)] flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-[var(--color-fg)]">成员</span>
          <span className="text-[12px] text-[var(--color-muted)]">{stat.summary}</span>
        </div>
        <div className="p-4 space-y-3">
          {group.filter && (
            <div className="text-[12px]">
              <span className="text-[var(--color-muted)]">filter </span>
              <code className="font-mono text-[var(--color-fg)] bg-[var(--color-bg-sunk)] px-1.5 py-0.5 rounded">
                {group.filter}
              </code>
            </div>
          )}
          {group['exclude-filter'] && (
            <div className="text-[12px]">
              <span className="text-[var(--color-muted)]">exclude-filter </span>
              <code className="font-mono text-[var(--color-fg)] bg-[var(--color-bg-sunk)] px-1.5 py-0.5 rounded">
                {group['exclude-filter']}
              </code>
            </div>
          )}
          {group.proxies && group.proxies.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {group.proxies.map((p) => (
                <span
                  key={p}
                  className="font-mono text-[12px] px-2 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-fg-soft)]"
                >
                  {p}
                </span>
              ))}
            </div>
          ) : (
            !group.filter &&
            !group['include-all-proxies'] &&
            !group['include-all'] &&
            !group['include-all-providers'] &&
            !group.bound_subscription_id &&
            !group.bound_collection_id && (
              <p className="text-[12px] text-[var(--color-muted)]">无成员——点「编辑」添加。</p>
            )
          )}
        </div>
      </div>

      <Collapsible title="完整 YAML">
        <pre className="text-[11px] font-mono leading-relaxed bg-[var(--color-bg-sunk)] rounded-lg p-3 overflow-x-auto text-[var(--color-fg-soft)]">
          {yamlPreview(effective)}
        </pre>
        {tpl && (
          <p className="text-[11px] text-[var(--color-muted)] mt-2">
            另继承共享模板「{tpl.name}」中本组未显式设置的字段。
          </p>
        )}
      </Collapsible>

      {refSummary && (refSummary.rules > 0 || refSummary.refIn.length > 0 || refSummary.refOut.length > 0) && (
        <div className="text-[12px] text-[var(--color-muted)] space-y-1 border-t border-[var(--color-border)] pt-4">
          {refSummary.rules > 0 && <div>← {refSummary.rules} 条规则的 policy 指向本组</div>}
          {refSummary.refIn.length > 0 && <div>← 被策略组引用:{refSummary.refIn.join(' · ')}</div>}
          {refSummary.refOut.length > 0 && <div>→ 本组引用:{refSummary.refOut.join(' · ')}</div>}
        </div>
      )}
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-[13px] hover:bg-[var(--color-surface-hover)]"
      >
        <span className="text-[var(--color-muted)]">{open ? '▾' : '▸'}</span>
        <span className="font-medium text-[var(--color-fg)]">{title}</span>
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t border-[var(--color-border)]">{children}</div>}
    </div>
  );
}
