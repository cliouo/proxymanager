'use client';

import { useEffect, useRef } from 'react';
import { isTakeoverLocked } from '@/ui/agent/takeover';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export const modKey = () => (isMac() ? '⌘' : 'Ctrl');

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || !!target.closest('.cm-editor');
}

/**
 * Register a keyboard shortcut. `combo` examples: "mod+k", "g r", "/", "shift+?".
 * Two-key sequences ("g r") fire when the second key follows within 900ms.
 */
export function useHotkey(
  combo: string,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; allowInInput?: boolean; allowDuringTakeover?: boolean } = {},
) {
  const { enabled = true, allowInInput = false, allowDuringTakeover = false } = options;
  const handlerRef = useRef(handler);
  useIsomorphicLayoutEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled) return;
    const parts = combo.toLowerCase().split(' ');
    let stage = 0;
    let timer: number | null = null;

    const matchesStep = (event: KeyboardEvent, step: string) => {
      const keys = step.split('+');
      const key = keys[keys.length - 1];
      const wantMod = keys.includes('mod');
      const wantShift = keys.includes('shift');
      const wantAlt = keys.includes('alt');
      const mod = isMac() ? event.metaKey : event.ctrlKey;
      if (wantMod !== mod) return false;
      if (wantAlt !== event.altKey) return false;
      if (wantShift && !event.shiftKey) return false;
      return event.key.toLowerCase() === key;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!allowDuringTakeover && isTakeoverLocked()) return;
      const hasMod = combo.includes('mod+');
      if (!allowInInput && !hasMod && isTypingTarget(event.target)) return;
      if (matchesStep(event, parts[stage])) {
        if (stage === parts.length - 1) {
          stage = 0;
          if (timer) window.clearTimeout(timer);
          event.preventDefault();
          handlerRef.current(event);
        } else {
          stage++;
          if (timer) window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            stage = 0;
          }, 900);
        }
      } else if (stage > 0 && !['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) {
        stage = 0;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (timer) window.clearTimeout(timer);
    };
  }, [combo, enabled, allowInInput, allowDuringTakeover]);
}
