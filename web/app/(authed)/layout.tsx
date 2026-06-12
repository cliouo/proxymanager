'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AssistantProvider } from '@/components/assistant/AssistantContext';
import { AssistantPanel } from '@/components/assistant/AssistantPanel';
import { PageChromeProvider, usePageChrome } from '@/components/PageChrome';
import { ProfilesProvider } from '@/components/profile/ProfileContext';
import { RouteProgress } from '@/components/RouteProgress';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { getAdminKey } from '@/lib/client/auth-storage';

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    if (!getAdminKey()) {
      const next = window.location.pathname + window.location.search;
      window.location.href = `/login?next=${encodeURIComponent(next)}`;
      return;
    }
    setReady(true);
  }, []);

  // 路由切换后收起移动端抽屉。
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // ESC 关抽屉；跨断点（≥961px）回到固定栏时复位 open 态。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setNavOpen(false);
    }
    const mq = window.matchMedia('(min-width: 961px)');
    function onWide(e: MediaQueryListEvent) {
      if (e.matches) setNavOpen(false);
    }
    document.addEventListener('keydown', onKey);
    mq.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onWide);
    };
  }, []);

  if (!ready) {
    return (
      <main className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="pm-pulse" style={{ color: 'var(--muted)', fontSize: 14 }}>
          正在准备工作台 …
        </span>
      </main>
    );
  }

  // 全屏工作台页（编辑器 / 渲染产物）自管高度，escape .content 的内边距与 max-width。
  const fill = ['/base', '/config'].some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <ProfilesProvider>
      <PageChromeProvider>
        <AssistantProvider>
          <div className="app">
            <RouteProgress />
            <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
            <div className="main">
              <Topbar onMenu={() => setNavOpen((v) => !v)} />
              <Content fill={fill} pathname={pathname}>
                {children}
              </Content>
            </div>
            <div
              className={`scrim${navOpen ? ' open' : ''}`}
              onClick={() => setNavOpen(false)}
              aria-hidden
            />
            <AssistantPanel />
          </div>
        </AssistantProvider>
      </PageChromeProvider>
    </ProfilesProvider>
  );
}

/** 内容区。页面经 PageChrome 注入 max-width(原型逐页不同)时在此生效。 */
function Content({
  fill,
  pathname,
  children,
}: {
  fill: boolean;
  pathname: string;
  children: React.ReactNode;
}) {
  const chrome = usePageChrome();
  const maxWidth = !fill && chrome?.contentMaxWidth ? chrome.contentMaxWidth : undefined;
  return (
    <main className={`content${fill ? ' fill' : ''}`} style={maxWidth ? { maxWidth } : undefined}>
      {fill ? (
        children
      ) : (
        <div key={pathname} className="pm-reveal">
          {children}
        </div>
      )}
    </main>
  );
}
