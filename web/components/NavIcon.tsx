import type { SVGProps } from 'react';

export type NavIconName =
  | 'overview'
  | 'base'
  | 'groups'
  | 'chain'
  | 'tailscale'
  | 'rules'
  | 'config'
  | 'devices'
  | 'subscriptions'
  | 'ruleSets'
  | 'history'
  | 'assistant'
  | 'docs'
  | 'settings'
  | 'logout'
  | 'menu';

const PATHS: Record<NavIconName, string[]> = {
  overview: ['M4 13h6V4H4v9Z', 'M14 20h6v-9h-6v9Z', 'M4 20h6v-3H4v3Z', 'M14 7h6V4h-6v3Z'],
  base: ['M4 7h7', 'M15 7h5', 'M4 17h3', 'M11 17h9', 'M11 4v6', 'M7 14v6'],
  groups: ['M5 6h5v5H5z', 'M14 13h5v5h-5z', 'M10 8.5h4a2 2 0 0 1 2 2V13'],
  chain: [
    'M9.5 14.5 7 17a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0',
    'm14.5 9.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0',
    'm8 16 8-8',
  ],
  tailscale: [
    'M5 6h.01',
    'M12 6h.01',
    'M19 6h.01',
    'M5 12h.01',
    'M12 12h.01',
    'M19 12h.01',
    'M5 18h.01',
    'M12 18h.01',
    'M19 18h.01',
  ],
  rules: ['M5 6h14', 'M5 12h10', 'M5 18h7', 'm17 15 3 3-3 3'],
  config: ['M7 3h7l4 4v14H7z', 'M14 3v5h5', 'm10 15 2 2 4-4'],
  devices: ['M4 4h16v11H4z', 'M9 20h6', 'M12 15v5'],
  subscriptions: ['M12 3v11', 'm8 10 4 4 4-4', 'M5 20h14'],
  ruleSets: ['M5 4h14v16H5z', 'M9 8h6', 'M9 12h6', 'M9 16h4'],
  history: ['M3 12a9 9 0 1 0 3-6.7', 'M3 4v5h5', 'M12 7v5l3 2'],
  assistant: [
    'm12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z',
    'm18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z',
  ],
  docs: [
    'M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z',
    'M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z',
  ],
  settings: [
    'M12 3v2',
    'M12 19v2',
    'M3 12h2',
    'M19 12h2',
    'm5.6 5.6 1.4 1.4',
    'm17 17 1.4 1.4',
    'm18.4 5.6-1.4 1.4',
    'M7 17 5.6 18.4',
    'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  ],
  logout: ['M10 5H5v14h5', 'M14 8l4 4-4 4', 'M8 12h10'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
};

export function NavIcon({
  name,
  size = 18,
  ...props
}: { name: NavIconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {PATHS[name].map((path, index) => (
        <path d={path} key={`${name}-${index}`} />
      ))}
    </svg>
  );
}
