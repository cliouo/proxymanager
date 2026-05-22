import type { ReactNode } from 'react';

interface TimelineGroupProps {
  label: string;
  children: ReactNode;
}

/**
 * 时间线分组：
 * - 顶部 Fraunces serif 日期 + 一条横线
 * - 下方垂直时间轴：左 6px 处一条 1px 暖灰竖线，事件 marker 居中在线上
 */
export function TimelineGroup({ label, children }: TimelineGroupProps) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-4">
        <h2
          className="font-serif text-[20px] font-medium leading-[1.25] tracking-[-0.01em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
        >
          {label}
        </h2>
        <div className="flex-1 h-px bg-[var(--color-border)]" />
      </div>
      {/* pl-6 = 24px; 竖线在 left-[7px]，glyph 居中在 7px 处 */}
      <div className="relative pl-6">
        <div className="absolute left-[7px] top-[10px] bottom-[10px] w-px bg-[var(--color-border)]" />
        <ul className="space-y-1">{children}</ul>
      </div>
    </section>
  );
}

type Glyph = 'create' | 'update' | 'delete' | 'undo';

const GLYPHS: Record<Glyph, { mark: string; tone: string }> = {
  create: { mark: '●', tone: 'text-[var(--color-success)]' },
  update: { mark: '◐', tone: 'text-[var(--color-warn)]' },
  delete: { mark: '●', tone: 'text-[var(--color-danger)]' }, // 删除也用实心圆，颜色区分；不再混用 ✕ 与时间轴冲突
  undo: { mark: '○', tone: 'text-[var(--color-plum)]' },    // 撤销 = 空心圆
};

interface TimelineEventProps {
  glyph: Glyph;
  time: string;
  actor: string;
  children: ReactNode;
  action?: ReactNode;
  faded?: boolean;
}

export function TimelineEvent({
  glyph,
  time,
  actor,
  children,
  action,
  faded = false,
}: TimelineEventProps) {
  const g = GLYPHS[glyph];
  return (
    <li
      className={`group relative py-1 -my-px rounded-md transition-colors hover:bg-[var(--color-bg-sunk)] ${
        faded ? 'opacity-50' : ''
      }`}
    >
      {/* marker：6px 圆点居中在竖线（line left=7px in parent, so center at 7px）
         marker 自身 14px font + leading-none + 在 li 上的 absolute 定位
         li 左边在 pl-6 = 24px 处； marker 中心要落在 group-left + 7px，
         即 marker 左边 = group-left + 7 - markerWidth/2。 li 起点 = 24，
         所以 marker.left = 7 - 24 - 6 = -23px 从 li 左边算起。 */}
      <span
        className={`absolute -left-[22px] top-[6px] text-[14px] leading-none ${g.tone} bg-[var(--color-bg)] w-3.5 inline-flex justify-center`}
        aria-hidden
      >
        {g.mark}
      </span>
      <div className="flex items-center gap-3 min-w-0 px-2">
        <time className="shrink-0 text-[12px] tabular-nums text-[var(--color-muted)] font-mono w-12">
          {time}
        </time>
        <span className="shrink-0 text-[12px] text-[var(--color-muted-strong)] font-mono w-16 truncate">
          {actor}
        </span>
        <div className="flex-1 min-w-0 text-[13px] leading-[1.45]">{children}</div>
        {action && (
          <div className="shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {action}
          </div>
        )}
      </div>
    </li>
  );
}
