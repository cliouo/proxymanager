'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import type { StoredOperator } from '@/ui/data/types';
import { isNamingStep } from '@/ui/pipeline/model';
import { Button, Card, confirmAction, EmptyState } from '@/ui/primitives';

export async function guardNamingNavigation(event: { preventDefault: () => void }, dirty: boolean, navigate: () => void) {
  if (!dirty) return;
  event.preventDefault();
  if (await confirmAction({ title: '离开前不保存修改？', description: '处理流程有未保存的修改，离开后会丢失。',
    confirmText: '放弃修改并离开', cancelText: '留下', tone: 'danger' })) navigate();
}

export function NamingLink({ href, setup = false, dirty = false }: { href: string; setup?: boolean; dirty?: boolean }) {
  const router = useRouter();
  return <Button asChild variant={setup ? 'accent' : 'secondary'}>
    <Link href={href} onNavigate={(event) => void guardNamingNavigation(event, dirty, () => router.push(href))}>
      <Sparkles size={14} strokeWidth={1.75} />{setup ? '启用智能命名' : '智能命名'}
    </Link>
  </Button>;
}

export function NamingSetupPrompt({ href, operators, dirty = false }: { href: string; operators: StoredOperator[]; dirty?: boolean }) {
  if (operators.some(isNamingStep)) return null;
  return <Card className="mb-4">
    <EmptyState compact icon={Sparkles} title="还没有智能命名步骤"
      description="统一整理节点名称中的地区、线路和序号。在命名工作台中预览并应用方案。"
      actions={<NamingLink href={href} setup dirty={dirty} />} />
  </Card>;
}
