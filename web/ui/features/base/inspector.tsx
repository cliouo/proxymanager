'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  ArrowUpRight,
  CircleAlert,
  CircleCheck,
  CornerDownRight,
  Plus,
  RotateCcw,
  TriangleAlert,
  WandSparkles,
} from 'lucide-react';
import { DataView } from '@/ui/agent';
import type { ConfigIssue } from '@/ui/data/api';
import { errorMessage } from '@/ui/data/api';
import type { Rule, RuleSummary } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Input, Skeleton, Spinner } from '@/ui/primitives';
import { BUILTIN_LABEL, isBuiltinPolicy, PolicyChip } from '@/ui/viz/lines';
import { ruleText } from '@/ui/features/rules/rule-model';
import type { OrphanGroup, Validation } from './use-validation';
import { hasTopKey, SNIPPETS, type Marker, type Snippet } from './yaml-tools';

/* ─── layout atoms ───────────────────────────────────────────────────── */

export function InspectorSection({
  title,
  meta,
  children,
  id,
}: {
  title: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="flex flex-col gap-2.5 py-4 first:pt-1">
      <header className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink-2">{title}</h3>
        {meta && <div className="flex items-center gap-1.5 text-2xs text-ink-3">{meta}</div>}
      </header>
      {children}
    </section>
  );
}

function IssueCard({
  tone = 'bad',
  title,
  body,
  action,
  children,
}: {
  tone?: 'bad' | 'warn';
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5',
        tone === 'bad' ? 'border-bad/20 bg-bad-soft/60' : 'border-warn/25 bg-warn-soft/60',
      )}
    >
      <div className="flex items-start gap-2">
        {tone === 'bad' ? (
          <CircleAlert size={14} className="mt-[3px] shrink-0 text-bad" />
        ) : (
          <TriangleAlert size={14} className="mt-[3px] shrink-0 text-warn" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-5 text-ink">{title}</div>
          {body && <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{body}</p>}
        </div>
      </div>
      {children && <div className="mt-2 pl-[22px]">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap gap-1.5 pl-[22px]">{action}</div>}
    </div>
  );
}

const mono = 'font-mono text-[11.5px]';

function RuleList({ rules }: { rules: Array<{ id: string; rule?: Rule }> }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rules : rules.slice(0, 3);
  return (
    <ul className="flex flex-col gap-1">
      {shown.map(({ id, rule }) => (
        <li key={id} className={cn('flex min-w-0 items-center gap-1.5 text-ink-2', mono)}>
          <CornerDownRight size={11} className="shrink-0 text-ink-4" />
          <span className={cn('truncate', rule?.enabled === false && 'text-ink-4 line-through')} title={rule ? ruleText(rule) : id}>
            {rule ? ruleText(rule) : `规则 ${id.slice(0, 8)}`}
          </span>
        </li>
      ))}
      {rules.length > 3 && (
        <li>
          <UiButton type="button" onClick={() => setOpen((v) => !v)} className="text-2xs font-medium text-accent hover:underline">
            {open ? '收起' : `还有 ${rules.length - 3} 条`}
          </UiButton>
        </li>
      )}
    </ul>
  );
}

/* ─── 校验 ───────────────────────────────────────────────────────────── */

export interface ValidationSectionProps {
  validation: Validation;
  groups: OrphanGroup[];
  stale: boolean;
  totalRules: number | undefined;
  missingGroupsMarker: number;
  saveIssues: ConfigIssue[] | null;
  groupsHref: string;
  onReveal: (line: number) => void;
  onRestoreAnchor: (name: string) => void;
  onInsertMarker: (kind: 'rule-providers' | 'proxy-groups') => void;
  findProviderLine: (name: string) => number | null;
}

export function ValidationSection({
  validation,
  groups,
  stale,
  totalRules,
  missingGroupsMarker,
  saveIssues,
  groupsHref,
  onReveal,
  onRestoreAnchor,
  onInsertMarker,
  findProviderLine,
}: ValidationSectionProps) {
  const { status } = validation;
  const checking = status === 'checking';
  const validationSummary =
    status === 'valid' && groups.length === 0 && !missingGroupsMarker
      ? '结构有效'
      : status === 'syntax' && validation.syntax
        ? `第 ${validation.syntax.line} 行语法错误：${validation.syntax.message}`
        : status === 'invalid' && validation.issue
          ? `校验失败：${validation.issue.message}`
          : `${groups.length + (missingGroupsMarker ? 1 : 0)} 个问题`;
  const validationItems = [
    ...(status === 'syntax' && validation.syntax
      ? [{ value: 'syntax', label: `第 ${validation.syntax.line} 行：${validation.syntax.message}` }]
      : []),
    ...(status === 'invalid' && validation.issue ? [{ value: 'invalid', label: validation.issue.message }] : []),
    ...groups.map((g, i) => ({
      value: `orphan-${i}`,
      label:
        g.kind === 'anchor'
          ? `缺失锚点 ${g.name}（影响 ${g.rules.length} 条规则）`
          : g.kind === 'policy'
            ? `缺失策略 ${g.name}（影响 ${g.rules.length} 条规则）`
            : g.kind === 'rule-set'
              ? `缺失规则集 ${g.name}（影响 ${g.rules.length} 条规则）`
              : g.kind === 'literal-rule'
                ? `第 ${g.line} 行手写规则`
                : g.kind === 'literal-provider'
                  ? `手写规则集 ${g.name}`
                  : g.kind === 'providers-marker'
                    ? '缺少 RULE-PROVIDERS 标记'
                    : 'reason' in g
                      ? g.reason
                      : g.kind,
    })),
    ...(missingGroupsMarker > 0 ? [{ value: 'missing-groups', label: `缺少 PROXY-GROUPS 标记（${missingGroupsMarker} 个策略组）` }] : []),
    ...(saveIssues ?? []).map((issue, i) => ({ value: `save-${i}`, label: issue.message })),
  ];

  return (
    <DataView label="基础配置校验" summary={validationSummary} items={validationItems}>
      <InspectorSection
        id="base-validation"
        title="校验"
        meta={
          checking ? (
            <>
              <Spinner size={11} /> 校验中
            </>
          ) : (
            '随输入实时校验'
          )
        }
      >
      {status === 'syntax' && validation.syntax && (
        <IssueCard
          title={`第 ${validation.syntax.line} 行：${validation.syntax.message}`}
          body={validation.syntax.message === '内容为空' ? undefined : '修正语法错误后才能保存。'}
          action={
            <Button size="xs" variant="secondary" icon={ArrowUpRight} onClick={() => onReveal(validation.syntax!.line)}>
              跳到这一行
            </Button>
          }
        >
          {validation.syntax.detail && <p className={cn('break-words text-ink-3', mono)}>{validation.syntax.detail}</p>}
        </IssueCard>
      )}

      {status === 'empty' && <IssueCard tone="warn" title="内容为空" body="基础配置至少需要一个顶层设置和 rules: 锚点。" />}

      {status === 'invalid' && validation.issue && (
        <IssueCard title={validation.issue.message} body="服务器无法解析这份 YAML，修正后才能保存。">
          {validation.issue.path && (
            <p className={cn('text-ink-3', mono)}>
              {Array.isArray(validation.issue.path) ? validation.issue.path.join('.') : validation.issue.path}
            </p>
          )}
        </IssueCard>
      )}

      {status === 'error' && (
        <IssueCard
          tone="warn"
          title="暂时无法校验"
          body={errorMessage(validation.error)}
          action={
            <Button size="xs" variant="secondary" icon={RotateCcw} onClick={validation.retry}>
              重试
            </Button>
          }
        />
      )}

      {checking && !validation.lastResult && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      )}

      {(status === 'valid' || (checking && validation.lastResult?.valid)) && groups.length === 0 && !missingGroupsMarker && (
        <div className={cn('flex items-start gap-2 rounded-lg border border-ok/20 bg-ok-soft/60 px-3 py-2.5 transition-opacity', stale && 'opacity-60')}>
          <CircleCheck size={14} className="mt-[3px] shrink-0 text-ok" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium leading-5 text-ink">结构有效</div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
              {totalRules
                ? `现有 ${totalRules} 条规则都能找到自己的锚点和策略。`
                : '还没有规则；添加规则时会用到这里的锚点。'}
            </p>
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div className={cn('flex flex-col gap-2 transition-opacity', stale && 'opacity-60')}>
          <p className="text-xs leading-relaxed text-ink-2">
            这些规则会失去它们的锚点或策略，现在保存会被拒绝。恢复对应的标记，或先到「规则」页修改它们。
          </p>
          {groups.map((group, index) => (
            <OrphanCard
              key={index}
              group={group}
              groupsHref={groupsHref}
              onReveal={onReveal}
              onRestoreAnchor={onRestoreAnchor}
              onInsertMarker={onInsertMarker}
              findProviderLine={findProviderLine}
            />
          ))}
        </div>
      )}

      {missingGroupsMarker > 0 && (
        <IssueCard
          title="缺少 PROXY-GROUPS 标记"
          body={`这份配置有 ${missingGroupsMarker} 个策略组，渲染时没有地方放，保存会被拒绝。`}
          action={
            <Button size="xs" variant="secondary" icon={WandSparkles} onClick={() => onInsertMarker('proxy-groups')}>
              插入标记
            </Button>
          }
        />
      )}

      {saveIssues && saveIssues.length > 0 && (
        <IssueCard title="上次保存被拒绝" body="保存前会预演最终配置，以下问题阻止了写入：">
          <ul className="flex flex-col gap-1.5">
            {saveIssues.map((issue, index) => (
              <li key={index} className="text-xs leading-relaxed text-ink-2">
                {issue.message}
                {issue.path && (
                  <span className={cn('ml-1 text-ink-3', mono)}>
                    {Array.isArray(issue.path) ? issue.path.join('.') : issue.path}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </IssueCard>
      )}
      </InspectorSection>
    </DataView>
  );
}

function OrphanCard({
  group,
  groupsHref,
  onReveal,
  onRestoreAnchor,
  onInsertMarker,
  findProviderLine,
}: {
  group: OrphanGroup;
  groupsHref: string;
  onReveal: (line: number) => void;
  onRestoreAnchor: (name: string) => void;
  onInsertMarker: (kind: 'rule-providers' | 'proxy-groups') => void;
  findProviderLine: (name: string) => number | null;
}) {
  switch (group.kind) {
    case 'anchor':
      return (
        <IssueCard
          title={
            <>
              锚点 <code className={mono}>{group.name}</code> 不见了
            </>
          }
          body={`${group.rules.length} 条规则会失去插入位置。`}
          action={
            <Button size="xs" variant="secondary" icon={WandSparkles} onClick={() => onRestoreAnchor(group.name)}>
              恢复锚点
            </Button>
          }
        >
          <RuleList rules={group.rules} />
        </IssueCard>
      );
    case 'policy':
      return (
        <IssueCard
          title={
            <>
              策略 <code className={mono}>{group.name}</code> 不存在
            </>
          }
          body={`${group.rules.length} 条规则指向它。在策略组页创建它，或改掉这些规则。`}
          action={
            <Button size="xs" variant="secondary" trailingIcon={ArrowUpRight} asChild>
              <Link href={groupsHref}>去策略组</Link>
            </Button>
          }
        >
          <RuleList rules={group.rules} />
        </IssueCard>
      );
    case 'rule-set':
      return (
        <IssueCard
          title={
            <>
              规则集 <code className={mono}>{group.name}</code> 不在库里
            </>
          }
          body={`${group.rules.length} 条规则引用了它。`}
          action={
            <Button size="xs" variant="secondary" trailingIcon={ArrowUpRight} asChild>
              <Link href="/rule-sets">去规则集</Link>
            </Button>
          }
        >
          <RuleList rules={group.rules} />
        </IssueCard>
      );
    case 'literal-rule':
      return (
        <IssueCard
          title={`第 ${group.line} 行直接写了一条规则`}
          body="规则要在「规则」页管理，rules: 下面只放锚点标记。"
          action={
            <Button size="xs" variant="secondary" icon={ArrowUpRight} onClick={() => onReveal(group.line)}>
              跳到这一行
            </Button>
          }
        >
          {group.text && <p className={cn('truncate text-ink-2', mono)}>{group.text}</p>}
        </IssueCard>
      );
    case 'literal-provider': {
      const line = findProviderLine(group.name);
      return (
        <IssueCard
          title={
            <>
              手写了规则集 <code className={mono}>{group.name}</code>
            </>
          }
          body="规则集要在「规则集」页管理，这里用 RULE-PROVIDERS 标记代替整个 rule-providers: 段。"
          action={
            line ? (
              <Button size="xs" variant="secondary" icon={ArrowUpRight} onClick={() => onReveal(line)}>
                跳到这一行
              </Button>
            ) : undefined
          }
        />
      );
    }
    case 'providers-marker':
      return (
        <IssueCard
          title="缺少 RULE-PROVIDERS 标记"
          body="有规则引用了规则集，但没有地方放它们的声明；客户端会因 not found rule-set 拒绝加载。"
          action={
            <Button size="xs" variant="secondary" icon={WandSparkles} onClick={() => onInsertMarker('rule-providers')}>
              插入标记
            </Button>
          }
        />
      );
    default:
      return <IssueCard title={group.reason} body={group.ids.length > 1 ? `影响 ${group.ids.length} 条规则` : undefined} />;
  }
}

/* ─── 锚点与注入点 ───────────────────────────────────────────────────── */

const ANCHOR_NAME = /^[\w-]+$/;

export function MarkersSection({
  markers,
  summary,
  onReveal,
  onAddAnchor,
}: {
  markers: Marker[];
  summary: RuleSummary | undefined;
  onReveal: (line: number) => void;
  onAddAnchor: (name: string) => void;
}) {
  const anchors = markers.filter((m) => m.kind === 'anchor');
  const present = new Set(anchors.map((a) => a.name));
  const missing = Object.entries(summary?.anchors ?? {}).filter(([name]) => !present.has(name));
  const groupsMarker = markers.find((m) => m.kind === 'proxy-groups');
  const providersMarker = markers.find((m) => m.kind === 'rule-providers');
  const [name, setName] = useState('');
  const nameError = name && !ANCHOR_NAME.test(name) ? '只能用字母、数字、_ 和 -' : name && present.has(name) ? '已经有这个锚点了' : null;

  const add = () => {
    if (!name || nameError) return;
    onAddAnchor(name);
    setName('');
  };

  const markerItems = [
    { value: 'marker:proxy-groups', label: `PROXY-GROUPS：${groupsMarker ? `第 ${groupsMarker.line} 行` : '未放置'}` },
    { value: 'marker:rule-providers', label: `RULE-PROVIDERS：${providersMarker ? `第 ${providersMarker.line} 行` : '未放置'}` },
    ...anchors.map((a) => {
      const c = summary?.anchors[a.name];
      return {
        value: `anchor:${a.name}`,
        label: `锚点 ${a.name}（第 ${a.line} 行${c ? ` · ${c.active} 条规则` : ''}）`,
      };
    }),
    ...missing.map(([anchorName, count]) => ({
      value: `missing:${anchorName}`,
      label: `缺失锚点 ${anchorName}（${count.total} 条规则受影响）`,
    })),
  ];

  return (
    <DataView label="锚点与注入点" summary={`${anchors.length} 个锚点${missing.length ? ` · ${missing.length} 个缺失` : ''}`} items={markerItems}>
      <InspectorSection title="锚点与注入点" meta={`${anchors.length} 个锚点`}>
      <ul className="flex flex-col">
        {[
          { label: '策略组', hint: 'PROXY-GROUPS', marker: groupsMarker },
          { label: '规则集', hint: 'RULE-PROVIDERS', marker: providersMarker },
        ].map((row) => (
          <li key={row.hint}>
            <MarkerRow
              onClick={row.marker ? () => onReveal(row.marker!.line) : undefined}
              name={<span className="font-sans text-[13px] text-ink">{row.label}</span>}
              detail={<span className={cn('text-ink-4', mono)}>{row.hint}</span>}
              right={row.marker ? `第 ${row.marker.line} 行` : <span className="text-ink-4">未放置</span>}
            />
          </li>
        ))}
      </ul>
      <div className="h-px bg-line" />
      {anchors.length === 0 && missing.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-3">
          还没有锚点。规则需要锚点才能进入最终配置：在 <code className={mono}>rules:</code> 下加一行锚点标记。
        </p>
      ) : (
        <ul className="flex flex-col">
          {anchors.map((anchor) => {
            const count = summary?.anchors[anchor.name];
            return (
              <li key={`${anchor.name}-${anchor.line}`}>
                <MarkerRow
                  onClick={() => onReveal(anchor.line)}
                  name={anchor.name}
                  detail={
                    count ? (
                      <span className="tnum">
                        {count.active} 条规则{count.total > count.active ? ` · ${count.total - count.active} 条停用` : ''}
                      </span>
                    ) : (
                      <span className="text-ink-4">{summary ? '没有规则' : '…'}</span>
                    )
                  }
                  right={`第 ${anchor.line} 行`}
                />
              </li>
            );
          })}
          {missing.map(([anchorName, count]) => (
            <li key={`missing-${anchorName}`}>
              <MarkerRow
                tone="bad"
                name={anchorName}
                detail={<span className="tnum">{count.total} 条规则没有位置</span>}
                right={<Badge tone="bad">缺失</Badge>}
              />
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex items-start gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            inputSize="sm"
            mono
            value={name}
            invalid={!!nameError}
            onChange={(event) => setName(event.target.value.trim())}
            placeholder="新锚点名称，如 streaming"
            aria-label="新锚点名称"
          />
          {nameError && <p className="mt-1 text-2xs text-bad">{nameError}</p>}
        </div>
        <Button type="submit" size="sm" variant="secondary" icon={Plus} disabled={!name || !!nameError}>
          添加
        </Button>
      </form>
      </InspectorSection>
    </DataView>
  );
}

function MarkerRow({
  name,
  detail,
  right,
  onClick,
  tone,
}: {
  name: ReactNode;
  detail?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  tone?: 'bad';
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', tone === 'bad' ? 'bg-bad' : 'bg-accent/70')}
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-ink', mono, 'text-[12.5px]', tone === 'bad' && 'text-bad')}>{name}</span>
        {detail && <span className="block truncate text-2xs text-ink-3">{detail}</span>}
      </span>
      {right && <span className="shrink-0 text-2xs tnum text-ink-3">{right}</span>}
    </>
  );
  const className = 'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left';
  return onClick ? (
    <UiButton type="button" onClick={onClick} className={cn(className, 'transition-colors hover:bg-surface-2')}>
      {body}
    </UiButton>
  ) : (
    <div className={className}>{body}</div>
  );
}

/* ─── 可用策略 ───────────────────────────────────────────────────────── */

export function PoliciesSection({
  policies,
  managed,
  usage,
  loading,
}: {
  policies: string[];
  managed: string[];
  usage: Record<string, number> | undefined;
  loading: boolean;
}) {
  const groups = useMemo(() => {
    const managedSet = new Set(managed);
    return {
      managed: managed.filter((name) => policies.includes(name)),
      literal: policies.filter((name) => !managedSet.has(name) && !isBuiltinPolicy(name)),
      builtin: policies.filter((name) => isBuiltinPolicy(name)),
    };
  }, [policies, managed]);

  return (
    <DataView
      label="可用策略"
      summary={loading ? '加载中' : `共 ${policies.length} 个可用策略`}
      items={policies.map((p) => ({
        value: p,
        label: `${p}${usage?.[p] ? `（${usage[p]} 条规则）` : ''}`,
      }))}
    >
      <InspectorSection title="可用策略" meta={loading ? undefined : `${policies.length} 个`}>
      <p className="-mt-1 text-xs leading-relaxed text-ink-3">规则可以指向这些目标。策略组在「策略组」页管理。</p>
      {loading ? (
        <div className="flex flex-wrap gap-1.5">
          {[64, 48, 80, 56, 72].map((w) => (
            <Skeleton key={w} className="h-6 rounded-full" style={{ width: w }} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {[
            { title: '策略组', list: groups.managed },
            { title: '基础配置里定义的', list: groups.literal },
            { title: '内置', list: groups.builtin },
          ]
            .filter((g) => g.list.length > 0)
            .map((g) => (
              <div key={g.title} className="flex flex-col gap-1.5">
                <div className="text-2xs text-ink-3">{g.title}</div>
                <div className="flex flex-wrap gap-1.5">
                  {g.list.map((policy) => (
                    <span
                      key={policy}
                      title={
                        [isBuiltinPolicy(policy) ? `${policy} · ${BUILTIN_LABEL[policy]}` : policy, usage?.[policy] ? `${usage[policy]} 条规则指向它` : null]
                          .filter(Boolean)
                          .join(' · ')
                      }
                    >
                      <PolicyChip policy={policy} size="sm" />
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
      </InspectorSection>
    </DataView>
  );
}

/* ─── 快捷片段 ───────────────────────────────────────────────────────── */

export function SnippetsSection({
  content,
  onInsert,
  onReveal,
}: {
  content: string;
  onInsert: (snippet: Snippet) => void;
  onReveal: (line: number) => void;
}) {
  return (
    <InspectorSection title="快捷片段" meta="插在光标处">
      <ul className="flex flex-col gap-1.5">
        {SNIPPETS.map((snippet) => {
          const existing = snippet.keys.map((key) => hasTopKey(content, key)).find((line) => line !== null) ?? null;
          return (
            <li key={snippet.id}>
              <UiButton
                type="button"
                onClick={() => (existing ? onReveal(existing) : onInsert(snippet))}
                className="group flex w-full items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left shadow-xs transition-[border-color,background-color] hover:border-line-strong hover:bg-surface-2/60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-ink">{snippet.label}</span>
                  <span className="block text-2xs leading-relaxed text-ink-3">{snippet.description}</span>
                </span>
                <span
                  className={cn(
                    'mt-0.5 shrink-0 text-2xs font-medium',
                    existing ? 'text-ink-4' : 'text-accent opacity-80 group-hover:opacity-100',
                  )}
                >
                  {existing ? `已有 · 第 ${existing} 行` : '插入'}
                </span>
              </UiButton>
            </li>
          );
        })}
      </ul>
    </InspectorSection>
  );
}
