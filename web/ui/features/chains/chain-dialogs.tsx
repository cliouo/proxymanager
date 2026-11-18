'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, CircleAlert, RefreshCw } from 'lucide-react';
import { matchFilter } from '@/lib/proxies/filterMatch';
import { errorMessage } from '@/ui/data/api';
import { refreshProfile } from '@/ui/data/hooks';
import type { ParsedConfig, ProxyGroup } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import {
  Button,
  Combobox,
  Dialog,
  Field,
  Input,
  MultiCombobox,
  notify,
  SegmentedControl,
  Skeleton,
  type ComboOption,
} from '@/ui/primitives';
import { LineDot, useLineColors } from '@/ui/viz/lines';
import { NodeName, RegionStrip } from '@/ui/viz/nodes';
import { ChainDiagram, Endpoint } from './chain-diagram';
import {
  DEFAULT_INTERVAL,
  DEFAULT_TEST_URL,
  defaultNames,
  nodesOf,
  REGION_FILTERS,
  runChainOp,
  STRATEGY_META,
  urlError,
  type ChainView,
  type Strategy,
} from './model';

/* ─── shared option lists ────────────────────────────────────────────── */

export interface PickerData {
  parsed: ParsedConfig | undefined;
  parsedError: unknown;
  retryParsed: () => void;
  groups: ProxyGroup[];
}

function useOptions({ parsed, groups }: PickerData) {
  const { color } = useLineColors();
  return useMemo(() => {
    const nodes: ComboOption[] = nodesOf(parsed).map((p) => ({
      value: p.name,
      label: <NodeName name={p.name} />,
      keywords: [p.name, p.type],
      description: <span className="font-mono">{p.type}</span>,
      group: '节点',
    }));
    const groupOptions: ComboOption[] = groups
      .filter((g) => !g['dialer-proxy'])
      .map((g) => ({
        value: g.name,
        label: g.name,
        icon: <LineDot color={color(g.name)} size={8} />,
        description: '策略组',
        group: '策略组',
      }));
    return { nodes, groups: groupOptions };
  }, [parsed, groups, color]);
}

function ParsedState({ data }: { data: PickerData }) {
  if (data.parsed) return null;
  if (data.parsedError) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2.5 text-xs text-bad">
        <CircleAlert size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">当前配置渲染失败，暂时列不出节点：{errorMessage(data.parsedError)}</span>
        <Button size="xs" variant="ghost" icon={RefreshCw} onClick={data.retryParsed}>
          重试
        </Button>
      </div>
    );
  }
  return <Skeleton className="h-8" />;
}

/* ─── smart pool fields ──────────────────────────────────────────────── */

export interface SmartDraft {
  filter: string;
  strategy: Strategy;
  testUrl: string;
  interval: string;
}

export function smartErrors(draft: SmartDraft) {
  const interval = Number(draft.interval);
  return {
    testUrl: draft.testUrl.trim() ? urlError(draft.testUrl.trim()) : null,
    interval: Number.isInteger(interval) && interval >= 1 && interval <= 86400 ? null : '1–86400 之间的整数（秒）',
  };
}

export function smartPayload(draft: SmartDraft) {
  return {
    strategy: draft.strategy,
    ...(draft.filter.trim() ? { filter: draft.filter.trim() } : {}),
    testUrl: draft.testUrl.trim() || DEFAULT_TEST_URL,
    interval: Number(draft.interval),
  };
}

function SmartFields({
  draft,
  onChange,
  nodeNames,
  backend,
  tried,
}: {
  draft: SmartDraft;
  onChange: (next: SmartDraft) => void;
  nodeNames: string[];
  backend: string;
  tried: boolean;
}) {
  // The pool always excludes its exit node (server writes an exclude-filter),
  // so the preview matches against every other node.
  const candidates = useMemo(() => nodeNames.filter((n) => n !== backend), [nodeNames, backend]);
  const backendExcluded = candidates.length !== nodeNames.length;
  const result = useMemo(() => matchFilter(candidates, draft.filter.trim() || undefined), [candidates, draft.filter]);
  const errors = smartErrors(draft);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="筛选前置节点"
        optional
        hint="按节点名称实时挑选（正则）。订阅更新、节点改名后自动跟着变，不用回来改。留空 = 除落地节点外的全部节点。"
        error={result.error ? `正则无效：${result.error}` : null}
      >
        {(id) => (
          <div className="flex flex-col gap-2">
            <Input
              id={id}
              mono
              value={draft.filter}
              invalid={!!result.error}
              placeholder="港|HK"
              onChange={(e) => onChange({ ...draft, filter: e.target.value })}
            />
            <div className="flex flex-wrap gap-1">
              {REGION_FILTERS.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  onClick={() => onChange({ ...draft, filter: r.filter })}
                  className={cn(
                    'h-6 rounded-full border px-2 text-xs transition-colors',
                    draft.filter === r.filter ? 'border-accent-line bg-accent-soft text-accent' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </Field>
      {!result.error && (
        <div className="rounded-lg border border-line bg-surface-2/50 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <span>
              现在匹配 <span className="tnum font-semibold text-ink">{result.matched.length}</span> / {candidates.length} 个节点
            </span>
            <RegionStrip names={result.matched} max={6} />
          </div>
          {result.matched.length > 0 ? (
            <div className="mt-2 flex max-h-[88px] flex-wrap gap-1 overflow-y-auto">
              {result.matched.slice(0, 24).map((name) => (
                <span key={name} className="inline-flex h-6 max-w-[200px] items-center rounded-md border border-line bg-surface px-1.5 text-xs">
                  <NodeName name={name} />
                </span>
              ))}
              {result.matched.length > 24 && <span className="self-center text-xs text-ink-3">+{result.matched.length - 24}</span>}
            </div>
          ) : (
            <p className="mt-1 text-xs text-warn">没有节点匹配，链路会无法连通。</p>
          )}
          {backendExcluded && (
            <p className="mt-2 text-xs text-ink-3">已自动排除落地节点「{backend}」。</p>
          )}
        </div>
      )}
      <Field label="挑选方式">
        {() => (
          <div className="flex flex-col gap-1.5">
            <SegmentedControl
              stretch
              value={draft.strategy}
              onChange={(strategy) => onChange({ ...draft, strategy })}
              options={(['fallback', 'url-test'] as const).map((s) => ({ value: s, label: STRATEGY_META[s].label }))}
            />
            <p className="text-xs text-ink-3">{STRATEGY_META[draft.strategy].description}</p>
          </div>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
        <Field label="测速地址" error={tried || draft.testUrl ? errors.testUrl : null} hint="前置连不通这个地址就会被跳过">
          {(id) => (
            <Input
              id={id}
              mono
              value={draft.testUrl}
              placeholder={DEFAULT_TEST_URL}
              onChange={(e) => onChange({ ...draft, testUrl: e.target.value })}
            />
          )}
        </Field>
        <Field label="间隔（秒）" error={errors.interval}>
          {(id) => (
            <Input
              id={id}
              mono
              inputMode="numeric"
              value={draft.interval}
              invalid={!!errors.interval}
              onChange={(e) => onChange({ ...draft, interval: e.target.value })}
            />
          )}
        </Field>
      </div>
    </div>
  );
}

/* ─── new chain ──────────────────────────────────────────────────────── */

type Mode = 'fixed' | 'pool' | 'smart';

const MODE_HINT: Record<Mode, string> = {
  fixed: '指定一个前置节点或策略组。最简单；前置不通时链路就断。',
  pool: '挑几个前置组成池子，在客户端里手动切换用哪个。',
  smart: '按名称规则自动挑选前置并测速；订阅换了节点也不受影响。',
};

const emptySmart = (): SmartDraft => ({ filter: '', strategy: 'fallback', testUrl: DEFAULT_TEST_URL, interval: String(DEFAULT_INTERVAL) });

export function NewChainDialog({
  open,
  onOpenChange,
  profileId,
  data,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileId: string;
  data: PickerData;
  onCreated: (chainName: string) => void;
}) {
  const options = useOptions(data);
  const [mode, setMode] = useState<Mode>('fixed');
  const [backend, setBackend] = useState('');
  const [front, setFront] = useState('');
  const [fronts, setFronts] = useState<string[]>([]);
  const [smart, setSmart] = useState<SmartDraft>(emptySmart);
  const [names, setNames] = useState({ chainName: '', poolName: '' });
  const [showNames, setShowNames] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode('fixed');
      setBackend('');
      setFront('');
      setFronts([]);
      setSmart(emptySmart());
      setNames({ chainName: '', poolName: '' });
      setShowNames(false);
      setTried(false);
    }
  }

  const nodeNames = useMemo(() => nodesOf(data.parsed).map((p) => p.name), [data.parsed]);
  const taken = useMemo(() => new Set([...data.groups.map((g) => g.name), ...nodeNames]), [data.groups, nodeNames]);
  const defaults = defaultNames(mode, front, backend);
  const chainName = names.chainName.trim() || defaults.chainName;
  const poolName = names.poolName.trim() || defaults.poolName;

  const errors = {
    backend: backend ? null : '请选择落地节点',
    front: mode === 'fixed' ? (!front ? '请选择前置' : front === backend ? '前置和落地不能是同一个' : null) : null,
    fronts: mode === 'pool' ? (fronts.length === 0 ? '至少选一个前置' : null) : null,
    chainName: backend && taken.has(chainName) ? `已有同名策略组或节点「${chainName}」，请换个名称` : null,
    poolName:
      mode !== 'fixed' && backend
        ? taken.has(poolName)
          ? `已有同名策略组或节点「${poolName}」，请换个名称`
          : poolName === chainName
            ? '池名和链路名不能相同'
            : null
        : null,
    smart: mode === 'smart' ? Object.values(smartErrors(smart)).find(Boolean) ?? matchFilter([], smart.filter.trim() || undefined).error : null,
  };
  const firstError = Object.values(errors).find(Boolean) ?? null;
  const nameError = errors.chainName ?? errors.poolName;

  const submit = async () => {
    setTried(true);
    if (firstError) {
      if (nameError) setShowNames(true);
      return;
    }
    const custom = {
      ...(names.chainName.trim() ? { chainName: names.chainName.trim() } : {}),
      ...(mode !== 'fixed' && names.poolName.trim() ? { poolName: names.poolName.trim() } : {}),
    };
    const [op, payload] =
      mode === 'fixed'
        ? (['set-fixed-chain', { backend, front, ...custom }] as const)
        : mode === 'pool'
          ? (['create-pool-chain', { backend, fronts, ...custom }] as const)
          : (['create-smart-pool-chain', { backend, ...smartPayload(smart), ...custom }] as const);
    setBusy(true);
    try {
      await runChainOp(profileId, op, payload);
      refreshProfile(profileId);
      notify.success(`已创建链路「${chainName}」`, '在规则或策略组里选择它，流量就会走这条链路。');
      onCreated(chainName);
    } catch (error) {
      notify.error(error, '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const frontEndpoint =
    mode === 'fixed' ? (
      front ? (
        <Endpoint name={front} isGroup={data.groups.some((g) => g.name === front)} />
      ) : (
        <span className="text-xs text-ink-4">选择前置</span>
      )
    ) : (
      <Endpoint
        name={poolName}
        isGroup
        meta={mode === 'pool' ? `前置池 · ${fronts.length} 个成员` : `智能前置池 · ${STRATEGY_META[smart.strategy].label}`}
      />
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="新建链路"
      description="流量先连到前置，再由落地节点出去。创建后会多一个策略组，在规则或策略组里选择它即可使用。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" loading={busy} disabled={!data.parsed} onClick={() => void submit()}>
            创建链路
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <SegmentedControl
            stretch
            value={mode}
            onChange={setMode}
            options={[
              { value: 'fixed', label: '固定前置' },
              { value: 'pool', label: '前置池' },
              { value: 'smart', label: '智能前置池' },
            ]}
          />
          <p className="text-xs text-ink-3">{MODE_HINT[mode]}</p>
        </div>

        <div className="rounded-xl border border-line bg-surface-2/40 px-4 py-3.5">
          <ChainDiagram
            lineName={backend ? chainName : ''}
            front={frontEndpoint}
            backend={backend ? <Endpoint name={backend} /> : <span className="text-xs text-ink-4">选择落地</span>}
          />
        </div>

        <ParsedState data={data} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="落地节点" hint="最终出口，网站看到的是它的 IP" error={tried ? errors.backend : null}>
            {(id) => (
              <Combobox
                id={id}
                value={backend}
                onChange={(value) => {
                  setBackend(value);
                  setFronts((list) => list.filter((f) => f !== value));
                }}
                options={options.nodes.filter((o) => o.value !== front)}
                placeholder="选择落地节点"
                searchPlaceholder="搜索节点…"
                disabled={!data.parsed}
                invalid={tried && !!errors.backend}
                renderValue={(value) => <NodeName name={value} />}
              />
            )}
          </Field>
          {mode === 'fixed' && (
            <Field label="前置" hint="负责连通的第一跳，可以是节点或策略组" error={tried ? errors.front : null}>
              {(id) => (
                <Combobox
                  id={id}
                  value={front}
                  onChange={setFront}
                  options={[...options.groups, ...options.nodes].filter((o) => o.value !== backend)}
                  placeholder="选择前置"
                  searchPlaceholder="搜索节点或策略组…"
                  disabled={!data.parsed}
                  invalid={tried && !!errors.front}
                  renderValue={(value) => <NodeName name={value} />}
                />
              )}
            </Field>
          )}
        </div>

        {mode === 'pool' && (
          <Field label="前置成员" hint="客户端里可以在这些前置之间切换" error={tried ? errors.fronts : null}>
            {() => (
              <MultiCombobox
                value={fronts}
                onChange={setFronts}
                options={[...options.groups, ...options.nodes].filter((o) => o.value !== backend)}
                placeholder="添加前置"
                renderChip={(value) => <NodeName name={value} />}
                disabled={!data.parsed}
                width={320}
              />
            )}
          </Field>
        )}

        {mode === 'smart' && (
          <SmartFields draft={smart} onChange={setSmart} nodeNames={nodeNames} backend={backend} tried={tried} />
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowNames((v) => !v)}
            aria-expanded={showNames}
            className="flex items-center gap-1 text-xs font-medium text-ink-3 hover:text-ink"
          >
            <ChevronDown size={13} className={cn('transition-transform', !showNames && '-rotate-90')} />
            自定义名称
          </button>
          {showNames && (
            <div className="mt-3 grid animate-rise gap-4 sm:grid-cols-2">
              <Field label="链路名称" optional hint="客户端里显示的策略组名" error={errors.chainName}>
                {(id) => (
                  <Input
                    id={id}
                    value={names.chainName}
                    placeholder={defaults.chainName}
                    onChange={(e) => setNames({ ...names, chainName: e.target.value })}
                  />
                )}
              </Field>
              {mode !== 'fixed' && (
                <Field label="前置池名称" optional error={errors.poolName}>
                  {(id) => (
                    <Input
                      id={id}
                      value={names.poolName}
                      placeholder={defaults.poolName}
                      onChange={(e) => setNames({ ...names, poolName: e.target.value })}
                    />
                  )}
                </Field>
              )}
            </div>
          )}
          {!showNames && tried && nameError && <p className="mt-1 text-xs text-bad">{nameError}</p>}
        </div>
      </div>
    </Dialog>
  );
}

/* ─── edit pool ──────────────────────────────────────────────────────── */

export function EditPoolDialog({
  view,
  onClose,
  profileId,
  data,
}: {
  view: Extract<ChainView, { kind: 'pool' | 'smart' }> | null;
  onClose: () => void;
  profileId: string;
  data: PickerData;
}) {
  const options = useOptions(data);
  const [members, setMembers] = useState<string[]>([]);
  const [smart, setSmart] = useState<SmartDraft>(emptySmart);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<typeof view>(null);
  if (view !== current) {
    setCurrent(view);
    if (view?.kind === 'pool') setMembers(view.members);
    if (view?.kind === 'smart') {
      setSmart({
        filter: view.smart.filter ?? '',
        strategy: view.smart.strategy,
        testUrl: view.smart.testUrl,
        interval: String(view.smart.interval),
      });
    }
  }
  const nodeNames = useMemo(() => nodesOf(data.parsed).map((p) => p.name), [data.parsed]);

  const submit = async () => {
    if (!view) return;
    if (view.kind === 'pool' && members.length === 0) {
      notify.warn('至少保留一个前置');
      return;
    }
    if (view.kind === 'smart') {
      const problem = Object.values(smartErrors(smart)).find(Boolean) ?? matchFilter([], smart.filter.trim() || undefined).error;
      if (problem) {
        notify.warn('还有问题没解决', problem);
        return;
      }
    }
    setBusy(true);
    try {
      if (view.kind === 'pool') {
        await runChainOp(profileId, 'update-pool-members', { poolName: view.poolName, fronts: members });
      } else {
        await runChainOp(profileId, 'update-smart-pool', { poolName: view.poolName, ...smartPayload(smart) });
      }
      refreshProfile(profileId);
      notify.success('已更新前置池', view.poolName);
      onClose();
    } catch (error) {
      notify.error(error, '更新失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!view}
      onOpenChange={(open) => !open && onClose()}
      size={view?.kind === 'smart' ? 'lg' : 'md'}
      title={view?.kind === 'smart' ? '调整智能前置池' : '编辑前置成员'}
      description={view ? <span className="font-mono text-xs">{view.poolName}</span> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ParsedState data={data} />
        {view?.kind === 'pool' && (
          <Field label="前置成员" hint="客户端里可以在这些前置之间切换">
            {() => (
              <MultiCombobox
                value={members}
                onChange={setMembers}
                options={[...options.groups, ...options.nodes].filter((o) => o.value !== view.backend && o.value !== view.poolName)}
                placeholder="添加前置"
                renderChip={(value) => <NodeName name={value} />}
                width={320}
              />
            )}
          </Field>
        )}
        {view?.kind === 'smart' && (
          <SmartFields draft={smart} onChange={setSmart} nodeNames={nodeNames} backend={view.backend} tried />
        )}
      </div>
    </Dialog>
  );
}
