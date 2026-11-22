'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AlertTriangle, Layers, SearchX, Undo2, Wand2 } from 'lucide-react';
import { validateTemplate } from '@/lib/proxies/naming';
import { NodeFactsSchema } from '@/schemas/nodeFacts';
import { ApiError, errorMessage } from '@/ui/data/api';
import { refreshShared } from '@/ui/data/hooks';
import { useHotkey } from '@/ui/shell/hotkeys';
import { Block, Page, PageHeader, SaveBar } from '@/ui/shell/page';
import { profilePath } from '@/ui/shell/scope';
import { Badge, Button, Card, Code, confirmAction, EmptyState, Monogram, notify, Skeleton } from '@/ui/primitives';
import { TemplateComposer } from './composer';
import { NamingCandidates, applyNamingCandidate } from './candidates';
import {
  applyPlan,
  isVersionConflict,
  rollbackPlan,
  recognizeNodeFacts,
  useCurrentNames,
  useDebounced,
  useNamingPreview,
  useNamingWorkspace,
} from './data';
import {
  activationOf,
  buildRows,
  fieldStats,
  planBody,
  ruleError,
  samePlan,
  storedPlan,
  summarizeIssues,
  type NamingPlan,
  type NamingWorkspaceData,
  type RecognitionRule,
  type TargetType,
} from './model';
import { PreviewPanel } from './preview';
import { AliasesEditor, CoverageCard, RulesEditor, Section } from './sections';

const KIND_LABEL: Record<TargetType, string> = { subscription: '订阅源', collection: '聚合订阅' };

export function NamingWorkspace({ type }: { type: TargetType }) {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? null;
  const ws = useNamingWorkspace(type, id);
  const backHref = type === 'subscription' ? `/sources/${id}` : `/pools/${id}`;
  const back = { href: backHref, label: `返回${KIND_LABEL[type]}` };

  if (!ws.data) {
    if (ws.error) {
      const notFound = ws.error instanceof ApiError && (ws.error.status === 404 || ws.error.status === 400);
      return (
        <Page width="wide">
          <PageHeader back={back} title="智能命名" />
          <Card>
            <EmptyState
              icon={notFound ? SearchX : AlertTriangle}
              title={notFound ? `找不到这个${KIND_LABEL[type]}` : '命名工作台加载失败'}
              description={notFound ? '它可能已被删除。' : errorMessage(ws.error)}
              actions={
                notFound ? (
                  <Button asChild variant="secondary">
                    <Link href={type === 'subscription' ? '/sources' : '/sources'}>回到节点来源</Link>
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void ws.refetch()}>
                    重试
                  </Button>
                )
              }
            />
          </Card>
        </Page>
      );
    }
    return <LoadingView back={back} />;
  }
  return <Workspace key={`${type}:${id}`} type={type} id={id!} data={ws.data} back={back} ws={ws} />;
}

function Workspace({
  type,
  id,
  data,
  back,
  ws,
}: {
  type: TargetType;
  id: string;
  data: NamingWorkspaceData;
  back: { href: string; label: string };
  ws: ReturnType<typeof useNamingWorkspace>;
}) {
  const [plan, setPlan] = useState<NamingPlan>(() => storedPlan(data));
  const [busy, setBusy] = useState<'apply' | 'rollback' | 'recognize' | null>(null);
  const [rulesOpen, setRulesOpen] = useState(
    () => (data.managed.recognitionRules?.length ?? 0) > 0,
  );
  const [aliasesOpen, setAliasesOpen] = useState(false);

  const stored = useMemo(() => storedPlan(data), [data]);
  const activation = activationOf(data);
  const dirty = !samePlan(plan, stored);
  const validation = useMemo(() => validateTemplate(plan.template), [plan.template]);
  const templateError = plan.template.trim() === '' ? '模板不能为空' : validation.ok ? null : validation.message;
  const ruleErrors = plan.recognitionRules.map(ruleError);
  const valid = !templateError && ruleErrors.every((e) => e === null);
  const applyable = valid && !busy && (activation !== 'enabled' || dirty);

  const body = useMemo(() => planBody(plan), [plan]);
  const planJson = valid ? JSON.stringify(body) : null;
  const debouncedJson = useDebounced(planJson, 350);
  const version = data.configVersion;
  const preview = useNamingPreview(type, id, version, debouncedJson ?? planJson);
  const current = useCurrentNames(type, id, version);
  const stats = useMemo(() => fieldStats(data.health), [data.health]);
  const memberWarnings = preview.data ? preview.data.issues.flatMap((issue) =>
    issue.code === 'member-post-template-rename' && 'memberId' in issue && 'message' in issue
      ? [{ memberId: String(issue.memberId), message: String(issue.message) }]
      : [],
  ) : data.diagnostics.memberWarnings ?? [];

  const summary = useMemo(() => (preview.data ? summarizeIssues(preview.data.issues) : null), [preview.data]);
  const table = useMemo(() => {
    if (!preview.data || !summary) return null;
    if (current.isLoading) return null;
    const ops = current.data?.operators ?? [];
    const { index, mode } = preview.data.candidate;
    const later = ops.slice(mode === 'added' ? index : index + 1);
    const reorders = later.some((op) => op.kind === 'sort' && !op.disabled);
    return buildRows(current.data?.names, preview.data.after, summary, reorders);
  }, [preview.data, summary, current.data, current.isLoading]);

  const profiles = data.references.consumingProfiles;
  const changedCount = table?.paired ? table.rows.filter((r) => r.before !== r.after).length : preview.data?.after.count;

  const onConflict = async () => {
    await ws.refetch();
    notify.warn('配置刚被其他操作修改', '已刷新到最新状态，你的改动还在。请再看一眼预览，然后重新应用。');
  };

  const applyCandidate = async (template: string) => {
    if (busy) return;
    setBusy('apply');
    try {
      const next = await applyNamingCandidate(type, id, template, data.configVersion);
      ws.mutate(next);
      setPlan(storedPlan(next));
      refreshShared();
      notify.success('推荐命名方案与引用迁移已应用', undefined, {
        label: '撤销', onClick: () => void restore(next.configVersion),
      });
    } catch (error) {
      if (isVersionConflict(error)) await onConflict();
      else notify.error(error, '应用失败');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!applyable) return;
    const orphans = summary?.orphans ?? [];
    const ok = await confirmAction({
      title: activation === 'enabled' ? '应用新的命名方案？' : '启用智能命名？',
      tone: orphans.length ? 'danger' : 'default',
      confirmText: activation === 'enabled' ? '应用' : '启用',
      description: (
        <span className="flex flex-col gap-2">
          <span>
            {changedCount !== undefined ? `将改名 ${changedCount} 个节点，` : ''}
            {profiles.length
              ? `影响 ${profiles.length} 个配置文件（${profiles.map((p) => p.name).join('、')}），客户端下次更新订阅时会看到新名字。`
              : '目前没有配置文件用到它。'}
          </span>
          {orphans.length > 0 && (
            <span className="text-bad">
              有 {orphans.length} 处按旧名字引用节点的地方会失效，保存校验可能会拒绝这次改动。
            </span>
          )}
          <span className="text-ink-3">之后可以随时撤销到这次之前的方案。</span>
        </span>
      ),
    });
    if (!ok) return;
    setBusy('apply');
    try {
      const next = await applyPlan(type, id, body, data.configVersion);
      ws.mutate(next);
      setPlan(storedPlan(next));
      refreshShared();
      notify.success(activation === 'enabled' ? '新的命名方案已应用' : '智能命名已启用', '客户端下次更新订阅时就会看到新名字。');
    } catch (error) {
      if (isVersionConflict(error)) await onConflict();
      else notify.error(error, '应用失败');
    } finally {
      setBusy(null);
    }
  };

  const rollback = async () => {
    const prior = data.priorPlan;
    const ok = await confirmAction({
      title: '撤销上次应用？',
      tone: 'danger',
      confirmText: '撤销',
      description: prior.template ? (
        <span className="flex flex-col gap-2">
          <span>命名会恢复为上一次的方案：</span>
          <Code className="break-all">{prior.template}</Code>
          <span>如该方案迁移过策略组筛选或精确引用，也会一并恢复；已被后续编辑的项不会被覆盖。</span>
        </span>
      ) : (
        '上次应用之前没有启用智能命名，撤销后节点会恢复原来的名字。如有策略组筛选或引用迁移，也会一并恢复。'
      ),
    });
    if (!ok) return;
    await restore(data.configVersion);
  };

  const restore = async (expectedVersion: number) => {
    setBusy('rollback');
    try {
      const next = await rollbackPlan(type, id, expectedVersion);
      ws.mutate(next);
      setPlan(storedPlan(next));
      refreshShared();
      notify.success('已撤销上次应用');
    } catch (error) {
      if (isVersionConflict(error)) await onConflict();
      else notify.error(error, '撤销失败');
    } finally {
      setBusy(null);
    }
  };

  useHotkey('mod+s', () => void apply(), { enabled: applyable });

  const recognize = async () => {
    setBusy('recognize');
    try {
      const result = await recognizeNodeFacts(data.entity.ref);
      const nodeFacts = NodeFactsSchema.parse({
        ...plan.nodeFacts,
        ...Object.fromEntries(
          Object.entries(result.nodeFacts).map(([fingerprint, facts]) => [
            fingerprint,
            { ...plan.nodeFacts?.[fingerprint], ...facts },
          ]),
        ),
      });
      setPlan((current) => ({ ...current, nodeFacts }));
      notify.success(`已识别 ${result.proposed} 个节点`, '请核对改名预览，再应用改动。');
    } catch (error) {
      notify.error(error, '节点识别失败');
    } finally {
      setBusy(null);
    }
  };

  const addRule = (rule: RecognitionRule) => {
    setPlan((p) => ({ ...p, recognitionRules: [...p.recognitionRules, rule] }));
    setRulesOpen(true);
  };

  const badge =
    activation === 'enabled' ? (
      <Badge tone="ok">已启用</Badge>
    ) : activation === 'disabled' ? (
      <Badge tone="warn">已停用</Badge>
    ) : (
      <Badge>未启用</Badge>
    );
  const rulesDiffer = JSON.stringify(body.recognitionRules) !== JSON.stringify(planBody(stored).recognitionRules);

  return (
    <Page width="wide">
      <PageHeader
        back={back}
        documentTitle={`智能命名 · ${data.entity.label}`}
        eyebrow={
          <>
            <Monogram name={data.entity.label} size={18} />
            <span className="font-medium text-ink-2">{data.entity.label}</span>
            <span className="text-ink-4">·</span>
            <span>{KIND_LABEL[type]}</span>
            <span className="text-ink-4">·</span>
            <span className="tnum">输入 {data.diagnostics.nodeCount} 个节点</span>
            {data.diagnostics.infoFiltered > 0 && <span>· {data.diagnostics.infoFiltered} 个信息节点（剩余流量、到期等）已过滤</span>}
          </>
        }
        title={
          <span className="flex items-center gap-3">
            智能命名
            {badge}
          </span>
        }
        description="把杂乱的节点名统一成同一种格式，例如「🇭🇰 香港 01 · IPLC」；订阅更新后的新节点也会自动套用。"
        actions={
          <>
            <Button
              loading={busy === 'recognize'}
              disabled={!!busy}
              onClick={() => void recognize()}
            >
              AI 识别节点
            </Button>
            {data.priorPlan.present && (
              <Button icon={Undo2} loading={busy === 'rollback'} disabled={!!busy} onClick={() => void rollback()}>
                撤销上次应用
              </Button>
            )}
            <Button variant="primary" icon={Wand2} loading={busy === 'apply'} disabled={!applyable} onClick={() => void apply()}>
              {activation === 'absent' ? '启用智能命名' : activation === 'disabled' ? '重新启用' : '应用改动'}
            </Button>
          </>
        }
      >
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <Layers size={13} />
          {profiles.length ? (
            <>
              <span>影响 {profiles.length} 个配置文件</span>
              {profiles.map((p) => (
                <Link
                  key={p.id}
                  href={profilePath(p.name)}
                  className="rounded-md border border-line bg-surface px-1.5 py-px font-mono text-[11px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
                >
                  {p.name}
                </Link>
              ))}
            </>
          ) : (
            <span>暂时没有配置文件用到它</span>
          )}
          {activation === 'disabled' && <span className="text-warn">· 命名步骤在处理流程里被停用了，应用后会重新启用</span>}
        </div>
      </PageHeader>

      <NamingCandidates type={type} id={id} version={data.configVersion} busy={!!busy} onApply={applyCandidate} />
      <div className="grid gap-6 @3xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] @3xl/main:grid-rows-[auto_1fr]">
        <div className="min-w-0 animate-rise @3xl/main:col-start-1 @3xl/main:row-start-1">
          <TemplateComposer
            plan={plan}
            onChange={setPlan}
            aggregate={data.aggregate}
            recommended={data.recommended}
            stats={stats}
            error={templateError}
          />
        </div>

        <div className="min-w-0 animate-rise [animation-delay:60ms] @3xl/main:sticky @3xl/main:top-4 @3xl/main:col-start-2 @3xl/main:row-span-2 @3xl/main:row-start-1 @3xl/main:self-start">
          <PreviewPanel
            className="max-h-[640px] @3xl/main:max-h-[calc(100dvh-48px)]"
            rows={table?.rows ?? null}
            paired={table?.paired ?? true}
            summary={summary}
            total={preview.data?.after.count ?? null}
            infoFiltered={preview.data?.infoFiltered ?? 0}
            truncated={!!preview.data?.after.truncated}
            loading={!preview.data && !preview.error}
            validating={preview.isValidating || (!!planJson && planJson !== debouncedJson)}
            stale={!valid && !!preview.data}
            error={preview.error && !preview.isValidating ? preview.error : null}
          />
        </div>

        <div className="flex min-w-0 animate-rise flex-col gap-4 [animation-delay:120ms] @3xl/main:col-start-1 @3xl/main:row-start-2">
          <Block>
            <div className="flex flex-col gap-3">
              {data.aggregate && data.health.length > 0 && (
                <Section
                  title="来源别名"
                  description="给每个订阅源起个短名，用在「来源」字段和重名后缀里；留空沿用原名。"
                  badge={
                    Object.keys(body.sourceAliases).length > 0 ? <Badge>{Object.keys(body.sourceAliases).length}</Badge> : undefined
                  }
                  open={aliasesOpen}
                  onOpenChange={setAliasesOpen}
                >
                  <AliasesEditor health={data.health} plan={plan} onChange={setPlan} />
                </Section>
              )}
              <Section
                title="识别规则"
                description="自动认不出的信息可以用规则补上：节点名匹配某段文字时，把某个字段设为指定值。"
                badge={body.recognitionRules.length > 0 ? <Badge>{body.recognitionRules.length}</Badge> : undefined}
                open={rulesOpen}
                onOpenChange={setRulesOpen}
              >
                <RulesEditor plan={plan} onChange={setPlan} errors={ruleErrors} />
              </Section>
            </div>
          </Block>
          {memberWarnings.map((warning) => (
            <div key={warning.memberId} role="status" className="rounded-lg border border-line p-3 text-sm text-warn">
              {warning.memberId}: {warning.message}
            </div>
          ))}
          <CoverageCard health={data.health} rulesDiffer={rulesDiffer} onSuggestRule={addRule} />
        </div>
      </div>

      <SaveBar
        visible={dirty}
        onSave={() => void apply()}
        onDiscard={() => setPlan(stored)}
        saving={busy === 'apply'}
        message={activation === 'enabled' ? '命名方案有改动，尚未应用' : '方案已调整，应用后才会生效'}
        saveLabel={activation === 'enabled' ? '应用' : '启用'}
      />
    </Page>
  );
}

function LoadingView({ back }: { back: { href: string; label: string } }) {
  return (
    <Page width="wide">
      <PageHeader back={back} documentTitle="智能命名" title={<span className="skeleton block h-7 w-36" />} description={<span className="skeleton block h-4 w-80 max-w-full" />} />
      <div className="grid gap-6 @3xl/main:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
        <Card className="flex flex-col gap-4 p-4">
          <Skeleton className="h-4 w-24" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
          <Skeleton className="h-16" />
          <div className="flex flex-wrap gap-1.5">
            {[...Array(9)].map((_, i) => (
              <Skeleton key={i} className="h-8 w-20" />
            ))}
          </div>
        </Card>
        <Card className="flex flex-col gap-3 p-4">
          <Skeleton className="h-4 w-28" />
          {[...Array(9)].map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${90 - (i % 3) * 10}%` }} />
          ))}
        </Card>
      </div>
    </Page>
  );
}
