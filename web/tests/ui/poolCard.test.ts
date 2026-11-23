import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CollectionSchema } from '@/schemas/collection';
import { PoolCard } from '@/ui/features/sources/sources-index';

describe('aggregate list cards', () => {
  it.each(['东京聚合', '这是一个很长的聚合订阅名称'.repeat(8)])('allows the card to shrink and ellipsizes its name: %s', (name) => {
    const pool = CollectionSchema.parse({ id: '33333333-3333-4333-8333-333333333333', name });
    const html = renderToStaticMarkup(createElement(PoolCard, { pool, sources: [], subBase: null }));
    expect(html).toMatch(/<article class="[^"]*min-w-0/);
    expect(html).toContain(`class="truncate text-[14px] font-semibold tracking-tight text-ink">${name}</div>`);
    expect(html).toContain(`aria-label="打开「${name}」"`);
  });
});
