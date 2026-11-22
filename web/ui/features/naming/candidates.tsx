'use client';

import { Button, Card } from '@/ui/primitives';
import { api } from '@/ui/data/api';
import { useQuery } from '@/ui/data/query';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';
import type { NamingWorkspaceData, TargetType } from './model';

export function NamingCandidates({ type, id, version, busy, onApply }: {
  type: TargetType; id: string; version: number; busy: boolean;
  onApply: (template: string) => Promise<void>;
}) {
  const query = useQuery<{ configVersion: number; candidates: NamingCandidate[] }>(
    `naming:${type}:${id}:candidates:${version}`,
    () => api.post(`/naming/${type}/${id}`, { candidates: true, expectedVersion: version }),
  );
  return <Card className="mb-6">
    <h2 className="mb-2 font-semibold">推荐方案</h2>
    <p className="mb-4 text-sm text-ink-3">根据真实节点和所有消费此来源的配置文件生成。应用时使用已保存的识别规则与事实，一并迁移可恢复原节点集合的筛选与一对一引用；不会包含编辑器内未保存的修改，也不会创建策略组。</p>
    {!!query.error && <p role="alert" className="text-bad">推荐方案加载失败，请刷新页面重试。</p>}
    {!query.data && !query.error && <p className="text-ink-3">正在分析策略组与节点命名…</p>}
    <div className="grid gap-4 @3xl/main:grid-cols-3">
      {query.data?.candidates.map((candidate) => <div key={candidate.id} className="min-w-0 rounded-lg border border-line p-3">
        <h3 className="font-medium">{candidate.title}</h3>
        {candidate.emptiedGroups.length > 0 && <p className="my-2 text-xs text-bad">应用后 {candidate.emptiedGroups.length} 个策略组将变空，无法自动恢复筛选。</p>}
        <div className="my-2 max-h-40 overflow-auto break-words text-xs text-ink-2">
          {candidate.sample.map((name, i) => <div key={i}>{name}</div>)}
          {candidate.sample.length === 0 && <div>无可预览节点</div>}
        </div>
        <details className="my-3 text-xs">
          <summary>策略组影响（{candidate.groups.length} 组）</summary>
          {!candidate.groups.length && <p className="text-ink-3">没有策略组，无需生成或迁移。</p>}
          {candidate.groups.map((group) => <div key={`${group.profileId}:${group.groupId}`} className={group.emptied || group.broken ? 'text-bad' : 'text-ink-2'}>
            {group.profileName} / {group.groupName}: {group.before} → {group.migration?.after ?? group.after}
            {group.emptied && ' · 将变空'}
            {group.broken && !group.emptied && ' · 筛选无法恢复原节点集合'}
            {group.error && <p className="text-bad">{group.error}</p>}
            {group.migration && <div className="break-all text-ink-3">筛选将迁移：<code>{group.migration.filter}</code></div>}
          </div>)}
        </details>
        {candidate.references.length > 0 && <details className="my-2 text-xs"><summary>精确引用（{candidate.references.length}）</summary>
          {candidate.references.map((ref, i) => <p key={i} className={ref.blocked ? 'text-bad' : 'text-ink-3'}>{ref.kind}: {ref.before} → {ref.after ?? '无法唯一映射'}{ref.blocked && ' · 需手动处理'}</p>)}
        </details>}
        {candidate.warnings.map((warning, i) => <p key={i} className="my-1 text-xs text-warn">{warning}</p>)}
        <Button disabled={busy || candidate.blocked || query.data?.configVersion !== version} onClick={() => void onApply(candidate.template)}>应用</Button>
      </div>)}
    </div>
  </Card>;
}

export function applyNamingCandidate(type: TargetType, id: string, template: string, expectedVersion: number) {
  return api.post<NamingWorkspaceData>(`/naming/${type}/${id}`, { apply: { template }, expectedVersion, migrateGroups: true });
}
