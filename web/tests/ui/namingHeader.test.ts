import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NamingHeaderMeta } from '@/ui/features/naming/header-meta';
import { PageHeader } from '@/ui/shell/page';

describe('naming workspace header metadata', () => {
  it.each(['东京聚合', '很长的聚合订阅名称'.repeat(10)])('wraps whole metadata items independently of the label: %s', (label) => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: '智能命名',
      eyebrow: createElement(NamingHeaderMeta, { label, kindLabel: '聚合订阅', nodeCount: 123, infoFiltered: 0 }) }));
    expect(html).toContain('mb-2 flex flex-wrap items-center');
    expect(html).toContain('class="shrink-0 whitespace-nowrap">聚合订阅</span>');
    expect(html).toContain('class="tnum shrink-0 whitespace-nowrap">输入 123 个节点</span>');
    expect(html).toContain('min-w-0 max-w-full truncate');
    expect(html).not.toContain('个信息节点');
  });

  it('preserves filtered information-node feedback', () => {
    const html = renderToStaticMarkup(createElement(NamingHeaderMeta, { label: '订阅', kindLabel: '订阅源', nodeCount: 0, infoFiltered: 2 }));
    expect(html).toContain('输入 0 个节点');
    expect(html).toContain('2 个信息节点（剩余流量、到期等）已过滤');
  });
});
