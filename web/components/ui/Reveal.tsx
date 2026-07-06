'use client';

import { useEffect, useState, type ReactNode } from 'react';

interface RevealProps {
  /** 当为 true 时触发淡入。一般传 `!!data` 或 `loaded`。 */
  when?: boolean;
  /** 不传 when 时默认挂载即触发（用于"页面打开"层级的过渡）。 */
  children: ReactNode;
  className?: string;
  /** 慢一档（360ms），用于内容更"重"的区块。 */
  slow?: boolean;
}

/**
 * 内容到达 / 挂载时的「纸张呈现」缓入：opacity 0→1 + translateY 4px→0。
 * 比骨架屏更温润，比无过渡的「空白突现」礼貌。
 */
export function Reveal({ when, slow, className = '', children }: RevealProps) {
  const [show, setShow] = useState(when ?? false);

  useEffect(() => {
    if (when === undefined) {
      setShow(true);
      return;
    }
    if (when) setShow(true);
  }, [when]);

  if (!show) return null;

  return <div className={`${slow ? 'pm-reveal-slow' : 'pm-reveal'} ${className}`}>{children}</div>;
}

interface PlaceholderProps {
  /** 占位行数；默认 3。 */
  rows?: number;
  className?: string;
  compact?: boolean;
}

/**
 * 控制台占位状态:细线骨架 + 轻扫光,用于 Vercel/KV 慢响应时保持版面稳定。
 * 用法：<Placeholder rows={3} />
 */
export function Placeholder({ rows = 3, compact = false, className = '' }: PlaceholderProps) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="pm-skeleton line"
          style={{
            width: `${compact ? 34 + ((i * 17) % 28) : 58 + ((i * 13) % 34)}%`,
            height: compact ? 8 : 12,
          }}
        />
      ))}
    </div>
  );
}

export function SkeletonStat() {
  return (
    <div className="stat" aria-hidden>
      <div className="pm-skeleton line" style={{ width: '42%', height: 10 }} />
      <div className="pm-skeleton line" style={{ width: 52, height: 34, margin: '10px 0 8px' }} />
      <div className="pm-skeleton line" style={{ width: '72%' }} />
    </div>
  );
}

export function LoadingPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="panel" aria-busy="true">
      <div className="panel-body">
        <Placeholder rows={rows} />
      </div>
    </div>
  );
}
