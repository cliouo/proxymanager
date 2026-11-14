'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Dialog as RDialog } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import { Menu as MenuIcon, Search, Sparkles } from 'lucide-react';
import { AssistantPanel } from '@/ui/assistant/panel';
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
      <RDialog.Root open={open} onOpenChange={setOpen}>
        <RDialog.Trigger asChild>
          <button type="button" aria-label="打开导航" className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface">
            <MenuIcon size={18} />
          </button>
        </RDialog.Trigger>
        <RDialog.Portal>
          <RDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
          <RDialog.Content className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] border-r border-line bg-canvas shadow-xl data-[state=open]:animate-[slide-in-left_0.3s_var(--ease-out-expo)_both]">
            <RDialog.Title className="sr-only">导航</RDialog.Title>
            <RDialog.Description className="sr-only">在页面之间切换</RDialog.Description>
            <SidebarContent collapsed={false} onNavigate={() => setOpen(false)} />
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
      <LogoMark size={20} />
      <div className="flex-1" />
      <button type="button" aria-label="搜索" onClick={openPalette} className="flex size-8 items-center justify-center rounded-md text-ink-2 hover:bg-surface">
        <Search size={17} />
      </button>
      <button type="button" aria-label="AI 助手" onClick={() => openAssistant()} className="flex size-8 items-center justify-center rounded-md text-accent hover:bg-surface">
        <Sparkles size={17} />
      </button>
    </div>
  );
}

function GlobalHotkeys() {
  const router = useRouter();
  const profile = useActiveProfile();
  const p = (sub?: string) => (profile ? profilePath(profile.name, sub) : '/');
  useHotkey('mod+k', () => setUi((s) => ({ paletteOpen: !s.paletteOpen })));
  useHotkey('mod+j', () => setUi((s) => ({ assistantOpen: !s.assistantOpen })));
  useHotkey('mod+\\', () => setUi((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })));
  useHotkey('g o', () => router.push(p()));
  useHotkey('g g', () => router.push(p('groups')));
  useHotkey('g r', () => router.push(p('rules')));
  useHotkey('g d', () => router.push(p('devices')));
  useHotkey('g b', () => router.push(p('base')));
  useHotkey('g s', () => router.push('/sources'));
  useHotkey('g h', () => router.push('/history'));
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
            </main>
            <AnimatePresence initial={false}>
              {docked && (
                <motion.aside
                  key="assistant-dock"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 420, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ type: 'spring', bounce: 0, duration: 0.42 }}
                  className="hidden h-[calc(100dvh-16px)] shrink-0 overflow-hidden xl:block"
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
          <RDialog.Root open={assistantOpen} onOpenChange={(open) => setUi({ assistantOpen: open })}>
            <RDialog.Portal>
              <RDialog.Overlay className="fixed inset-0 z-50 bg-overlay data-[state=open]:animate-fade-in" />
              <RDialog.Content className="fixed bottom-2 right-2 top-2 z-50 w-[min(440px,calc(100vw-16px))] overflow-hidden rounded-2xl border border-line bg-surface shadow-xl data-[state=open]:animate-[slide-in-right_0.38s_var(--ease-out-expo)_both]">
                <RDialog.Title className="sr-only">AI 助手</RDialog.Title>
                <RDialog.Description className="sr-only">用自然语言查看和修改配置</RDialog.Description>
                <AssistantPanel onClose={() => setUi({ assistantOpen: false })} />
              </RDialog.Content>
            </RDialog.Portal>
          </RDialog.Root>
        )}
        <CommandPalette />
        <ShareDialog />
        <FeedbackHost />
        <GlobalHotkeys />
      </div>
    </ActiveLineColors>
  );
}
