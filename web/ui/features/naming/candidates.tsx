'use client';

import { Button, Card } from '@/ui/primitives';
import { useState } from 'react';
import { api } from '@/ui/data/api';
import { useQuery } from '@/ui/data/query';
import type { NamingCandidate } from '@/lib/proxies/namingCandidates';
import type { GroupingPreview, GroupingPurpose } from '@/lib/proxies/namingGroupGeneration';
import type { NamingWorkspaceData, TargetType } from './model';
import { candidateRationale, groupingPreviewMatches, groupingSelection, toggleGroupingPurpose } from './model';

export function NamingCandidates({ type, id, version, busy, onApply }: {
  type: TargetType; id: string; version: number; busy: boolean;
  onApply: (template: string, groupingPurposes?: GroupingPurpose[]) => Promise<void>;
}) {
  const query = useQuery<{ configVersion: number; candidates: NamingCandidate[]; groupingAvailable?: boolean }>(
    `naming:${type}:${id}:candidates:${version}`,
    () => api.post(`/naming/${type}/${id}`, { candidates: true, expectedVersion: version }),
  );
  return <Card className="mb-6">
    <h2 className="mb-2 font-semibold">推荐方案</h2>
    <p className="mb-4 text-sm text-ink-3">根据真实节点和所有消费此来源的配置文件生成。应用时使用已保存的识别规则与事实，一并迁移可恢复原节点集合的筛选与一对一引用；不会包含编辑器内未保存的修改。{query.data?.groupingAvailable ? '尚无策略组的配置文件可按用途生成命名和策略组。' : '下方命名方案不会创建策略组。'}</p>
    {query.data?.groupingAvailable && <GroupingPicker key={`${type}:${id}:${version}`} type={type} id={id} version={version} busy={busy} onApply={onApply} />}
    {!!query.error && <p role="alert" className="text-bad">推荐方案加载失败，请刷新页面重试。</p>}
    {!query.data && !query.error && <p className="text-ink-3">正在分析策略组与节点命名…</p>}
    <div className="grid gap-4 @3xl/main:grid-cols-3">
      {query.data?.candidates.map((candidate, index) => <div key={candidate.id} className="min-w-0 rounded-lg border border-line p-3">
        <h3 className="font-medium">{candidate.title}{index === 0 && <span className="ml-2 text-xs text-accent">优先推荐</span>}</h3>
        <p className="my-2 text-xs text-ink-3">{index === 0 ? '推荐理由：' : '方案说明：'}{candidateRationale(candidate)}</p>
        {candidate.emptiedGroups.length > 0 && <p className="my-2 text-xs text-bad">应用后 {candidate.emptiedGroups.length} 个策略组将变空，无法自动恢复筛选。</p>}
        <div className="my-2 max-h-40 overflow-auto break-words text-xs text-ink-2">
          {candidate.sample.map((name, i) => <div key={i}>{name}</div>)}
          {candidate.sample.length === 0 && <div>无可预览节点</div>}
        </div>
        <details className="my-3 text-xs">
          <summary>策略组影响（{candidate.groups.length} 组）</summary>
          {!candidate.groups.length && <p className="text-ink-3">没有需要迁移的策略组。</p>}
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

function GroupingPicker({ type, id, version, busy, onApply }: {
  type: TargetType; id: string; version: number; busy: boolean;
  onApply: (template: string, purposes?: GroupingPurpose[]) => Promise<void>;
}) {
  const [selection, setSelection] = useState<GroupingPurpose[] | null>(null);
  const query = useQuery<GroupingPreview>(`naming:${type}:${id}:grouping:${version}:${selection?.join(',') ?? 'default'}`,
    () => api.post(`/naming/${type}/${id}`, { grouping: selection === null ? {} : { purposes: selection }, expectedVersion: version }), { keepPrevious: true });
  const preview = query.data;
  const selected = groupingSelection(selection, preview);
  const loading = !groupingPreviewMatches(preview, selected) || query.isValidating;
  return <div className="mb-4 rounded-lg border border-line p-3">
    <h3 className="font-medium">按用途生成策略组</h3>
    <p className="my-2 text-xs text-ink-3">只为尚无策略组的消费配置文件创建；已有策略组仅做必要的引用迁移。命名与策略组同时保存，可一起撤销。</p>
    {!!query.error && <p role="alert" className="text-bad">分组预览加载失败，请刷新重试。</p>}
    <div className="my-3 flex flex-wrap gap-2">{preview?.purposes.map((p) => <label key={p.id} className="rounded-full border border-line px-3 py-1 text-sm">
      <input type="checkbox" className="mr-1" checked={selected.includes(p.id)} disabled={busy || p.count === 0}
        onChange={(event) => {
          const checked = event.target.checked;
          setSelection((current) => toggleGroupingPurpose(groupingSelection(current, preview), p.id, checked));
        }} />
      {p.label} · {p.count}
    </label>)}</div>
    <div aria-busy={loading}>
    {loading && !query.error && <p className="text-ink-3">正在生成分组预览…</p>}
    {!loading && preview && <code className="my-2 block break-all text-xs text-ink-3">{preview.template}</code>}
    {!loading && preview?.profiles.map((profile, i) => <div key={i} className="my-3 text-sm"><h4 className="font-medium">{profile.name}</h4>
      {profile.groups.map((group) => <div key={group.name} className="my-2"><p>{group.name} · {group.count} 节点{group.kind === 'single-sub' && ' · 订阅绑定'}</p>
        <p className="break-words text-xs text-ink-3">{group.sample.join(' / ')}</p></div>)}
    </div>)}
    {!loading && preview?.warnings.map((warning, i) => <p key={i} className="text-xs text-bad">{warning}</p>)}
    </div>
    <Button disabled={busy || loading || !!query.error || !preview || preview.blocked || !selected.length || preview.configVersion !== version}
      onClick={() => preview && void onApply(preview.template, selected)}>生成命名和策略组</Button>
  </div>;
}

export function applyNamingCandidate(type: TargetType, id: string, template: string, expectedVersion: number, groupingPurposes?: GroupingPurpose[]) {
  return api.post<NamingWorkspaceData>(`/naming/${type}/${id}`, { apply: { template, ...(groupingPurposes ? { groupingPurposes } : {}) }, expectedVersion, migrateGroups: true });
}
