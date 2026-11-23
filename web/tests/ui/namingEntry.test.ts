import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StoredOperator } from '@/ui/data/types';
import { NamingLink, NamingSetupPrompt } from '@/ui/features/sources/naming-entry';

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
