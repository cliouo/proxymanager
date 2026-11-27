'use client';

import { useState, type RefObject } from 'react';
import { useTakeover } from '@/ui/agent/takeover';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { useUi } from '@/ui/shell/state';

export const MAIN_OVERLAY_ROOT_ID = 'main-overlay-root';
const SCROLL_ROOT_ID = 'scroll-root';
const OVERLAY_HIDDEN_ATTR = 'data-agent-overlay-hidden';
const isolatedBackgroundTokens = new Set<symbol>();
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

/**
 * Hide `#scroll-root` from `@ui-sdk` (`data-agent-hidden`) while a workspace Dialog or Sheet
 * is open in a sibling/body portal (such as `#main-overlay-root`). This prevents non-modal
 * overlays (used so the docked AI sidebar stays interactive) from colliding with identical
 * controls rendered in the background editor (e.g. CreateGroupDialog vs GroupEditor).
 */
export function useIsolateBackgroundForAgent(open: boolean, contentRef: RefObject<HTMLElement | null>) {
  useIsomorphicLayoutEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const scrollRoot = document.getElementById(SCROLL_ROOT_ID);
    if (!scrollRoot) return;
    // Never hide `#scroll-root` if the overlay itself is mounted inline inside it (narrow screens).
    if (contentRef.current && scrollRoot.contains(contentRef.current)) return;

    const token = Symbol('overlay-bg-isolation');
    isolatedBackgroundTokens.add(token);
    if (!scrollRoot.hasAttribute('data-agent-hidden')) {
      scrollRoot.setAttribute('data-agent-hidden', 'true');
      scrollRoot.setAttribute(OVERLAY_HIDDEN_ATTR, 'true');
    }

    return () => {
      isolatedBackgroundTokens.delete(token);
      if (isolatedBackgroundTokens.size === 0) {
        const root = document.getElementById(SCROLL_ROOT_ID);
        if (root?.hasAttribute(OVERLAY_HIDDEN_ATTR)) {
          root.removeAttribute('data-agent-hidden');
          root.removeAttribute(OVERLAY_HIDDEN_ATTR);
        }
      }
    };
  }, [open, contentRef]);
}
