'use client';

import { ThemeProvider, useTheme } from 'next-themes';
import { MotionConfig } from 'motion/react';
import { Tooltip } from 'radix-ui';
import { Toaster } from 'sonner';

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      position="bottom-right"
      gap={10}
      offset={20}
      toastOptions={{
        classNames: {
          toast:
            '!rounded-xl !border !border-line !bg-surface !text-ink !shadow-lg !font-sans !text-sm',
          description: '!text-ink-2 !text-xs',
          actionButton: '!bg-inverse !text-inverse-ink !rounded-md !text-xs !font-medium',
          cancelButton: '!bg-surface-2 !text-ink-2 !rounded-md !text-xs',
        },
      }}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user" transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}>
        <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
          {children}
          <ThemedToaster />
        </Tooltip.Provider>
      </MotionConfig>
    </ThemeProvider>
  );
}
