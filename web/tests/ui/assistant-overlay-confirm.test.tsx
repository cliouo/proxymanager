import { useEffect } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  AgentConfirmCard,
  AgentHost,
  clearAgentConfirms,
  createAppAllow,
  registerInlineConfirmHost,
  runAgentAct,
  usePendingAgentConfirm,
} from '@/ui/agent';
import { Button, Dialog } from '@/ui/primitives';
import { setUi } from '@/ui/shell/state';

const agent = createAgent({ allow: createAppAllow() });

function InlineSidebarMock({ onStop }: { onStop: () => void }) {
  const pending = usePendingAgentConfirm();
  useEffect(() => registerInlineConfirmHost(), []);
  return (
    <aside data-agent-hidden data-assistant-surface aria-label="AI 侧边栏">
      <button type="button" onClick={onStop}>
        停止
      </button>
      {pending && <AgentConfirmCard request={pending} />}
    </aside>
  );
}

afterEach(() => {
  clearAgentConfirms();
  setUi({ assistantOpen: false, assistantDocked: false });
  vi.restoreAllMocks();
});

describe('workspace-scoped dialog and inline confirmation card', () => {
  test('mounts dialog inside #main-overlay-root when assistant is docked so sidebar stays interactive', async () => {
    const user = userEvent.setup();
    const onStop = vi.fn();
    const onClose = vi.fn();
    setUi({ assistantOpen: true, assistantDocked: true });

    render(
      <div className="flex">
        <main id="main" className="relative">
          <div id="main-overlay-root" />
          <Dialog open onOpenChange={onClose} title="新建配置文件">
            <p>表单内容</p>
          </Dialog>
        </main>
        <InlineSidebarMock onStop={onStop} />
      </div>,
    );

    const overlayRoot = document.getElementById('main-overlay-root')!;
    await waitFor(() => {
      expect(overlayRoot.textContent).toContain('新建配置文件');
    });

    // Clicking inside the AI sidebar works and does NOT close the dialog
    await user.click(screen.getByRole('button', { name: '停止' }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('renders confirmation inline in sidebar (no 3rd-layer modal) and highlights target button on page', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    setUi({ assistantOpen: true, assistantDocked: true });

    render(
      <div className="flex">
        <main id="main" className="relative">
          <div id="main-overlay-root" />
          <Dialog
            open
            onOpenChange={() => undefined}
            title="新建配置文件"
            footer={
              <Button
                variant="primary"
                data-agent-confirm="创建配置文件「empty-test」并打开（空白，不绑定节点来源）"
                onClick={onSubmit}
              >
                创建并打开
              </Button>
            }
          >
            <p>名称：empty-test</p>
          </Dialog>
        </main>
        <InlineSidebarMock onStop={vi.fn()} />
        <AgentHost agent={agent} />
      </div>,
    );

    const pendingAct = runAgentAct(
      { steps: [{ ref: '创建并打开', action: 'press' }] },
      { agent },
    );

    // Confirmation appears inline inside the sidebar, NOT as a 3rd-layer alertdialog
    expect(
      await screen.findByText('创建配置文件「empty-test」并打开（空白，不绑定节点来源）'),
    ).toBeTruthy();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // The target button inside the dialog is highlighted on the page
    const targetBtn = screen.getByRole('button', { name: '创建并打开' });
    await waitFor(() => {
      expect(targetBtn.getAttribute('data-agent-confirm-target')).toBe('true');
    });

    // Approving from the inline card executes the click and removes the highlight
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const result = await pendingAct;
    expect(result.ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(targetBtn.getAttribute('data-agent-confirm-target')).toBeNull();
    });
  });
});
