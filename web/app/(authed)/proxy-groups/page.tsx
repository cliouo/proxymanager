'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input, Select } from '@/components/ui/Input';
import { Placeholder } from '@/components/ui/Reveal';
import { ApiError, api } from '@/lib/client/api';
import type {
  ProxyGroup,
  ProxyGroupKind,
  ProxyGroupTemplate,
  ProxyGroupType,
} from '@/schemas';

/**
 * 策略组 (proxy-groups) CRUD with preset wizard.
 *
 * Create flow:
 *   1. "+ 新建" opens a kind picker — 8 cards (自由编辑 + 7 presets).
 *   2. Picking a preset jumps into a form pre-configured for that intent
 *      (smart defaults, hidden irrelevant fields, helpers like the region
 *      quick-fill or the subscription/collection binding picker).
 *   3. All presets eventually POST the same ProxyGroupCreate payload —
 *      the resolve pipeline reads `kind` + `bound_*` to perform any
 *      render-time transformations (e.g. single-sub → filter from prefix).
 *
 * Editing keeps the kind of the existing record. Users can switch kind to
 * `raw` ("转 raw") to take the escape hatch and edit every native field.
 *
 * Template picker reads from the proxy-group-templates hash. Template CRUD
 * happens via API for now; a dedicated page comes later (E3+).
 */

interface SubscriptionLite {
  id: string;
  name: string;
  enabled: boolean;
  node_prefix?: string;
}

interface CollectionLite {
  id: string;
  name: string;
  enabled?: boolean;
  subscription_ids: string[];
  subscription_tags: string[];
}

/** Built-in region quick-fills: name suggestion + filter regex. */
const REGIONS: { code: string; label: string; nameSuggestion: string; filter: string }[] = [
  { code: 'HK', label: '香港', nameSuggestion: '香港', filter: '香港|HK|Hong Kong' },
  { code: 'JP', label: '日本', nameSuggestion: '日本', filter: '日本|JP|Japan' },
  { code: 'TW', label: '台湾', nameSuggestion: '台湾', filter: '台湾|TW|Taiwan' },
  { code: 'US', label: '美国', nameSuggestion: '美国', filter: '美国|US|United States' },
  { code: 'SG', label: '新加坡', nameSuggestion: '新加坡', filter: '新加坡|SG|Singapore' },
  { code: 'DE', label: '德国', nameSuggestion: '德国', filter: '德国|DE|Germany' },
];

const KIND_DESCRIPTIONS: Record<ProxyGroupKind, string> = {
  raw: '完全自由,逐字段编辑 mihomo 原生 proxy-group',
  region: '按地区把节点自动归类(HK / JP / US / ...)',
  'single-sub': '只用某一个订阅源的节点,filter 从 node_prefix 自动生成',
  'collection-scope': '绑定一个聚合订阅,proxies 在渲染时自动取该聚合订阅的成员节点',
  'rule-set-policy': '某个规则集走指定的策略组,通常共用一份 url-test 模板',
  service: '混合策略(显式列出几个出口 + filter 兜底过滤)',
  'all-auto-pair': '一键创建「全部节点(select)」+「自动选择(url-test)」两个组',
  system: '默认 / DNS / 国内 / 兜底 / 其他 等系统组',
};

const KIND_LABELS: Record<ProxyGroupKind, string> = {
  raw: '自由编辑',
  region: '地区组',
  'single-sub': '单订阅组',
  'collection-scope': '聚合订阅组',
  'rule-set-policy': '规则集策略组',
  service: '混合服务组',
  'all-auto-pair': '全部+自动对',
  system: '系统组',
};

const TYPE_LABELS: Record<ProxyGroupType, string> = {
  select: 'select',
  'url-test': 'url-test',
  fallback: 'fallback',
  'load-balance': 'load-balance',
  relay: 'relay',
};

const HEALTH_TYPES = new Set<ProxyGroupType>(['url-test', 'fallback', 'load-balance']);

type FormState = {
  name: string;
  type: ProxyGroupType;
  kind: ProxyGroupKind;
  section: string;
  notes: string;
  template_id: string;
  bound_subscription_id: string;
  bound_collection_id: string;
  // member fields
  proxies: string; // newline-separated
  use: string;
  'include-all-proxies': boolean;
  'include-all-providers': boolean;
  'include-all': boolean;
  filter: string;
  'exclude-filter': string;
  'exclude-type': string;
  // health-check fields
  url: string;
  interval: string;
  tolerance: string;
  lazy: boolean;
  'expected-status': string;
  'max-failed-times': string;
  timeout: string;
  // misc
  strategy: string;
  'dialer-proxy': string;
  'routing-mark': string;
  'disable-udp': boolean;
  hidden: boolean;
  icon: string;
};

const EMPTY_FORM: FormState = {
  name: '',
  type: 'select',
  kind: 'raw',
  section: '',
  notes: '',
  template_id: '',
  bound_subscription_id: '',
  bound_collection_id: '',
  proxies: '',
  use: '',
  'include-all-proxies': false,
  'include-all-providers': false,
  'include-all': false,
  filter: '',
  'exclude-filter': '',
  'exclude-type': '',
  url: '',
  interval: '',
  tolerance: '',
  lazy: false,
  'expected-status': '',
  'max-failed-times': '',
  timeout: '',
  strategy: '',
  'dialer-proxy': '',
  'routing-mark': '',
  'disable-udp': false,
  hidden: false,
  icon: '',
};

function fromGroup(g: ProxyGroup): FormState {
  return {
    name: g.name,
    type: g.type,
    kind: g.kind,
    section: g.section ?? '',
    notes: g.notes ?? '',
    template_id: g.template_id ?? '',
    bound_subscription_id: g.bound_subscription_id ?? '',
    bound_collection_id: g.bound_collection_id ?? '',
    proxies: (g.proxies ?? []).join('\n'),
    use: (g.use ?? []).join('\n'),
    'include-all-proxies': g['include-all-proxies'] ?? false,
    'include-all-providers': g['include-all-providers'] ?? false,
    'include-all': g['include-all'] ?? false,
    filter: g.filter ?? '',
    'exclude-filter': g['exclude-filter'] ?? '',
    'exclude-type': g['exclude-type'] ?? '',
    url: g.url ?? '',
    interval: g.interval !== undefined ? String(g.interval) : '',
    tolerance: g.tolerance !== undefined ? String(g.tolerance) : '',
    lazy: g.lazy ?? false,
    'expected-status': g['expected-status'] ?? '',
    'max-failed-times':
      g['max-failed-times'] !== undefined ? String(g['max-failed-times']) : '',
    timeout: g.timeout !== undefined ? String(g.timeout) : '',
    strategy: g.strategy ?? '',
    'dialer-proxy': g['dialer-proxy'] ?? '',
    'routing-mark': g['routing-mark'] !== undefined ? String(g['routing-mark']) : '',
    'disable-udp': g['disable-udp'] ?? false,
    hidden: g.hidden ?? false,
    icon: g.icon ?? '',
  };
}

/**
 * Serialise the form back into the create/update payload shape. Empty
 * strings → omitted. Lists are newline-split + trimmed. Numeric fields
 * pass through Number(); NaN drops them rather than sending a bad value.
 */
function toPayload(s: FormState): Record<string, unknown> {
  const lines = (raw: string) =>
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  const num = (raw: string): number | undefined => {
    const t = raw.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (raw: string): string | undefined => {
    const t = raw.trim();
    return t === '' ? undefined : t;
  };

  const out: Record<string, unknown> = {
    name: s.name.trim(),
    type: s.type,
    kind: s.kind,
  };
  if (s.section.trim()) out.section = s.section.trim();
  if (s.notes.trim()) out.notes = s.notes.trim();
  if (s.template_id) out.template_id = s.template_id;
  if (s.bound_subscription_id) out.bound_subscription_id = s.bound_subscription_id;
  if (s.bound_collection_id) out.bound_collection_id = s.bound_collection_id;

  const proxies = lines(s.proxies);
  if (proxies.length > 0) out.proxies = proxies;
  const use = lines(s.use);
  if (use.length > 0) out.use = use;
  if (s['include-all-proxies']) out['include-all-proxies'] = true;
  if (s['include-all-providers']) out['include-all-providers'] = true;
  if (s['include-all']) out['include-all'] = true;
  if (str(s.filter)) out.filter = str(s.filter);
  if (str(s['exclude-filter'])) out['exclude-filter'] = str(s['exclude-filter']);
  if (str(s['exclude-type'])) out['exclude-type'] = str(s['exclude-type']);

  if (HEALTH_TYPES.has(s.type)) {
    if (str(s.url)) out.url = str(s.url);
    const iv = num(s.interval);
    if (iv !== undefined) out.interval = iv;
    const tol = num(s.tolerance);
    if (tol !== undefined) out.tolerance = tol;
    if (s.lazy) out.lazy = true;
    if (str(s['expected-status'])) out['expected-status'] = str(s['expected-status']);
    const mft = num(s['max-failed-times']);
    if (mft !== undefined) out['max-failed-times'] = mft;
    const to = num(s.timeout);
    if (to !== undefined) out.timeout = to;
  }
  if (s.type === 'load-balance' && str(s.strategy)) {
    out.strategy = str(s.strategy);
  }
  if (str(s['dialer-proxy'])) out['dialer-proxy'] = str(s['dialer-proxy']);
  const rm = num(s['routing-mark']);
  if (rm !== undefined) out['routing-mark'] = rm;
  if (s['disable-udp']) out['disable-udp'] = true;
  if (s.hidden) out.hidden = true;
  if (str(s.icon)) out.icon = str(s.icon);
  return out;
}

export default function ProxyGroupsPage() {
  const [groups, setGroups] = useState<ProxyGroup[]>([]);
  const [templates, setTemplates] = useState<ProxyGroupTemplate[]>([]);
  const [subs, setSubs] = useState<SubscriptionLite[]>([]);
  const [collections, setCollections] = useState<CollectionLite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'edit' | 'create'>('view');
  /** During mode='create', show the kind picker first then the form. */
  const [createStep, setCreateStep] = useState<'pick-kind' | 'fill-form'>('pick-kind');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [gs, ts, ss, cs] = await Promise.all([
        api<{ data: ProxyGroup[] }>('/api/v1/proxy-groups'),
        api<{ data: ProxyGroupTemplate[] }>('/api/v1/proxy-group-templates'),
        api<{ data: SubscriptionLite[] }>('/api/v1/subscriptions'),
        api<{ data: CollectionLite[] }>('/api/v1/collections'),
      ]);
      setGroups(gs.data);
      setTemplates(ts.data);
      setSubs(ss.data);
      setCollections(cs.data);
      setError(null);
      setSelectedId((prev) => {
        if (prev && gs.data.some((g) => g.id === prev)) return prev;
        return gs.data[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selected = useMemo(
    () => groups.find((g) => g.id === selectedId) ?? null,
    [groups, selectedId],
  );

  function startCreate() {
    setForm(EMPTY_FORM);
    setCreateStep('pick-kind');
    setMode('create');
    setError(null);
  }

  /** Apply a kind's preset defaults and advance to the form step. */
  function pickKind(kind: ProxyGroupKind) {
    const defaults = presetDefaults(kind);
    setForm({ ...EMPTY_FORM, kind, ...defaults });
    setCreateStep('fill-form');
    setError(null);
  }

  function startEdit() {
    if (!selected) return;
    setForm(fromGroup(selected));
    setMode('edit');
    setError(null);
  }

  function cancel() {
    setMode('view');
    setError(null);
  }

  async function onSubmit() {
    if (!form.name.trim()) {
      setError('请填写策略组名称。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'create' && form.kind === 'all-auto-pair') {
        // This preset emits TWO groups. Submit through the batch endpoint
        // so it's atomic — half-failures can't leave one orphaned.
        // form.name = the select group; form.notes (re-purposed by the
        // wizard helper) = the auto group's name.
        const autoName = form.notes.trim() || `${form.name.trim()}-auto`;
        const selectPayload = {
          kind: 'all-auto-pair' as const,
          name: form.name.trim(),
          type: 'select' as const,
          'include-all-proxies': true,
          proxies: [autoName],
          ...(form.template_id ? { template_id: form.template_id } : {}),
        };
        const autoPayload = {
          kind: 'all-auto-pair' as const,
          name: autoName,
          type: 'url-test' as const,
          'include-all-proxies': true,
          ...(form.template_id ? { template_id: form.template_id } : {}),
          ...(form.url.trim() ? { url: form.url.trim() } : {}),
          ...(form.interval.trim() ? { interval: Number(form.interval) } : {}),
        };
        const res = await api<{ data: ProxyGroup[] }>('/api/v1/proxy-groups/batch', {
          method: 'POST',
          body: JSON.stringify({ groups: [selectPayload, autoPayload] }),
        });
        await reload();
        setSelectedId(res.data[0]?.id ?? null);
        setMode('view');
        return;
      }

      const payload = toPayload(form);
      if (mode === 'create') {
        const res = await api<{ data: ProxyGroup }>('/api/v1/proxy-groups', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        await reload();
        setSelectedId(res.data.id);
      } else if (mode === 'edit' && selected) {
        await api(`/api/v1/proxy-groups/${selected.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        await reload();
      }
      setMode('view');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!selected) return;
    if (!confirm(`确定删除策略组 "${selected.name}"？被引用时会拒绝删除。`)) return;
    setBusy(true);
    try {
      await api(`/api/v1/proxy-groups/${selected.id}`, { method: 'DELETE' });
      setSelectedId(null);
      setMode('view');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const groupedBySection = useMemo(() => {
    const sections = new Map<string, ProxyGroup[]>();
    for (const g of groups) {
      const key = g.section?.trim() || '未分类';
      const list = sections.get(key) ?? [];
      list.push(g);
      sections.set(key, list);
    }
    return Array.from(sections.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [groups]);

  if (!loaded) {
    return <Placeholder rows={6} />;
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-8 py-6 border-b border-[var(--color-border)]">
        <div className="flex items-baseline justify-between">
          <div>
            <h1 className="font-serif text-[24px] tracking-[-0.015em] text-[var(--color-ink)]">
              策略组
            </h1>
            <p className="text-[13px] text-[var(--color-muted)] mt-1">
              {groups.length} 个策略组 · raw 模式编辑全部 mihomo 字段;预设表单 E3 阶段会上线
            </p>
          </div>
          <Button onClick={startCreate} disabled={mode === 'create'}>
            + 新建策略组
          </Button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-[280px_1fr] overflow-hidden">
        {/* List */}
        <aside className="border-r border-[var(--color-border)] overflow-y-auto">
          {groups.length === 0 ? (
            <div className="p-6 text-[13px] text-[var(--color-muted)]">
              还没有策略组。先运行迁移脚本把 base.yaml 的 proxy-groups 块导入,或直接新建。
            </div>
          ) : (
            <div className="py-3">
              {groupedBySection.map(([section, items]) => (
                <div key={section} className="mb-4">
                  <div className="px-4 pb-1 text-[10px] tracking-[0.08em] uppercase text-[var(--color-muted)] font-semibold">
                    {section}
                  </div>
                  {items.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => {
                        setSelectedId(g.id);
                        setMode('view');
                      }}
                      className={`w-full text-left px-4 py-2 text-[13px] flex items-center gap-2 ${
                        selectedId === g.id
                          ? 'bg-[var(--color-surface)] text-[var(--color-fg)]'
                          : 'text-[var(--color-fg-soft)] hover:bg-[var(--color-surface)]'
                      }`}
                    >
                      <span className="flex-1 truncate">{g.name}</span>
                      <Badge tone="neutral">{TYPE_LABELS[g.type]}</Badge>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* Detail / form */}
        <main className="overflow-y-auto p-8">
          {error && (
            <div className="mb-4 px-4 py-3 rounded border border-[var(--color-danger)]/30 bg-[#F4D8D2] text-[var(--color-danger)] text-[13px]">
              {error}
            </div>
          )}
          {mode === 'view' && selected && (
            <DetailPanel
              group={selected}
              templates={templates}
              onEdit={startEdit}
              onDelete={onDelete}
              busy={busy}
            />
          )}
          {mode === 'view' && !selected && groups.length > 0 && (
            <div className="text-[13px] text-[var(--color-muted)]">从左侧选择一个策略组查看 / 编辑。</div>
          )}
          {mode === 'create' && createStep === 'pick-kind' && (
            <KindPicker onPick={pickKind} onCancel={cancel} />
          )}
          {((mode === 'edit') || (mode === 'create' && createStep === 'fill-form')) && (
            <FormPanel
              form={form}
              setForm={setForm}
              templates={templates}
              subs={subs}
              collections={collections}
              isCreate={mode === 'create'}
              busy={busy}
              onSubmit={onSubmit}
              onCancel={cancel}
              onChangeKind={mode === 'create' ? () => setCreateStep('pick-kind') : undefined}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function DetailPanel({
  group,
  templates,
  onEdit,
  onDelete,
  busy,
}: {
  group: ProxyGroup;
  templates: ProxyGroupTemplate[];
  onEdit: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const tpl = group.template_id ? templates.find((t) => t.id === group.template_id) ?? null : null;
  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-3">
        <h2 className="font-serif text-[20px] tracking-[-0.01em] text-[var(--color-ink)]">
          {group.name}
        </h2>
        <Badge tone="accent">{KIND_LABELS[group.kind]}</Badge>
        <Badge tone="neutral">{TYPE_LABELS[group.type]}</Badge>
        {tpl && <Badge tone="neutral">模板:{tpl.name}</Badge>}
        {group.section && <Badge tone="neutral">{group.section}</Badge>}
        <div className="ml-auto flex gap-2">
          <Button onClick={onEdit} disabled={busy}>
            编辑
          </Button>
          <Button variant="danger" onClick={onDelete} disabled={busy}>
            删除
          </Button>
        </div>
      </div>
      {group.notes && (
        <p className="text-[13px] text-[var(--color-muted)]">{group.notes}</p>
      )}
      <DetailRow label="proxies" value={group.proxies?.join(', ')} />
      <DetailRow label="use" value={group.use?.join(', ')} />
      <DetailRow label="filter" value={group.filter} />
      <DetailRow label="exclude-filter" value={group['exclude-filter']} />
      <DetailRow label="exclude-type" value={group['exclude-type']} />
      <DetailRow label="include-all-proxies" value={renderBool(group['include-all-proxies'])} />
      <DetailRow label="include-all-providers" value={renderBool(group['include-all-providers'])} />
      <DetailRow label="include-all" value={renderBool(group['include-all'])} />
      {HEALTH_TYPES.has(group.type) && (
        <>
          <DetailRow label="url" value={group.url} />
          <DetailRow label="interval" value={group.interval !== undefined ? String(group.interval) : undefined} />
          <DetailRow label="tolerance" value={group.tolerance !== undefined ? String(group.tolerance) : undefined} />
          <DetailRow label="lazy" value={renderBool(group.lazy)} />
          <DetailRow label="expected-status" value={group['expected-status']} />
          <DetailRow label="max-failed-times" value={group['max-failed-times'] !== undefined ? String(group['max-failed-times']) : undefined} />
          <DetailRow label="timeout" value={group.timeout !== undefined ? String(group.timeout) : undefined} />
        </>
      )}
      {group.type === 'load-balance' && <DetailRow label="strategy" value={group.strategy} />}
      <DetailRow label="dialer-proxy" value={group['dialer-proxy']} />
      <DetailRow label="routing-mark" value={group['routing-mark'] !== undefined ? String(group['routing-mark']) : undefined} />
      <DetailRow label="disable-udp" value={renderBool(group['disable-udp'])} />
      <DetailRow label="hidden" value={renderBool(group.hidden)} />
      <DetailRow label="icon" value={group.icon} />
      {tpl && (
        <div className="mt-6 border-t border-[var(--color-border)] pt-4 text-[12px] text-[var(--color-muted)]">
          <div className="font-medium mb-2">继承自模板「{tpl.name}」(本组未显式设置的字段):</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
            {Object.entries(tpl)
              .filter(([k]) => !['id', 'name', 'notes', 'updated_at'].includes(k))
              .map(([k, v]) => (
                <div key={k} className="font-mono text-[11px]">
                  {k}: {String(v)}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[180px_1fr] gap-3 text-[13px]">
      <div className="text-[var(--color-muted)] font-mono">{label}</div>
      <div className="text-[var(--color-fg)] break-all">{value}</div>
    </div>
  );
}

function renderBool(b: boolean | undefined): string | undefined {
  if (b === undefined) return undefined;
  return b ? 'true' : 'false';
}

/* ─── Wizard step 1: kind picker ─────────────────────────────────────── */

function KindPicker({
  onPick,
  onCancel,
}: {
  onPick: (kind: ProxyGroupKind) => void;
  onCancel: () => void;
}) {
  const ORDER: ProxyGroupKind[] = [
    'region',
    'single-sub',
    'collection-scope',
    'service',
    'all-auto-pair',
    'rule-set-policy',
    'system',
    'raw',
  ];
  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-baseline justify-between">
        <h2 className="font-serif text-[20px] tracking-[-0.01em] text-[var(--color-ink)]">
          选一种预设
        </h2>
        <Button variant="secondary" onClick={onCancel}>
          取消
        </Button>
      </div>
      <p className="text-[13px] text-[var(--color-muted)]">
        预设带智能默认值;选「自由编辑」走 raw 模式,所有 mihomo 字段都开放。
      </p>
      <div className="grid grid-cols-2 gap-3">
        {ORDER.map((kind) => (
          <button
            key={kind}
            onClick={() => onPick(kind)}
            className="text-left p-4 rounded border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-surface)] transition-colors"
          >
            <div className="flex items-baseline gap-2 mb-1">
              <span className="font-medium text-[14px] text-[var(--color-fg)]">
                {KIND_LABELS[kind]}
              </span>
              <span className="font-mono text-[11px] text-[var(--color-muted)]">{kind}</span>
            </div>
            <p className="text-[12px] text-[var(--color-muted)] leading-relaxed">
              {KIND_DESCRIPTIONS[kind]}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Preset-specific defaults applied when the user picks a kind. */
function presetDefaults(kind: ProxyGroupKind): Partial<FormState> {
  switch (kind) {
    case 'region':
      return {
        type: 'url-test',
        'include-all-proxies': true,
        url: 'http://www.gstatic.com/generate_204',
        interval: '600',
        tolerance: '50',
      };
    case 'single-sub':
      // filter is auto-generated at resolve time from sub.node_prefix.
      return { type: 'select' };
    case 'collection-scope':
      // proxies is auto-built at resolve time from member-sub nodes.
      return { type: 'select' };
    case 'rule-set-policy':
      // Typical shape: select group offering DIRECT + a region group, often
      // sharing a `*pr` template.
      return { type: 'select' };
    case 'service':
      return { type: 'select', 'include-all-proxies': true };
    case 'all-auto-pair':
      return {
        type: 'select',
        url: 'http://www.gstatic.com/generate_204',
        interval: '600',
      };
    case 'system':
      return { type: 'select' };
    case 'raw':
    default:
      return {};
  }
}

function FormPanel({
  form,
  setForm,
  templates,
  subs,
  collections,
  isCreate,
  busy,
  onSubmit,
  onCancel,
  onChangeKind,
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  templates: ProxyGroupTemplate[];
  subs: SubscriptionLite[];
  collections: CollectionLite[];
  isCreate: boolean;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onChangeKind?: () => void;
}) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm({ ...form, [k]: v });

  const boundSub = subs.find((s) => s.id === form.bound_subscription_id) ?? null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-baseline justify-between">
        <h2 className="font-serif text-[20px] tracking-[-0.01em] text-[var(--color-ink)]">
          {isCreate ? `新建 ${KIND_LABELS[form.kind]}` : `编辑 ${form.name}`}
        </h2>
        {onChangeKind && (
          <Button variant="secondary" onClick={onChangeKind}>
            换预设
          </Button>
        )}
      </div>
      <p className="text-[12px] text-[var(--color-muted)]">{KIND_DESCRIPTIONS[form.kind]}</p>

      {/* Preset-specific helpers above the main form */}
      {form.kind === 'region' && (
        <Section title="地区快填">
          <div className="flex flex-wrap gap-2">
            {REGIONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() =>
                  setForm({
                    ...form,
                    name: form.name || r.nameSuggestion,
                    filter: r.filter,
                  })
                }
                className="px-3 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[12px]"
              >
                {r.label} ({r.code})
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                const others = REGIONS.map((r) => r.filter.split('|')[0]).join('|');
                setForm({
                  ...form,
                  name: form.name || '其它',
                  filter: `^(?!.*(${others})).*`,
                });
              }}
              className="px-3 py-1.5 rounded border border-[var(--color-border)] hover:border-[var(--color-primary)] text-[12px]"
            >
              其它(负 lookahead)
            </button>
          </div>
          <p className="text-[11px] text-[var(--color-muted)]">
            点击后会回填 filter + 名称建议;你仍然可以在下方手改。
          </p>
        </Section>
      )}

      {form.kind === 'single-sub' && (
        <Section title="绑定订阅源">
          <FormField label="bound_subscription_id">
            <Select
              value={form.bound_subscription_id}
              onChange={(e) => set('bound_subscription_id', e.target.value)}
            >
              <option value="">(请选择)</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.node_prefix ? `[${s.node_prefix.trim()}]` : '(无 node_prefix)'}
                </option>
              ))}
            </Select>
          </FormField>
          {boundSub && !boundSub.node_prefix && (
            <p className="text-[12px] text-[var(--color-warn)]">
              该订阅源未设 node_prefix,filter 将无法自动生成。先到「订阅源」页设 node_prefix。
            </p>
          )}
          {boundSub && boundSub.node_prefix && (
            <p className="text-[12px] text-[var(--color-muted)]">
              渲染时 filter 自动生成为{' '}
              <code className="font-mono">{`^${boundSub.node_prefix}`}</code>;
              本表单 filter 字段会被覆盖。
            </p>
          )}
        </Section>
      )}

      {form.kind === 'collection-scope' && (
        <Section title="绑定聚合订阅">
          <FormField label="bound_collection_id">
            <Select
              value={form.bound_collection_id}
              onChange={(e) => set('bound_collection_id', e.target.value)}
            >
              <option value="">(请选择)</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.subscription_ids.length} 订阅源 +{' '}
                  {c.subscription_tags.length} 标签)
                </option>
              ))}
            </Select>
          </FormField>
          <p className="text-[12px] text-[var(--color-muted)]">
            渲染时 proxies 自动从该聚合订阅的成员节点取;本表单 proxies 字段会被覆盖。
          </p>
        </Section>
      )}

      {form.kind === 'all-auto-pair' && isCreate && (
        <Section title="两个组的命名">
          <FormField label="select 组名(name 字段)">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </FormField>
          <FormField label="url-test 组名(留空 → ${name}-auto)">
            <Input
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder={form.name ? `${form.name}-auto` : '自动'}
            />
          </FormField>
          <p className="text-[12px] text-[var(--color-muted)]">
            提交后会创建两个组:一个 select 组(`proxies: [auto 组名]`),一个 url-test 组
            (`include-all-proxies: true`,使用下方 url/interval)。
          </p>
        </Section>
      )}

      <Section title="身份">
        <FormField label="名称">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
        </FormField>
        <FormField label="kind(类型标签)">
          <Select value={form.kind} onChange={(e) => set('kind', e.target.value as ProxyGroupKind)}>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label} ({k})
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="type(mihomo 类型)">
          <Select value={form.type} onChange={(e) => set('type', e.target.value as ProxyGroupType)}>
            {Object.keys(TYPE_LABELS).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="section(UI 分段)">
          <Input value={form.section} onChange={(e) => set('section', e.target.value)} />
        </FormField>
        <FormField label="备注 notes">
          <Input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </FormField>
        <FormField label="template_id(共享模板)">
          <Select
            value={form.template_id}
            onChange={(e) => set('template_id', e.target.value)}
          >
            <option value="">(无)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </FormField>
      </Section>

      <Section title="成员">
        <FormField label="proxies(一行一项)">
          <textarea
            className="w-full font-mono text-[12px] px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] focus:border-[var(--color-primary)] focus:outline-none"
            rows={6}
            value={form.proxies}
            onChange={(e) => set('proxies', e.target.value)}
          />
        </FormField>
        <FormField label="use(provider 名,一行一项)">
          <textarea
            className="w-full font-mono text-[12px] px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] focus:border-[var(--color-primary)] focus:outline-none"
            rows={3}
            value={form.use}
            onChange={(e) => set('use', e.target.value)}
          />
        </FormField>
        <Checkbox
          label="include-all-proxies"
          checked={form['include-all-proxies']}
          onChange={(v) => set('include-all-proxies', v)}
        />
        <Checkbox
          label="include-all-providers"
          checked={form['include-all-providers']}
          onChange={(v) => set('include-all-providers', v)}
        />
        <Checkbox
          label="include-all"
          checked={form['include-all']}
          onChange={(v) => set('include-all', v)}
        />
        <FormField label="filter(正则)">
          <Input value={form.filter} onChange={(e) => set('filter', e.target.value)} />
        </FormField>
        <FormField label="exclude-filter(正则)">
          <Input
            value={form['exclude-filter']}
            onChange={(e) => set('exclude-filter', e.target.value)}
          />
        </FormField>
        <FormField label="exclude-type(逗号分隔的 proxy.type)">
          <Input
            value={form['exclude-type']}
            onChange={(e) => set('exclude-type', e.target.value)}
          />
        </FormField>
      </Section>

      {HEALTH_TYPES.has(form.type) && (
        <Section title="健康检查">
          <FormField label="url">
            <Input value={form.url} onChange={(e) => set('url', e.target.value)} />
          </FormField>
          <FormField label="interval(秒)">
            <Input value={form.interval} onChange={(e) => set('interval', e.target.value)} />
          </FormField>
          <FormField label="tolerance(ms)">
            <Input value={form.tolerance} onChange={(e) => set('tolerance', e.target.value)} />
          </FormField>
          <Checkbox label="lazy" checked={form.lazy} onChange={(v) => set('lazy', v)} />
          <FormField label="expected-status(如 200 或 200-299)">
            <Input
              value={form['expected-status']}
              onChange={(e) => set('expected-status', e.target.value)}
            />
          </FormField>
          <FormField label="max-failed-times">
            <Input
              value={form['max-failed-times']}
              onChange={(e) => set('max-failed-times', e.target.value)}
            />
          </FormField>
          <FormField label="timeout(ms)">
            <Input value={form.timeout} onChange={(e) => set('timeout', e.target.value)} />
          </FormField>
        </Section>
      )}

      {form.type === 'load-balance' && (
        <Section title="策略">
          <FormField label="strategy">
            <Select value={form.strategy} onChange={(e) => set('strategy', e.target.value)}>
              <option value="">(默认)</option>
              <option value="consistent-hashing">consistent-hashing</option>
              <option value="round-robin">round-robin</option>
              <option value="sticky-sessions">sticky-sessions</option>
            </Select>
          </FormField>
        </Section>
      )}

      <Section title="高级">
        <FormField label="dialer-proxy(链式代理上游)">
          <Input
            value={form['dialer-proxy']}
            onChange={(e) => set('dialer-proxy', e.target.value)}
          />
        </FormField>
        <FormField label="routing-mark(Linux SO_MARK)">
          <Input
            value={form['routing-mark']}
            onChange={(e) => set('routing-mark', e.target.value)}
          />
        </FormField>
        <Checkbox
          label="disable-udp"
          checked={form['disable-udp']}
          onChange={(v) => set('disable-udp', v)}
        />
        <Checkbox label="hidden(对面板隐藏)" checked={form.hidden} onChange={(v) => set('hidden', v)} />
        <FormField label="icon(图标 URL)">
          <Input value={form.icon} onChange={(e) => set('icon', e.target.value)} />
        </FormField>
      </Section>

      <div className="flex gap-3 pt-4 border-t border-[var(--color-border)]">
        <Button onClick={onSubmit} disabled={busy}>
          {busy ? '保存中…' : isCreate ? '创建' : '保存'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-[12px] uppercase tracking-[0.08em] text-[var(--color-muted)] font-semibold">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[13px] cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-[var(--color-border)]"
      />
      <span className="font-mono">{label}</span>
    </label>
  );
}
