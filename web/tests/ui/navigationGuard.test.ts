import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmLeave, hasUnsavedEdits, navigateWithGuard, PIPELINE_LEAVE_CONFIRMATION, registerDirtyCheck } from '@/ui/features/groups/guard';
import * as feedback from '@/ui/primitives/feedback';

let unregister = () => {};
afterEach(() => {
  unregister();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shared editor navigation guard', () => {
  it.each([true, false])('honors the dirty pipeline confirmation (leave: %s)', async (leave) => {
    unregister = registerDirtyCheck(() => true, PIPELINE_LEAVE_CONFIRMATION);
    const confirm = vi.spyOn(feedback, 'confirmAction').mockResolvedValueOnce(leave);
    const navigate = vi.fn();
    const pending = navigateWithGuard(navigate);
    expect(navigate).not.toHaveBeenCalled();
    await pending;
    expect(confirm).toHaveBeenCalledWith(PIPELINE_LEAVE_CONFIRMATION);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmText: '放弃修改并离开', cancelText: '留下' }));
    expect(navigate).toHaveBeenCalledTimes(leave ? 1 : 0);
  });

  it('does not ask for clean or unmounted editors', async () => {
    unregister = registerDirtyCheck(() => false);
    const confirm = vi.spyOn(feedback, 'confirmAction');
    const navigate = vi.fn();
    await navigateWithGuard(navigate);
    unregister();
    await navigateWithGuard(navigate);
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('retains the group editor message and ignores stale cleanup', async () => {
    const cleanup = registerDirtyCheck(() => true, '处理流程');
    unregister = registerDirtyCheck(() => true);
    cleanup();
    expect(hasUnsavedEdits()).toBe(true);
    const confirm = vi.spyOn(feedback, 'confirmAction').mockResolvedValueOnce(false);
    await confirmLeave();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining('当前策略组'), confirmText: '放弃修改' }));
  });

  it('does not navigate if confirmation fails', async () => {
    unregister = registerDirtyCheck(() => true);
    vi.spyOn(feedback, 'confirmAction').mockRejectedValueOnce(new Error('confirmation failed'));
    const navigate = vi.fn();
    await expect(navigateWithGuard(navigate)).rejects.toThrow('confirmation failed');
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(['sources', 'pools'])('allows query/tab changes for the current %s entity without discarding the draft', async (kind) => {
    const pathname = `/${kind}/entity-id`;
    vi.stubGlobal('window', { location: new URL(`http://localhost:3000${pathname}?tab=pipeline`) });
    unregister = registerDirtyCheck(() => true, '处理流程');
    const confirm = vi.spyOn(feedback, 'confirmAction');
    const navigate = vi.fn();
    for (const href of [pathname, `${pathname}?tab=nodes`, `${pathname}#top`]) {
      await navigateWithGuard(navigate, href);
    }
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(3);
    expect(hasUnsavedEdits()).toBe(true);
  });

  it.each(['/sources/other-id', '/sources/entity-id/naming', '/pools/entity-id', 'https://example.invalid/sources/entity-id'])('still guards navigation away to %s', async (href) => {
    vi.stubGlobal('window', { location: new URL('http://localhost:3000/sources/entity-id?tab=pipeline') });
    unregister = registerDirtyCheck(() => true);
    const confirm = vi.spyOn(feedback, 'confirmAction').mockResolvedValueOnce(false);
    const navigate = vi.fn();
    await navigateWithGuard(navigate, href);
    expect(confirm).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});
