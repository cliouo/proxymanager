'use client';

import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import type { StoredOperator } from '@/ui/data/types';
import { isNamingStep } from '@/ui/pipeline/model';
import { Button, Card, EmptyState } from '@/ui/primitives';

export function NamingLink({ href, setup = false }: { href: string; setup?: boolean }) {
  return <Button asChild variant={setup ? 'accent' : 'secondary'}>
    <Link href={href}><Sparkles size={14} strokeWidth={1.75} />{setup ? '启用智能命名' : '智能命名'}</Link>
  </Button>;
}

export function NamingSetupPrompt({ href, operators }: { href: string; operators: StoredOperator[] }) {
  if (operators.some(isNamingStep)) return null;
  return <Card className="mb-4">
    <EmptyState compact icon={Sparkles} title="还没有智能命名步骤"
      description="统一整理节点名称中的地区、线路和序号。在命名工作台中预览并应用方案。"
      actions={<NamingLink href={href} setup />} />
  </Card>;
}
