'use client';

import Link from 'next/link';
import { Compass } from 'lucide-react';
import { useProfiles } from '@/ui/data/hooks';
import { Button, EmptyState, Skeleton } from '@/ui/primitives';
import { Page } from '@/ui/shell/page';
import { ScopeProvider, useRouteProfileName } from '@/ui/shell/scope';

export function ProfileLayout({ children }: { children: React.ReactNode }) {
  const name = useRouteProfileName();
  const { data: profiles } = useProfiles();

  if (!profiles) {
    return (
      <Page>
        <div className="flex flex-col gap-3 pt-10">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-6 h-40 w-full" />
        </div>
      </Page>
    );
  }

  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    return (
      <Page>
        <EmptyState
          className="pt-24"
          icon={Compass}
          title={`找不到配置文件「${name}」`}
          description="它可能已被改名或删除。"
          actions={
            <Button asChild variant="primary">
              <Link href="/profiles">查看全部配置文件</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <ScopeProvider key={profile.id} profile={profile} profiles={profiles}>
      {children}
    </ScopeProvider>
  );
}
