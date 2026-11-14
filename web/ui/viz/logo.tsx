import { cn } from '@/ui/lib/cn';

/** The junction mark: two lines that cross at a station. */
export function LogoMark({ size = 22, className, animated }: { size?: number; className?: string; animated?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn('shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="8.5" className="fill-inverse" />
      <path
        d="M7 22c5 0 6-12 12-12h6"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
        style={animated ? ({ strokeDasharray: 40, ['--draw-length' as string]: 40 } as React.CSSProperties) : undefined}
        className={animated ? 'animate-draw' : undefined}
      />
      <path
        d="M7 10c5 0 6 12 12 12h6"
        fill="none"
        className="stroke-inverse-ink"
        strokeWidth="3"
        strokeLinecap="round"
        style={animated ? ({ strokeDasharray: 40, ['--draw-length' as string]: 40, animationDelay: '0.15s' } as React.CSSProperties) : undefined}
      />
      <circle cx="16" cy="16" r="3" className="fill-inverse stroke-inverse-ink" strokeWidth="1.8" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-ink">
        Proxy<span className="text-ink-3">Manager</span>
      </span>
    </span>
  );
}
