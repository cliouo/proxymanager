import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  Button,
  Dialog,
  FeedbackHost,
  Menu,
  Popover,
  Sheet,
  Tooltip,
  confirmAction,
  notify,
} from '@/ui/primitives';
import { AppToaster, appToaster } from '@/ui/primitives/feedback';

let allowConfirm = false;
const agent = createAgent({
  allow: (step) => !step.confirm || allowConfirm,
});

afterEach(() => {
  allowConfirm = false;
  appToaster.dismiss();
});

function OverlayHarness({
  onMenuAction,
  onConfirmed,
}: {
  onMenuAction: (name: string) => void;
  onConfirmed: (ok: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <div>
      <Button onClick={() => setDialogOpen(true)}>打开详情弹窗</Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="节点详情"
        description="查看节点的配置参数"
        footer={
          <Button variant="primary" onClick={() => setDialogOpen(false)}>
            完成查看
          </Button>
        }
      >
        <p>节点内容</p>
      </Dialog>

      <Button onClick={() => setSheetOpen(true)}>打开侧边抽屉</Button>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="编辑订阅源">
        <p>抽屉正文</p>
      </Sheet>

      <Popover trigger={<Button>筛选条件</Button>}>
        <Button onClick={() => onMenuAction('reset-filter')}>重置筛选</Button>
      </Popover>

      <Menu
        trigger={<Button>更多操作</Button>}
        items={[
          { label: '立即刷新', onSelect: () => onMenuAction('refresh') },
          'separator',
          { label: '删除订阅', tone: 'danger', onSelect: () => onMenuAction('delete') },
        ]}
      />

      <Tooltip content="复制链接">
        <Button onClick={() => onMenuAction('copy')}>复制</Button>
      </Tooltip>

      <Button
        variant="danger"
        onClick={async () => {
          const ok = await confirmAction({
            title: '确认删除该订阅？',
            description: '删除后无法恢复',
            confirmText: '永久删除',
            tone: 'danger',
          });
          onConfirmed(ok);
        }}
      >
        触发删除确认
      </Button>

      <FeedbackHost />
      <AppToaster />
    </div>
  );
}

describe('ui-sdk migrated overlay & feedback primitives', () => {
  test('agent can open dialog, sheet, popover, and execute menu actions', async () => {
    const onMenuAction = vi.fn();
    render(<OverlayHarness onMenuAction={onMenuAction} onConfirmed={() => {}} />);

    const snap = agent.snapshot().filter((e) => !e.offPage && e.component !== 'more');
    for (const entry of snap) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }
    // Menu and Popover triggers wrapped with <Button> must register only once (not duplicate button + menu/popover).
    expect(snap.filter((e) => e.label === '更多操作').map((e) => e.component)).toEqual(['menu']);
    expect(snap.filter((e) => e.label === '筛选条件').map((e) => e.component)).toEqual(['popover']);

    const menuRes = await agent.act({
      steps: [{ ref: '更多操作', action: 'press', args: ['立即刷新'] }],
    });
    expect(menuRes.ok, menuRes.error?.message).toBe(true);
    expect(onMenuAction).toHaveBeenCalledWith('refresh');

    const dialogRes = await agent.act({
      steps: [
        { ref: '打开详情弹窗', action: 'press' },
        { ref: '节点详情', action: 'press', args: ['完成查看'] },
      ],
    });
    expect(dialogRes.ok, dialogRes.error?.message).toBe(true);
    expect(screen.queryByText('节点内容')).toBeNull();

    const sheetRes = await agent.act({
      steps: [{ ref: '打开侧边抽屉', action: 'press' }],
    });
    expect(sheetRes.ok, sheetRes.error?.message).toBe(true);
    expect(screen.getByText('抽屉正文')).toBeTruthy();
  });

  test('confirmAction gates confirming button with data-agent-confirm', async () => {
    const onConfirmed = vi.fn();
    render(<OverlayHarness onMenuAction={() => {}} onConfirmed={onConfirmed} />);

    const openRes = await agent.act({
      steps: [{ ref: '触发删除确认', action: 'press' }],
    });
    expect(openRes.ok, openRes.error?.message).toBe(true);
    expect(await screen.findByText('确认删除该订阅？')).toBeTruthy();

    allowConfirm = false;
    const refused = await agent.act({
      steps: [{ ref: '确认删除该订阅？', action: 'press', args: ['永久删除'] }],
    });
    expect(refused.ok).toBe(false);
    expect(onConfirmed).not.toHaveBeenCalled();

    const reopenRes = await agent.act({
      steps: [{ ref: '触发删除确认', action: 'press' }],
    });
    expect(reopenRes.ok, reopenRes.error?.message).toBe(true);
    expect(await screen.findByText('确认删除该订阅？')).toBeTruthy();

    allowConfirm = true;
    const approved = await agent.act({
      steps: [{ ref: '确认删除该订阅？', action: 'press', args: ['永久删除'] }],
    });
    expect(approved.ok, approved.error?.message).toBe(true);
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(true));
  });

  test('notify shows toast in ToastRegion and agent can press toast action', async () => {
    const onUndo = vi.fn();
    render(<AppToaster />);

    notify.success('已保存更改', '订阅配置已更新', { label: '撤销', onClick: onUndo });
    expect(await screen.findByText('已保存更改')).toBeTruthy();

    const result = await agent.act({
      steps: [{ ref: '已保存更改', action: 'press', args: ['撤销'] }],
    });
    expect(result.ok, result.error?.message).toBe(true);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});
