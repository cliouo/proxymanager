interface TrafficBarProps {
  upload: number;
  download: number;
  total: number;
  expire?: number;
  className?: string;
}

function fmtBytes(n: number): string {
  if (!n) return '0';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

/**
 * 订阅流量进度条 —— 上传 / 下载分段着色，到期日期右挂。
 * 在 Heritage Atelier 中是「订阅源」页的主图（视觉锚点）。
 */
export function TrafficBar({
  upload,
  download,
  total,
  expire,
  className = '',
}: TrafficBarProps) {
  const used = upload + download;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const ulPct = total > 0 ? Math.min(100, (upload / total) * 100) : 0;
  const dlPct = total > 0 ? Math.min(100 - ulPct, (download / total) * 100) : 0;

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-3 text-[12px] tabular-nums">
        <div className="flex items-baseline gap-3">
          <span className="text-[var(--color-muted)]">
            <span className="text-[var(--color-fg)] font-mono">↑</span> {fmtBytes(upload)}
          </span>
          <span className="text-[var(--color-muted)]">
            <span className="text-[var(--color-fg)] font-mono">↓</span> {fmtBytes(download)}
          </span>
          <span className="text-[var(--color-muted)]">/ {fmtBytes(total)}</span>
        </div>
        <span className="font-mono text-[var(--color-fg)] tabular-nums">
          {pct.toFixed(pct < 10 ? 1 : 0)}%
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-[var(--color-bg-strong)] overflow-hidden">
        <div
          className="absolute left-0 top-0 bottom-0 bg-[var(--color-plum)]"
          style={{ width: `${ulPct}%` }}
          aria-label={`上传 ${fmtBytes(upload)}`}
        />
        <div
          className="absolute top-0 bottom-0 bg-[var(--color-primary)]"
          style={{ left: `${ulPct}%`, width: `${dlPct}%` }}
          aria-label={`下载 ${fmtBytes(download)}`}
        />
      </div>
      {expire && expire > 0 && (
        <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
          到期 {new Date(expire * 1000).toLocaleDateString('zh-CN')}
        </div>
      )}
    </div>
  );
}
