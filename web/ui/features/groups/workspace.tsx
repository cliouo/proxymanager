'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LayoutTemplate } from 'lucide-react';
import { useGroupTemplates, useRuleSummary } from '@/ui/data/hooks';
import { cn } from '@/ui/lib/cn';
import { Button } from '@/ui/primitives';
import { Page, PageHeader } from '@/ui/shell/page';
import { useScope } from '@/ui/shell/scope';
import { WorkspaceContext, type WorkspaceValue } from './context';
import { CreateGroupDialog } from './create-dialog';
import { useGroupBook, useNodeCatalog } from './data';
import { GroupList } from './group-list';
import { confirmLeave } from './guard';
import { frontPoolNames, sourceLabel } from './model';
import { TemplatesSheet } from './templates-sheet';

export function GroupsWorkspace({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const searchParams = useSearchParams();
  const { profile, profileId, path } = useScope();
  const book = useGroupBook(profileId);
  const summary = useRuleSummary(profileId);
  const templates = useGroupTemplates();
  const catalog = useNodeCatalog(profile);
  const [createOpen, setCreateOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const selectedId = params?.id ? decodeURIComponent(params.id) : null;
  const groups = useMemo(() => book.data?.groups ?? [], [book.data]);
  const groupNames = useMemo(() => new Set(groups.map((g) => g.name)), [groups]);
  const summaryCtx = useMemo(() => ({ catalog, groupNames, subsById: catalog.subsById }), [catalog, groupNames]);
  const frontPools = useMemo(() => frontPoolNames(groups), [groups]);

  const brokenBindings = useMemo(() => {
    const out = new Map<string, string>();
    for (const g of groups) {
      if (g.kind !== 'single-sub' || !g.bound_subscription_id) continue;
      const sub = catalog.subsById.get(g.bound_subscription_id);
      if (!catalog.sources) continue;
      if (!sub) out.set(g.id, '绑定的订阅源已经不存在');
      else if (!sub.enabled) out.set(g.id, `订阅源「${sourceLabel(sub)}」已停用`);
      else if (catalog.profileSubIds && !catalog.profileSubIds.has(sub.id))
        out.set(g.id, `「${sourceLabel(sub)}」不是这份配置的节点来源`);
      else if (catalog.bySub && (catalog.bySub[sub.name] ?? []).length === 0)
        out.set(g.id, `订阅源「${sourceLabel(sub)}」现在没有可用节点`);
    }
    return out;
  }, [groups, catalog]);

  const hrefFor = useCallback((id: string | null) => (id ? path(`groups/${id}`) : path('groups')), [path]);
  const select = useCallback(
    async (id: string | null, options?: { force?: boolean }) => {
      if (!options?.force && !(await confirmLeave())) return;
      router.push(hrefFor(id));
    },
    [router, hrefFor],
  );

  const wantsNew = searchParams.get('new') === '1';
  const closeCreate = (open: boolean) => {
    if (open) return;
    setCreateOpen(false);
    if (wantsNew) router.replace(pathname);
  };

  const value: WorkspaceValue = {
    profile,
    profileId,
    path,
    book,
    groups,
    ruleCounts: summary.data?.policies ?? {},
    rulesLoaded: !!summary.data,
    catalog,
    summaryCtx,
    templates: templates.data,
    frontPools,
    brokenBindings,
    selectedId,
    hrefFor,
    select,
    openCreate: () => setCreateOpen(true),
    openTemplates: () => setTemplatesOpen(true),
  };

  const selected = groups.find((g) => g.id === selectedId);

  return (
    <WorkspaceContext.Provider value={value}>
      <Page width="wide">
        <PageHeader
          title="策略组"
          documentTitle={selected ? `${selected.name} · 策略组` : '策略组'}
          description="每个策略组是一条线路：规则把流量送上线路，线路再从成员里挑出具体节点。"
          actions={
            <Button icon={LayoutTemplate} onClick={() => setTemplatesOpen(true)}>
              模版
            </Button>
          }
          className={cn(selectedId && '@max-3xl/main:hidden')}
        />
        <div className={cn('grid items-start gap-6 @3xl/main:grid-cols-[340px_minmax(0,1fr)]', selectedId && '@max-3xl/main:pt-5')}>
          <aside className={cn('min-w-0 @3xl/main:sticky @3xl/main:top-4', selectedId && '@max-3xl/main:hidden')}>
            <GroupList />
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </Page>
      <CreateGroupDialog open={createOpen || wantsNew} onOpenChange={closeCreate} />
      <TemplatesSheet open={templatesOpen} onOpenChange={setTemplatesOpen} />
    </WorkspaceContext.Provider>
  );
}
