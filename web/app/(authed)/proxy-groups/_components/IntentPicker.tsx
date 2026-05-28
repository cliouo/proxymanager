'use client';

import { Button } from '@/components/ui/Button';
import type { ProxyGroupKind } from '@/schemas';
import { KIND_DESCRIPTIONS, KIND_LABELS, KIND_ORDER } from '../_lib/model';

const KIND_ICON: Record<ProxyGroupKind, string> = {
  manual: '✎',
  filter: '🔍',
  all: '⊞',
  'single-sub': '🔗',
  raw: '⚙',
};

/** Step 1 of create — pick the intent. Presets pre-fill the same editor. */
export function IntentPicker({
  onPick,
  onCancel,
}: {
  onPick: (kind: ProxyGroupKind) => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-baseline justify-between">
        <h2 className="font-serif text-[20px] tracking-[-0.01em] text-[var(--color-ink)]">
          想建哪种策略组?
        </h2>
        <Button variant="secondary" onClick={onCancel}>
          取消
        </Button>
      </div>
      <p className="text-[13px] text-[var(--color-muted)]">
        预设带智能默认值,只是把同一个编辑器调到合适形态;选「手选 / 自由」从零拼装。任何字段随后都能在「高级」里改。
      </p>
      <div className="grid grid-cols-2 gap-3">
        {KIND_ORDER.map((kind) => (
          <button
            key={kind}
            onClick={() => onPick(kind)}
            className="text-left p-4 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-surface-hover)] transition-colors flex gap-3"
          >
            <span className="text-[20px] leading-none mt-0.5" aria-hidden>
              {KIND_ICON[kind]}
            </span>
            <span className="min-w-0">
              <span className="block font-medium text-[14px] text-[var(--color-fg)] mb-1">
                {KIND_LABELS[kind]}
              </span>
              <span className="block text-[12px] text-[var(--color-muted)] leading-relaxed">
                {KIND_DESCRIPTIONS[kind]}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
