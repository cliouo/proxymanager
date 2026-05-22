import type { Metadata } from 'next';
import { Inter, Noto_Sans_SC, JetBrains_Mono, Fraunces } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

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

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  axes: ['opsz', 'SOFT'],
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
    <html
      lang="zh-CN"
      className={`${inter.variable} ${notoSC.variable} ${jetbrains.variable} ${fraunces.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
