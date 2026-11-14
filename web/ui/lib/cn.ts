import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [
        'canvas',
        'panel',
        'surface',
        'surface-2',
        'surface-3',
        'sunken',
        'line',
        'line-strong',
        'ink',
        'ink-2',
        'ink-3',
        'ink-4',
        'accent',
        'accent-hover',
        'accent-soft',
        'accent-line',
        'accent-ink',
        'ok',
        'ok-soft',
        'warn',
        'warn-soft',
        'bad',
        'bad-soft',
        'inverse',
        'inverse-ink',
        'overlay',
      ],
      text: ['2xs', 'md'],
      shadow: ['xs', 'sm', 'md', 'lg', 'xl'],
      radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
