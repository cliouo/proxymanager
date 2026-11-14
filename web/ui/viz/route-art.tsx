'use client';

import { cn } from '@/ui/lib/cn';

/**
 * Decorative transit map: sources on the left merge through a junction and
 * fan out to devices on the right. Pure SVG, animated with CSS only.
 */
const LINES = [
  { d: 'M-20 90 C120 90 150 230 280 250 S420 250 470 160 S600 70 680 70', color: 'var(--l-1)', delay: 0 },
  { d: 'M-20 170 C110 170 170 250 280 262 S430 300 500 300 S610 230 680 230', color: 'var(--l-2)', delay: 0.12 },
  { d: 'M-20 330 C110 330 170 280 280 274 S420 350 500 380 S610 390 680 390', color: 'var(--l-3)', delay: 0.24 },
  { d: 'M-20 450 C130 450 160 300 280 286 S410 440 480 500 S600 540 680 540', color: 'var(--l-4)', delay: 0.36 },
  { d: 'M-20 540 C150 540 190 320 280 298 S400 120 470 90 S600 10 680 10', color: 'var(--l-5)', delay: 0.48 },
];

const STATIONS = [
  { x: 280, y: 274, r: 9, major: true },
  { x: 470, y: 160, r: 5 },
  { x: 500, y: 300, r: 5 },
  { x: 500, y: 380, r: 5 },
  { x: 480, y: 500, r: 5 },
  { x: 120, y: 90, r: 4 },
  { x: 110, y: 170, r: 4 },
  { x: 110, y: 330, r: 4 },
  { x: 130, y: 450, r: 4 },
];

export function RouteArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 660 600" className={cn('h-full w-full', className)} aria-hidden preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id="route-glow" cx="42%" cy="46%" r="55%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.14" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="660" height="600" fill="url(#route-glow)" />
      {LINES.map((line, index) => (
        <g key={index}>
          <path
            d={line.d}
            fill="none"
            stroke={line.color}
            strokeWidth="9"
            strokeLinecap="round"
            strokeOpacity="0.16"
            style={{ strokeDasharray: 1200, ['--draw-length' as string]: 1200, animationDelay: `${line.delay}s` } as React.CSSProperties}
            className="animate-draw"
          />
          <path
            d={line.d}
            fill="none"
            stroke={line.color}
            strokeWidth="3"
            strokeLinecap="round"
            style={{ strokeDasharray: 1200, ['--draw-length' as string]: 1200, animationDelay: `${line.delay}s` } as React.CSSProperties}
            className="animate-draw"
          />
          <path
            d={line.d}
            fill="none"
            stroke="var(--panel)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeDasharray="2 22"
            className="route-flow"
            style={{ ['--flow-duration' as string]: `${2.4 + index * 0.35}s`, ['--flow-delay' as string]: `${1.4 + line.delay}s`, opacity: 0.9 } as React.CSSProperties}
          />
        </g>
      ))}
      {STATIONS.map((s, index) => (
        <g key={index} style={{ animation: `pop 0.4s var(--ease-out-expo) both`, animationDelay: `${0.9 + index * 0.06}s`, transformOrigin: `${s.x}px ${s.y}px` }}>
          <circle cx={s.x} cy={s.y} r={s.r + (s.major ? 5 : 2.5)} fill="var(--panel)" />
          <circle cx={s.x} cy={s.y} r={s.r} fill="var(--panel)" stroke="var(--ink)" strokeWidth={s.major ? 3 : 2} />
        </g>
      ))}
    </svg>
  );
}
