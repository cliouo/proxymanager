'use client';

import { useState } from 'react';
import { useTakeover } from '@/ui/agent/takeover';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { useUi } from '@/ui/shell/state';

export const MAIN_OVERLAY_ROOT_ID = 'main-overlay-root';
export const ASSISTANT_PERSISTENT_SELECTORS = ['[data-assistant-surface]', '[data-takeover-bar]'];
export const ASSISTANT_INTERACTIVE_SELECTOR = ASSISTANT_PERSISTENT_SELECTORS.join(', ');
const ASSISTANT_FOCUS_SAFE_SELECTOR = `${ASSISTANT_INTERACTIVE_SELECTOR}, [data-agent-confirm-card]`;

export interface OverlayOpenChangeDetails {
  reason?: string;
  event?: Event;
  cancel?: () => void;
}

export function isFocusInsideAssistant(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return active instanceof Element && Boolean(active.closest(ASSISTANT_FOCUS_SAFE_SELECTOR));
}

/**
 * Prevent Popover / Combobox / MultiCombobox from auto-closing on `focus-out` when
 * focus moves to (or is restored to) the AI assistant surface or takeover pause bar.
 * Note: Popover emits a `focusin` event (destination in `event.target`), while
 * Combobox / MultiCombobox emit a `focusout` event (destination in `event.relatedTarget`).
 */
export function shouldCancelAssistantFocusOut(
  details: OverlayOpenChangeDetails | undefined,
  keepAssistantInteractive: boolean,
): boolean {
  if (!keepAssistantInteractive || !details || details.reason !== 'focus-out') return false;
  const ev = details.event;
  let destination: EventTarget | null = null;
  if (ev) {
    if (ev.type === 'focusout' || ev.type === 'blur') {
      destination = (ev as FocusEvent).relatedTarget;
    } else {
      destination = ev.target;
    }
  }
  if (!destination && typeof document !== 'undefined') {
    destination = document.activeElement;
  }
  return destination instanceof Element && Boolean(destination.closest(ASSISTANT_FOCUS_SAFE_SELECTOR));
}

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
