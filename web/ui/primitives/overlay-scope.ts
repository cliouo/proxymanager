'use client';

import { useState } from 'react';
import { useTakeover } from '@/ui/agent/takeover';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { useUi } from '@/ui/shell/state';

export const MAIN_OVERLAY_ROOT_ID = 'main-overlay-root';
export const ASSISTANT_PERSISTENT_SELECTORS = ['[data-assistant-surface]', '[data-takeover-bar]'];

export function useWorkspaceOverlayScope() {
  const assistantOpen = useUi((s) => s.assistantOpen);
  const assistantDocked = useUi((s) => s.assistantDocked);
  const takeoverLocked = useTakeover().locked;
  const [scopedContainer, setScopedContainer] = useState<HTMLElement | null>(null);

  useIsomorphicLayoutEffect(() => {
    setScopedContainer(assistantDocked ? document.getElementById(MAIN_OVERLAY_ROOT_ID) : null);
  }, [assistantDocked]);

  return {
    assistantOpen,
    scopedContainer: assistantDocked ? scopedContainer : null,
    keepAssistantInteractive: assistantOpen || takeoverLocked,
  };
}
