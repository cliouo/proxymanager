'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { clearAdminKey } from '@/lib/client/auth-storage';
import { setupNeedsAttention } from '@/lib/client/setup';
import { useSetup } from '@/components/setup/SetupContext';

export function SetupGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { status, loading, error, refresh } = useSetup();
  const onSetupRoute = pathname === '/setup' || pathname.startsWith('/setup/');
  const shouldRedirect = Boolean(status && setupNeedsAttention(status) && !onSetupRoute);

  useEffect(() => {
    if (shouldRedirect) router.replace('/setup');
  }, [router, shouldRedirect]);

  if (onSetupRoute) return children;

  if (error) {
    return (
      <SetupBoundary
        title="无法确认实例状态"
        detail="当前没有执行任何写入。请重试状态检查，确认后才会开放配置入口。"
        error={error}
        onRetry={() => void refresh()}
      />
    );
  }

  if (loading || !status || shouldRedirect) {
    return (
      <SetupBoundary
        title={shouldRedirect ? '需要先完成首次设置' : '正在检查实例状态'}
        detail={
          shouldRedirect
            ? '正在转到安全初始化向导。'
            : '正在读取真实 profile、base、策略组与规则记录。'
        }
        busy
      />
    );
  }

  return children;
}

function SetupBoundary({
  title,
  detail,
  error,
  busy,
  onRetry,
}: {
  title: string;
  detail: string;
  error?: string;
  busy?: boolean;
  onRetry?: () => void;
}) {
  function signOut() {
    clearAdminKey();
    window.location.href = '/login';
  }

  return (
    <main
      id="main-content"
      className="app"
      style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}
      aria-busy={busy || undefined}
    >
      <section
        className="panel"
        style={{ width: 'min(520px, 100%)' }}
        role={error ? 'alert' : 'status'}
        aria-live={error ? 'assertive' : 'polite'}
      >
        <div className="panel-body">
          <span className={`pill ${error ? 'err' : busy ? 'idle' : 'warn'}`}>
            {error ? '读取失败' : busy ? '检查中' : '需要设置'}
          </span>
          <h1 style={{ margin: '16px 0 8px', fontSize: 24 }}>{title}</h1>
          <p style={{ margin: 0, color: 'var(--muted)' }}>{detail}</p>
          {error && (
            <p
              style={{
                margin: '14px 0 0',
                color: 'var(--danger)',
                overflowWrap: 'anywhere',
              }}
            >
              {error}
            </p>
          )}
          {(onRetry || error) && (
            <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
              {onRetry && (
                <button type="button" className="btn primary" onClick={onRetry}>
                  重新检查
                </button>
              )}
              {error && (
                <button type="button" className="btn" onClick={signOut}>
                  退出登录
                </button>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
