import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDirtyCheck } from '@/ui/features/groups/guard';
import { navigateFromPipeline } from '@/ui/pipeline/pipeline-editor';
import { getUi, setUi } from '@/ui/shell/state';
import * as feedback from '@/ui/primitives/feedback';

let unregister = () => {};
afterEach(() => {
  unregister();
  setUi({ assistantOpen: false });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('guarded pipeline link navigation', () => {
  it.each([true, false])('closes the assistant only after approval (leave: %s)', async (leave) => {
    unregister = registerDirtyCheck(() => true, '处理流程');
    setUi({ assistantOpen: true });
    vi.spyOn(feedback, 'confirmAction').mockResolvedValueOnce(leave);
    const navigate = vi.fn(() => expect(getUi().assistantOpen).toBe(false));
    const pending = navigateFromPipeline(navigate);
    expect(getUi().assistantOpen).toBe(true);
    await pending;
    expect(getUi().assistantOpen).toBe(!leave);
    expect(navigate).toHaveBeenCalledTimes(leave ? 1 : 0);
  });

  it('handles navigation when no assistant modal is open', async () => {
    unregister = registerDirtyCheck(() => false);
    const confirm = vi.spyOn(feedback, 'confirmAction');
    const navigate = vi.fn();
    await navigateFromPipeline(navigate);
    expect(confirm).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledOnce();
    expect(getUi().assistantOpen).toBe(false);
  });

  it('keeps the docked desktop assistant open', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    unregister = registerDirtyCheck(() => true);
    setUi({ assistantOpen: true });
    vi.spyOn(feedback, 'confirmAction').mockResolvedValueOnce(true);
    const navigate = vi.fn();
    await navigateFromPipeline(navigate);
    expect(navigate).toHaveBeenCalledOnce();
    expect(getUi().assistantOpen).toBe(true);
  });
});
