'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RefreshCw, WifiOff } from 'lucide-react';
import { clearAdminKey, errorMessage, getAdminKey, request, UNAUTHORIZED_EVENT } from '@/ui/data/api';
import { keys } from '@/ui/data/hooks';
import { clearQueries, setQueryData, useQuery } from '@/ui/data/query';
import type { Profile, SetupApiStatus } from '@/ui/data/types';
import { Button } from '@/ui/primitives';
import { LogoMark } from '@/ui/viz/logo';

export function BootScreen({ label = '正在载入' }: { label?: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas">
      <div className="relative">
        <LogoMark size={40} animated />
        <span className="absolute -inset-3 animate-pulse rounded-2xl bg-accent/5" />
      </div>
      <div className="text-xs tracking-wide text-ink-3">{label}…</div>
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const next = `${window.location.pathname}${window.location.search}`;
    if (!getAdminKey()) {
      router.replace(`/login?next=${encodeURIComponent(next)}`);
      return;
    }
    setReady(true);
    const onUnauthorized = () => {
      clearAdminKey();
      clearQueries();
      router.replace(`/login?expired=1&next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready && !getAdminKey()) router.replace('/login');
  }, [pathname, ready, router]);

  if (!ready) return <BootScreen />;
  return <>{children}</>;
}

interface WorkspaceBootstrap {
  status: SetupApiStatus;
  profiles: Profile[];
}

/** Routes unconfigured instances to the welcome flow and primes the profile list. */
export function SetupGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data, error, refetch, isValidating } = useQuery<WorkspaceBootstrap>(
    'workspace-bootstrap',
    async () => {
      const result = await request<{ data: WorkspaceBootstrap }>('/bootstrap');
      setQueryData(keys.profiles, result.data.profiles);
      setQueryData(keys.setup, result.data.status);
      return result.data;
    },
    { staleTime: 60_000 },
  );

  // Don't act on a cached answer while a fresh one is in flight (e.g. right after bootstrap).
  const needsSetup =
    !isValidating && data && (data.status.state !== 'configured' || data.profiles.length === 0);
  useEffect(() => {
    if (needsSetup) router.replace('/welcome');
  }, [needsSetup, router]);

  if (error && !data) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-ink-3 shadow-sm">
          <WifiOff size={20} />
        </span>
        <div>
          <div className="text-sm font-semibold text-ink">无法连接到后端</div>
          <p className="mt-1 max-w-sm text-xs text-ink-3">{errorMessage(error)}</p>
        </div>
        <Button icon={RefreshCw} loading={isValidating} onClick={() => void refetch()}>
          重试
        </Button>
      </div>
    );
  }
  const looksUnconfigured = data && (data.status.state !== 'configured' || data.profiles.length === 0);
  if (!data || looksUnconfigured) return <BootScreen />;
  return <>{children}</>;
}
