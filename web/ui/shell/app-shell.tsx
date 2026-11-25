'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  Dialog as UiDialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@ui-sdk/react/dialog';
import { AnimatePresence, motion } from 'motion/react';
import { Menu as MenuIcon, Search, Sparkles } from 'lucide-react';
import { AgentHost } from '@/ui/agent';
import { AssistantPanel } from '@/ui/assistant/panel';
import { navigateWithGuard } from '@/ui/features/groups/guard';
import { FeedbackHost } from '@/ui/primitives';
import { LogoMark } from '@/ui/viz/logo';
import { ActivityBar } from './activity-bar';
import { CommandPalette } from './command-palette';
import { useHotkey } from './hotkeys';
import { ShareDialog } from './share-dialog';
import { Sidebar, SidebarContent } from './sidebar';
import { ActiveLineColors, profilePath, useActiveProfile } from './scope';
import { hydrateUiFromStorage, openAssistant, openPalette, setUi, useUi } from './state';

function MobileBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b border-line bg-canvas/85 px-3 backdrop-blur lg:hidden">
      <UiDialog open={open} onOpenChange={(next) => setOpen(next)}>
        <DialogTrigger
          aria-label="打开导航"
          className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface"
        >
          <MenuIcon size={18} />
        </DialogTrigger>
        <DialogBackdrop className="fixed inset-0 z-50 bg-overlay data-open:animate-fade-in" />
        <DialogContent className="fixed inset-y-0 left-0 z-50 m-0 w-[280px] max-w-[85vw] border-r border-line bg-canvas p-0 text-ink shadow-xl outline-none data-open:animate-[slide-in-left_0.3s_var(--ease-out-expo)_both]">
          <DialogTitle className="sr-only">导航</DialogTitle>
          <DialogDescription className="sr-only">在页面之间切换</DialogDescription>
          <SidebarContent collapsed={false} onNavigate={() => setOpen(false)} />
        </DialogContent>
      </UiDialog>
      <LogoMark size={20} />
      <div className="flex-1" />
      <UiButton
        type="button"
        aria-label="搜索"
        onClick={openPalette}
        className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface"
      >
        <Search size={17} />
      </UiButton>
      <UiButton
        type="button"
        data-agent-hidden
        aria-label="AI 助手"
        onClick={() => openAssistant()}
        className="flex size-8 items-center justify-center rounded-md text-accent hover:bg-surface"
      >
        <Sparkles size={17} />
      </UiButton>
    </div>
  );
}

function GlobalHotkeys() {
  const router = useRouter();
  const profile = useActiveProfile();
  const p = (sub?: string) => (profile ? profilePath(profile.name, sub) : '/');
  const go = (href: string) => void navigateWithGuard(() => router.push(href));
  useHotkey('mod+k', () => setUi((s) => ({ paletteOpen: !s.paletteOpen })));
  useHotkey('mod+j', () => setUi((s) => ({ assistantOpen: !s.assistantOpen })));
  useHotkey('mod+\\', () => setUi((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })));
  useHotkey('g o', () => go(p()));
  useHotkey('g g', () => go(p('groups')));
  useHotkey('g r', () => go(p('rules')));
  useHotkey('g d', () => go(p('devices')));
  useHotkey('g b', () => go(p('base')));
  useHotkey('g s', () => go('/sources'));
  useHotkey('g h', () => go('/history'));
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const assistantOpen = useUi((s) => s.assistantOpen);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    hydrateUiFromStorage();
    const media = window.matchMedia('(min-width: 1280px)');
    const sync = () => setWide(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  const docked = assistantOpen && wide;

  useEffect(() => {
    setUi({ assistantDocked: docked });
  }, [docked]);

  return (
    <ActiveLineColors>
      <div className="flex min-h-dvh bg-canvas">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
          <MobileBar />
          <div className="flex min-h-0 flex-1 gap-2">
            <main
              id="main"
              className="relative min-w-0 flex-1 overflow-hidden bg-panel lg:h-[calc(100dvh-16px)] lg:rounded-2xl lg:border lg:border-line lg:shadow-sm"
            >
              <ActivityBar />
              <div id="scroll-root" className="@container/main h-full overflow-y-auto overflow-x-hidden">
                {children}
              </div>
              <div id="main-overlay-root" className="pointer-events-none absolute inset-0 z-50" />
            </main>
            <AnimatePresence initial={false}>
              {docked && (
                <motion.aside
                  key="assistant-dock"
                  data-agent-hidden
                  data-assistant-surface
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 420, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.42 }}
                  className="relative z-[60] hidden h-[calc(100dvh-16px)] shrink-0 overflow-hidden xl:block"
                >
                  <div className="h-full w-[420px] overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
                    <AssistantPanel onClose={() => setUi({ assistantOpen: false })} />
                  </div>
                </motion.aside>
              )}
            </AnimatePresence>
          </div>
        </div>
        {!wide && (
          <div data-agent-hidden data-assistant-surface>
            {/* Non-modal so the main page stays interactive while the assistant operates it on narrow screens. */}
            <UiDialog
              modal={false}
              open={assistantOpen}
              onOpenChange={(open) => setUi({ assistantOpen: open })}
            >
              <DialogContent
                inline
                data-agent-hidden
                data-assistant-surface
                className="fixed bottom-2 right-2 top-2 z-[60] m-0 w-[min(440px,calc(100vw-16px))] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl outline-none data-open:animate-[slide-in-right_0.38s_var(--ease-out-expo)_both]"
              >
                <DialogTitle className="sr-only">AI 助手</DialogTitle>
                <DialogDescription className="sr-only">用自然语言查看和修改配置</DialogDescription>
                <AssistantPanel onClose={() => setUi({ assistantOpen: false })} />
              </DialogContent>
            </UiDialog>
          </div>
        )}
        <CommandPalette />
        <ShareDialog />
        <FeedbackHost />
        <AgentHost />
        <GlobalHotkeys />
      </div>
    </ActiveLineColors>
  );
}
