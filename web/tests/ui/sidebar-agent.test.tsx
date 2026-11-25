import { render } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SidebarContent } from '@/ui/shell/sidebar';

const setThemeMock = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/sources',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useParams: () => ({}),
}));

vi.mock('next-themes', async () => {
  const React = await import('react');
  return {
    useTheme: () => {
      const [theme, setTheme] = React.useState('light');
      return {
        theme,
        setTheme: (next: string) => {
          setThemeMock(next);
          setTheme(next);
        },
      };
    },
  };
});

vi.mock('@/ui/data/hooks', () => ({
  useProfiles: () => ({ data: [{ id: 'p1', name: 'default', display_name: '默认配置', kind: 'profile' }] }),
  useSources: () => ({ data: [] }),
  usePools: () => ({ data: [] }),
}));

const agent = createAgent();

afterEach(() => {
  setThemeMock.mockReset();
});

describe('Sidebar navigation agent-readiness', () => {
  test('agent can see all nav links and theme switch while assistant button stays hidden', async () => {
    const onNavigate = vi.fn();
    render(<SidebarContent collapsed={false} onNavigate={onNavigate} />);

    const components = agent
      .snapshot()
      .filter((entry) => !entry.offPage && entry.component !== 'more');

    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }

    const labels = components.map((entry) => entry.label);
    for (const expected of ['总览', '策略组', '规则', '节点来源', '规则集', '操作历史', '设置', '主题']) {
      expect(labels, `${expected} missing from sidebar snapshot`).toContain(expected);
    }
    expect(labels).not.toContain('打开 AI 助手');
    expect(labels).not.toContain('AI 助手');

    const res = await agent.act({
      steps: [
        { ref: '节点来源', action: 'press' },
        { ref: '主题', action: 'setValue', args: ['深色'] },
      ],
    });
    expect(res.ok, res.error?.message).toBe(true);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(setThemeMock).toHaveBeenCalledWith('dark');
  });
});
