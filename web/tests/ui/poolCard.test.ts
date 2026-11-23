import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CollectionSchema } from '@/schemas/collection';
import { SubscriptionAdminViewSchema } from '@/schemas/subscription';
import { PoolCard, SourceCard } from '@/ui/features/sources/sources-index';
import { formatDate } from '@/ui/lib/format';

vi.mock('next/navigation', () => ({ useRouter: () => ({}) }));

describe('aggregate list cards', () => {
  it.each(['东京聚合', '这是一个很长的聚合订阅名称'.repeat(8)])('allows the card to shrink and ellipsizes its name: %s', (name) => {
    const pool = CollectionSchema.parse({ id: '33333333-3333-4333-8333-333333333333', name });
    const html = renderToStaticMarkup(createElement(PoolCard, { pool, sources: [], subBase: null }));
    expect(html).toMatch(/<article class="[^"]*min-w-0/);
    expect(html).toContain(`class="truncate text-[14px] font-semibold tracking-tight text-ink">${name}</div>`);
    expect(html).toContain(`aria-label="打开「${name}」"`);
  });
});

it('shows traffic and expiry on a local source card', () => {
  const expire = Date.UTC(2027, 5, 24, 12) / 1000;
  const source = SubscriptionAdminViewSchema.parse({
    id: '44444444-4444-4444-8444-444444444444',
    name: 'immtele',
    kind: 'local',
    enabled: true,
    traffic: { upload: 0, download: Math.round(1.91 * 1024 ** 3), total: 500 * 1024 ** 3, expire },
  });
  const html = renderToStaticMarkup(createElement(SourceCard, { source, subBase: null }));
  expect(html).toContain('本地节点');
  expect(html).toContain('1.9 GB');
  expect(html).toContain('/ 500 GB');
  expect(html).toContain(`title="到期：${formatDate(expire)}"`);
});
