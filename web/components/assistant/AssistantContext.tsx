'use client';

/**
 * Tiny context that lifts the assistant drawer's open/closed state out of
 * AssistantPanel so the v2 topbar `.ai-fab` button can toggle it. The panel
 * stays always-mounted (its in-flight stream survives close), the trigger now
 * lives in the topbar instead of a floating FAB.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface AssistantCtx {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<AssistantCtx | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo<AssistantCtx>(
    () => ({ open, setOpen, toggle: () => setOpen((v) => !v) }),
    [open],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistant must be used within <AssistantProvider>');
  return ctx;
}
