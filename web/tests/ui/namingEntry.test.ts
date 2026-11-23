import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { StoredOperator } from '@/ui/data/types';
import { guardNamingNavigation, NamingLink, NamingSetupPrompt } from '@/ui/features/sources/naming-entry';
import * as feedback from '@/ui/primitives/feedback';
import { PageHeader } from '@/ui/shell/page';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('naming navigation with an unsaved pipeline draft', () => {
  it.each([true, false])('blocks navigation until the user decides (leave: %s)', async (leave) => {
    const confirm = vi.spyOn(feedback, 'confirmAction').mockResolvedValueOnce(leave);
    const event = { preventDefault: vi.fn() };
    const navigate = vi.fn();
    await guardNamingNavigation(event, true, navigate);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('处理流程') }));
    expect(navigate).toHaveBeenCalledTimes(leave ? 1 : 0);
    confirm.mockRestore();
  });

  it('allows clean drafts to use ordinary Link navigation without a dialog', async () => {
    const confirm = vi.spyOn(feedback, 'confirmAction');
    const event = { preventDefault: vi.fn() };
    const navigate = vi.fn();
    await guardNamingNavigation(event, false, navigate);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    confirm.mockRestore();
  });
});

it('constrains the wrapping header action row to the available width', () => {
  const html = renderToStaticMarkup(createElement(PageHeader, { title: '订阅源',
    actions: createElement(NamingLink, { href: '/sources/entity-id/naming' }) }));
  expect(html).toContain('flex max-w-full shrink-0 flex-wrap items-center gap-2');
});

describe.each(['sources', 'pools'])('naming entry for %s', (path) => {
  const href = `/${path}/entity-id/naming`;

  it('always renders a workspace header link without requiring a naming step', () => {
    const html = renderToStaticMarkup(createElement(NamingLink, { href }));
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('智能命名');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/\s(?:aria-)?disabled(?:=|\s|>)/);
  });

  it.each([
    { operators: [] },
    { operators: [{ id: 'filter', kind: 'filter-useless', extra: [] }] },
    { operators: [{ id: 'filter', kind: 'filter-useless', extra: [], disabled: true }] },
  ] satisfies { operators: StoredOperator[] }[])('offers setup for a pipeline without naming: $operators', ({ operators }) => {
    const html = renderToStaticMarkup(createElement(NamingSetupPrompt, { href, operators }));
    expect(html).toContain('启用智能命名');
    expect(html).toContain(`href="${href}"`);
  });

  it.each([false, true])('does not show setup when a naming step exists (disabled: %s)', (disabled) => {
    const operators: StoredOperator[] = [{ id: 'naming', kind: 'rename-template', template: '${region}', recognitionRules: [], disabled }];
    expect(renderToStaticMarkup(createElement(NamingSetupPrompt, { href, operators }))).toBe('');
    expect(renderToStaticMarkup(createElement(NamingLink, { href }))).toContain(`href="${href}"`);
  });
});
