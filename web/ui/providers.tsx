'use client';

import { ThemeProvider } from 'next-themes';
import { MotionConfig } from 'motion/react';
import { AppToaster } from '@/ui/primitives/feedback';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user" transition={{ type: 'spring', bounce: 0.18, duration: 0.45 }}>
        {children}
        <AppToaster />
      </MotionConfig>
    </ThemeProvider>
  );
}
