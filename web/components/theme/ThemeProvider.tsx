'use client';

import { ThemeProvider as NextThemeProvider } from 'next-themes';

/**
 * v2「Signal Console」主题载体。
 *
 * - attribute="data-theme" → 写 <html data-theme="light|dark">，与 globals.css
 *   的 :root（浅色默认）/ :root[data-theme="dark"]（深色覆盖）契合。
 * - defaultTheme="light" + enableSystem → 三态 light / dark / system，默认浅色。
 * - next-themes 自带 beforeInteractive 注入脚本，绘制前套用偏好，杜绝 FOUC。
 *
 * 必须配合根 layout 的 <html suppressHydrationWarning>（已就绪）。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemeProvider
      attribute="data-theme"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
      themes={['light', 'dark']}
      storageKey="pm-theme"
    >
      {children}
    </NextThemeProvider>
  );
}
