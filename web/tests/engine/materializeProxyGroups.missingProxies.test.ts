import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { materializeDynamicProxyGroups } from '@/lib/engine/materializeProxyGroups';
import { validateFinalRenderedConfig } from '@/lib/engine/resolve';

it('materializes fallback-only groups without a top-level proxies key', () => {
  const content = `proxy-groups:
  - {name: Empty, type: select, include-all-proxies: true, empty-fallback: REJECT}
rules: ["MATCH,Empty"]
`;
  validateFinalRenderedConfig(content);
  const output = materializeDynamicProxyGroups(content);
  expect(parse(output)['proxy-groups'][0]).toEqual({
    name: 'Empty',
    type: 'select',
    proxies: ['REJECT'],
  });
  validateFinalRenderedConfig(output);
});
