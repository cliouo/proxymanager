import type { ActivityTone } from '@/lib/ui/auditEventCopy';

/** Tinted square icon used by the activity timeline and the dashboard alerts. */
export type IconTileName =
  | 'plus'
  | 'pencil'
  | 'trash'
  | 'reorder'
  | 'undo'
  | 'sparkle'
  | 'error'
  | 'warning'
  | 'info'
  | 'check'
  | 'cloud'
  | 'file'
  | 'stack'
  | 'list'
  | 'gauge'
  | 'fallback'
  | 'balance';

export type IconTileTone = 'ok' | 'acc' | 'danger' | 'warn' | 'ai' | 'neutral';

const PATHS: Record<IconTileName, string[]> = {
  plus: ['M12 5v14', 'M5 12h14'],
  pencil: ['M4 20h4L19 9l-4-4L4 16v4Z', 'm13.5 6.5 4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  reorder: ['M8 4v16', 'm4 8 4-4 4 4', 'M16 20V4', 'm12 16 4 4 4-4'],
  undo: ['M9 14 4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  sparkle: [
    'm12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z',
    'm18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z',
  ],
  error: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'm9 9 6 6', 'm15 9-6 6'],
  warning: [
    'M10.3 4.2 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z',
    'M12 9v4',
    'M12 17h.01',
  ],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 11v5', 'M12 8h.01'],
  check: ['m5 12 5 5L20 7'],
  cloud: ['M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.2 4.2 0 0 0 7 18Z'],
  file: ['M7 3h7l4 4v14H7z', 'M14 3v5h5'],
  stack: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 13 9 5 9-5'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  gauge: ['M3.5 17a9 9 0 1 1 17 0', 'm12 14 4-5'],
  fallback: ['M4 7h9a4 4 0 0 1 0 8H8', 'm11 12-3 3 3 3'],
  balance: ['M12 4v16', 'M6 9 3 15h6L6 9Z', 'M18 9l-3 6h6l-3-6Z', 'M6 9h12'],
};

export const ACTIVITY_ICON: Record<ActivityTone, { name: IconTileName; tone: IconTileTone }> = {
  create: { name: 'plus', tone: 'ok' },
  update: { name: 'pencil', tone: 'acc' },
  move: { name: 'reorder', tone: 'neutral' },
  delete: { name: 'trash', tone: 'danger' },
  undo: { name: 'undo', tone: 'neutral' },
  ai: { name: 'sparkle', tone: 'ai' },
};

export function IconTile({
  name,
  tone,
  size = 28,
}: {
  name: IconTileName;
  tone: IconTileTone;
  size?: number;
}) {
  const glyph = Math.round(size * 0.54);
  return (
    <span className={`icon-tile ${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg
        viewBox="0 0 24 24"
        width={glyph}
        height={glyph}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {PATHS[name].map((d, i) => (
          <path d={d} key={i} />
        ))}
      </svg>
    </span>
  );
}
