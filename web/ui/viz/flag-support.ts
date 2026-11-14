'use client';

/**
 * Flag emoji support differs per platform: Windows has no flag glyphs at all,
 * and Apple devices in some regions blank out specific flags. Probe each flag
 * once on a canvas (colour pixels ⇒ a real glyph) and cache the answer.
 */
const cache = new Map<string, boolean>();
let canvas: HTMLCanvasElement | null = null;

export function isFlagSupported(emoji: string): boolean {
  if (typeof document === 'undefined') return true;
  const cached = cache.get(emoji);
  if (cached !== undefined) return cached;
  try {
    canvas ??= document.createElement('canvas');
    canvas.width = 20;
    canvas.height = 20;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return true;
    ctx.clearRect(0, 0, 20, 20);
    ctx.textBaseline = 'top';
    ctx.font = '16px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
    ctx.fillText(emoji, 0, 2);
    const data = ctx.getImageData(0, 0, 20, 20).data;
    let colourful = false;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a > 0 && (Math.abs(r - g) > 24 || Math.abs(g - b) > 24 || Math.abs(r - b) > 24)) {
        colourful = true;
        break;
      }
    }
    cache.set(emoji, colourful);
    return colourful;
  } catch {
    cache.set(emoji, true);
    return true;
  }
}
