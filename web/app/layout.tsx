import type { Metadata } from 'next';
import { Noto_Sans_SC, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/theme/ThemeProvider';

const notoSC = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-noto-sc',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ProxyManager · 代理订阅管家',
  description: '个人代理订阅与配置管理（Sub-Store 替代）',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. 沉浸式翻译 /
    // Immersive Translate) inject attributes like
    // data-immersive-translate-page-theme onto <html>/<body> before React
    // hydrates. This tolerates that top-level attribute mismatch only; it
    // does not affect descendants.
    <html
      lang="zh-CN"
      className={`${notoSC.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body suppressHydrationWarning>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
