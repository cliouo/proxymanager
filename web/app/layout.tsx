import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ProxyManager',
  description: 'Personal proxy configuration manager (Sub-Store alternative)',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
