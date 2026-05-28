'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { FormField } from '@/components/ui/FormField';
import { Input, Select, Textarea } from '@/components/ui/Input';
import type { ProxyGroup, ProxyGroupKind, ProxyGroupTemplate, ProxyGroupType } from '@/schemas';
import {
  COMMON_SECTIONS,
  escapeRegex,
  HEALTH_TYPES,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
  membershipMode,
  toPayload,
  TYPE_GLYPH,
  TYPE_LABELS,
  yamlPreview,
  type FormState,
  type SubscriptionLite,
} from '../_lib/model';
import { singleSubPreview } from '../_lib/useAvailableMembers';
import { MemberComposer } from './MemberComposer';

/** Reverse/forward reference summary for the editing group's current name. */
export interface RefSummary {
  rules: number;
  refIn: string[];
  refOut: string[];
}

interface GroupEditorProps {
  form: FormState;
  setForm: (next: FormState) => void;
  templates: ProxyGroupTemplate[];
  subs: SubscriptionLite[];
  groups: ProxyGroup[];
  nodeNames: string[];
  previewError: string | null;
  isCreate: boolean;
  originalName: string;
  refSummary: RefSummary | null;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onBackToPicker?: () => void;
}

export function GroupEditor({
  form,
  setForm,
  templates,
  subs,
  groups,
  nodeNames,
  previewError,
  isCreate,
  originalName,
  refSummary,
  busy,
  onSubmit,
  onCancel,
  onBackToPicker,
}: GroupEditorProps) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const mode = membershipMode(form.kind);
  const isHealth = HEALTH_TYPES.has(form.type);

  // ── bound-kind previews ───────────────────────────────────────────
  const boundSub = subs.find((s) => s.id === form.bound_subscription_id) ?? null;
  const subNodes = useMemo(
    () => (mode === 'bound-sub' ? singleSubPreview(nodeNames, boundSub?.node_prefix) : []),
    [mode, nodeNames, boundSub],
  );
  const tpl = form.template_id ? templates.find((t) => t.id === form.template_id) ?? null : null;

  // ── effective rendered fields for the YAML preview ────────────────
  const effective = useMemo(() => {
    const p = toPayload(form) as Record<string, unknown>;
    if (mode === 'bound-sub' && boundSub?.node_prefix) {
      p['include-all-proxies'] = true;
      p.filter = `^${escapeRegex(boundSub.node_prefix)}`;
    }
    return p;
  }, [form, mode, boundSub]);

  function handleSave() {
    const renaming = !isCreate && originalName && form.name.trim() !== originalName;
    const refIn = refSummary?.refIn.length ?? 0;
    const rules = refSummary?.rules ?? 0;
    if (renaming && refIn + rules > 0) {
      const ok = confirm(
        `「${originalName}」被 ${rules} 条规则 + ${refIn} 个策略组引用。\n改名为「${form.name.trim()}」会自动同步这些引用。继续?`,
      );
      if (!ok) return;
    }
    onSubmit();
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header: title + type + change-preset */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="font-serif text-[20px] tracking-[-0.01em] text-[var(--color-ink)] flex-1 min-w-0 truncate">
            {isCreate ? `新建 · ${KIND_LABELS[form.kind]}` : `编辑 · ${form.name || originalName}`}
          </h2>
          <div className="w-44 shrink-0">
            <Select value={form.type} onChange={(e) => set('type', e.target.value as ProxyGroupType)}>
              {Object.keys(TYPE_LABELS).map((t) => (
                <option key={t} value={t}>
                  {TYPE_GLYPH[t as ProxyGroupType]} {t}
                </option>
              ))}
            </Select>
          </div>
          {onBackToPicker && (
            <Button type="button" variant="secondary" onClick={onBackToPicker}>
              换预设
            </Button>
          )}
        </div>
        <p className="text-[12px] text-[var(--color-muted)]">{KIND_DESCRIPTIONS[form.kind]}</p>
      </div>

      {/* Name + section (用途) — section 是用户语义,不影响渲染,但驱动侧栏分段 */}
      <div className="grid grid-cols-[1fr_240px] gap-3">
        <FormField label="名称">
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="策略组名称" />
        </FormField>
        <FormField label="用途 / 分段 (section)">
          <Input
            value={form.section}
            onChange={(e) => set('section', e.target.value)}
            placeholder="如 规则集 / 系统 / 地区"
            list="proxy-group-sections"
          />
          <datalist id="proxy-group-sections">
            {COMMON_SECTIONS.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </FormField>
      </div>

      {/* Membership — varies by kind */}
      {mode === 'composer' && (
        <MemberComposer
          selfName={form.name}
          proxies={form.proxies}
          filter={form.filter}
          excludeFilter={form['exclude-filter']}
          includeAllProxies={form['include-all-proxies']}
          autoActive={form['include-all-proxies'] || form['include-all-providers'] || form['include-all']}
          onProxies={(next) => set('proxies', next)}
          onFilter={(v) => set('filter', v)}
          onExcludeFilter={(v) => set('exclude-filter', v)}
          onIncludeAllProxies={(v) => set('include-all-proxies', v)}
          onRegionFill={(filter, nameSuggestion) =>
            setForm({ ...form, filter, name: form.name || nameSuggestion })
          }
          nodeNames={nodeNames}
          subs={subs}
          groups={groups}
          previewError={previewError}
          // kind tunes the composer:
          //   manual → only manual chips (auto hidden)
          //   filter → emphasize filter; manual additions allowed
          //   all    → emphasize the include-all toggle; manual hidden
          //   raw    → both visible, no emphasis
          showAuto={form.kind !== 'manual'}
          showManual={form.kind !== 'all'}
          emphasizeAuto={form.kind === 'filter' || form.kind === 'all'}
        />
      )}

      {mode === 'bound-sub' && (
        <div className="space-y-3">
          <FormField label="绑定订阅源">
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
              该订阅源未设 node_prefix,渲染时无法自动生成 filter。先到「订阅源」页设好再回来。
            </p>
          )}
          {boundSub?.node_prefix && (
            <ReadonlyMemberPreview
              caption={
                <>
                  渲染时自动 <code className="font-mono">include-all-proxies</code> +{' '}
                  <code className="font-mono">filter: ^{boundSub.node_prefix}</code>
                </>
              }
              nodes={subNodes}
              previewError={previewError}
            />
          )}
        </div>
      )}

      {/* Health-check drawer */}
      {isHealth && (
        <Drawer title="健康检查" subtitle={`${form.type} · 自动测速参数`}>
          <div className="space-y-3">
            <FormField label="url(测速地址)">
              <Input value={form.url} onChange={(e) => set('url', e.target.value)} className="font-mono text-[12px]" />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="interval(秒)">
                <Input value={form.interval} onChange={(e) => set('interval', e.target.value)} />
              </FormField>
              {form.type === 'url-test' && (
                <FormField label="tolerance(ms)">
                  <Input value={form.tolerance} onChange={(e) => set('tolerance', e.target.value)} />
                </FormField>
              )}
            </div>
            <Check label="lazy(选中才探测)" checked={form.lazy} onChange={(v) => set('lazy', v)} />
            <div className="grid grid-cols-2 gap-3">
              <FormField label="expected-status">
                <Input value={form['expected-status']} onChange={(e) => set('expected-status', e.target.value)} placeholder="200 或 200-299" />
              </FormField>
              <FormField label="timeout(ms)">
                <Input value={form.timeout} onChange={(e) => set('timeout', e.target.value)} />
              </FormField>
            </div>
            <FormField label="max-failed-times">
              <Input value={form['max-failed-times']} onChange={(e) => set('max-failed-times', e.target.value)} />
            </FormField>
          </div>
        </Drawer>
      )}

      {/* Advanced drawer — every remaining mihomo + metadata field */}
      <Drawer title="高级" subtitle="全部 mihomo 字段 + 类型标签">
        <div className="space-y-3">
          <FormField label="kind(类型镜头 — 决定上方表单形态)">
            <Select value={form.kind} onChange={(e) => set('kind', e.target.value as ProxyGroupKind)}>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="共享模板">
            <Select value={form.template_id} onChange={(e) => set('template_id', e.target.value)}>
              <option value="">(无)</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="备注">
            <Input value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </FormField>
          <FormField label="use(provider 名,一行一项)">
            <Textarea rows={2} value={form.use} onChange={(e) => set('use', e.target.value)} />
          </FormField>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Check label="include-all-providers" checked={form['include-all-providers']} onChange={(v) => set('include-all-providers', v)} />
            <Check label="include-all" checked={form['include-all']} onChange={(v) => set('include-all', v)} />
            <Check label="disable-udp" checked={form['disable-udp']} onChange={(v) => set('disable-udp', v)} />
            <Check label="hidden" checked={form.hidden} onChange={(v) => set('hidden', v)} />
          </div>
          <FormField label="exclude-type(逗号分隔 proxy.type)">
            <Input value={form['exclude-type']} onChange={(e) => set('exclude-type', e.target.value)} placeholder="如 Direct,Reject" />
          </FormField>
          {form.type === 'load-balance' && (
            <FormField label="strategy(负载均衡策略)">
              <Select value={form.strategy} onChange={(e) => set('strategy', e.target.value)}>
                <option value="">(默认)</option>
                <option value="consistent-hashing">consistent-hashing</option>
                <option value="round-robin">round-robin</option>
                <option value="sticky-sessions">sticky-sessions</option>
              </Select>
            </FormField>
          )}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="dialer-proxy(链式上游)">
              <Input value={form['dialer-proxy']} onChange={(e) => set('dialer-proxy', e.target.value)} className="font-mono text-[12px]" />
            </FormField>
            <FormField label="routing-mark(Linux SO_MARK)">
              <Input value={form['routing-mark']} onChange={(e) => set('routing-mark', e.target.value)} />
            </FormField>
          </div>
          <FormField label="icon(图标 URL)">
            <Input value={form.icon} onChange={(e) => set('icon', e.target.value)} className="font-mono text-[12px]" />
          </FormField>
        </div>
      </Drawer>

      {/* Rendered YAML preview */}
      <Drawer title="渲染预览" subtitle="本组生成的 YAML">
        {tpl && (
          <p className="text-[11px] text-[var(--color-muted)] mb-2">
            另继承共享模板「{tpl.name}」中本组未显式设置的字段。
          </p>
        )}
        <pre className="text-[11px] font-mono leading-relaxed bg-[var(--color-bg-sunk)] rounded-lg p-3 overflow-x-auto text-[var(--color-fg-soft)]">
          {yamlPreview(effective)}
        </pre>
      </Drawer>

      {/* Reference relations */}
      {!isCreate && refSummary && (refSummary.rules > 0 || refSummary.refIn.length > 0 || refSummary.refOut.length > 0) && (
        <Drawer title="引用关系" subtitle={`← ${refSummary.rules} 规则 · ← ${refSummary.refIn.length} 组 · → ${refSummary.refOut.length} 组`}>
          <div className="space-y-2 text-[12px]">
            <RefLine label="规则指向本组" value={refSummary.rules > 0 ? `${refSummary.rules} 条规则的 policy 指向「${originalName}」` : undefined} />
            <RefLine label="其他组引用本组" value={refSummary.refIn.length > 0 ? refSummary.refIn.join(' · ') : undefined} />
            <RefLine label="本组引用的组" value={refSummary.refOut.length > 0 ? refSummary.refOut.join(' · ') : undefined} />
          </div>
        </Drawer>
      )}

      {/* Actions */}
      <div className="flex gap-3 pt-2 border-t border-[var(--color-border)]">
        <Button onClick={handleSave} disabled={busy}>
          {busy ? '保存中…' : isCreate ? '创建' : '保存'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}

/* ─── helpers ────────────────────────────────────────────────────────── */

function ReadonlyMemberPreview({
  caption,
  nodes,
  previewError,
}: {
  caption: ReactNode;
  nodes: string[];
  previewError: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-sunk)] p-3 space-y-2">
      <p className="text-[12px] text-[var(--color-muted)]">{caption}</p>
      {previewError ? (
        <p className="text-[12px] text-[var(--color-warn)]">节点列表暂不可用,无法预览命中数。</p>
      ) : (
        <div className="text-[12px]">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[var(--color-fg-soft)] hover:text-[var(--color-fg)]"
          >
            当前命中 <strong className="text-[var(--color-primary-hover)]">{nodes.length}</strong> 个节点{' '}
            <span className="text-[var(--color-muted)]">{open ? '收起 ▴' : '展开 ▾'}</span>
          </button>
          {open && (
            <div className="mt-2 max-h-48 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 flex flex-wrap gap-1">
              {nodes.length === 0 ? (
                <span className="text-[var(--color-muted)]">无节点</span>
              ) : (
                nodes.map((n) => (
                  <span key={n} className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-bg-sunk)] text-[var(--color-fg-soft)]">
                    {n}
                  </span>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RefLine({ label, value }: { label: string; value: string | undefined }) {
  if (!value) return null;
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <span className="text-[var(--color-muted)]">{label}</span>
      <span className="text-[var(--color-fg)]">{value}</span>
    </div>
  );
}

function Drawer({
  title,
  subtitle,
  defaultOpen,
  children,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-[13px] hover:bg-[var(--color-surface-hover)]"
      >
        <span className="text-[var(--color-muted)]">{open ? '▾' : '▸'}</span>
        <span className="font-medium text-[var(--color-fg)]">{title}</span>
        {subtitle && <span className="text-[12px] text-[var(--color-muted)]">{subtitle}</span>}
      </button>
      {open && <div className="px-4 pb-4 pt-1 border-t border-[var(--color-border)]">{children}</div>}
    </div>
  );
}

function Check({
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
      <span className="font-mono text-[12px]">{label}</span>
    </label>
  );
}
