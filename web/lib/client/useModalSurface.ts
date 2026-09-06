'use client';
import { useEffect, useRef, type RefObject } from 'react';

const stack: HTMLElement[] = [];
const restored = new Map<HTMLElement, boolean>();
let bodyOverflow = '';
const focusables = (el: HTMLElement) =>
  [
    ...el.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'),
  ].filter(
    (node) =>
      !node.matches(':disabled, [tabindex="-1"]') &&
      !node.closest('[inert]') &&
      node.getClientRects().length > 0,
  );

function updateBackground() {
  for (const [node, inert] of restored) node.inert = inert;
  restored.clear();
  const top = stack.at(-1);
  if (!top) {
    document.body.style.overflow = bodyOverflow;
    return;
  }
  for (let node: HTMLElement | null = top; node?.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (
        sibling === node ||
        !(sibling instanceof HTMLElement) ||
        sibling.hasAttribute('data-modal-backdrop')
      )
        continue;
      restored.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    if (node.parentElement === document.body) break;
  }
}

/** Modal behavior without remounting editor/stream state or moving desktop sidebars. */
export function useModalSurface(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  media?: string,
) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const mq = media ? matchMedia(media) : null;
    let release: (() => void) | undefined;
    const sync = () => {
      release?.();
      release = undefined;
      const modalMode = !mq || mq.matches;
      element.inert = modalMode && !open;
      if (!open || !modalMode) return;
      const previous =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const previousRole = element.getAttribute('role');
      if (!stack.length) bodyOverflow = document.body.style.overflow;
      stack.push(element);
      document.body.style.overflow = 'hidden';
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', 'true');
      element.tabIndex = -1;
      updateBackground();
      const focus = () => (focusables(element)[0] ?? element).focus();
      focus();
      const onKey = (event: KeyboardEvent) => {
        if (stack.at(-1) !== element) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          close.current();
        }
        if (event.key === 'Tab') {
          const nodes = focusables(element);
          const index = nodes.indexOf(document.activeElement as HTMLElement);
          if (!nodes.length) {
            event.preventDefault();
            element.focus();
          } else if (event.shiftKey && index <= 0) {
            event.preventDefault();
            nodes.at(-1)!.focus();
          } else if (!event.shiftKey && (index < 0 || index === nodes.length - 1)) {
            event.preventDefault();
            nodes[0].focus();
          }
        }
      };
      const onFocus = (event: FocusEvent) => {
        if (stack.at(-1) === element && !element.contains(event.target as Node)) focus();
      };
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('focusin', onFocus);
      release = () => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('focusin', onFocus);
        stack.splice(stack.indexOf(element), 1);
        element.removeAttribute('aria-modal');
        if (previousRole) element.setAttribute('role', previousRole);
        else element.removeAttribute('role');
        updateBackground();
        if (previous?.isConnected && !previous.closest('[inert]')) previous.focus();
      };
    };
    sync();
    mq?.addEventListener('change', sync);
    return () => {
      release?.();
      mq?.removeEventListener('change', sync);
      element.inert = false;
    };
  }, [ref, open, media]);
}
