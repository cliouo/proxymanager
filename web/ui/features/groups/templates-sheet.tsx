'use client';

import { useState } from 'react';
import { ArrowLeft, ChevronDown, LayoutTemplate, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ProxyGroupTemplate } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, confirmAction, EmptyState, Field, Input, notify, Select, Sheet, Skeleton, Textarea } from '@/ui/primitives';
import { GROUP_TYPES } from '@/ui/viz/lines';
import { useWorkspace } from './context';
import { afterTemplateWrite, templateApi } from './data';
import { DEFAULT_TEST_URL, GROUP_TYPE_ORDER, LB_STRATEGIES, TEMPLATE_FIELD_LABELS, templateFieldText } from './model';

type Spec =
  | { key: string; label: string; kind: 'text'; placeholder?: string }
  | { key: string; label: string; kind: 'int'; unit?: string; min: number; placeholder?: string }
  | { key: string; label: string; kind: 'bool' }
  | { key: string; label: string; kind: 'enum'; options: Array<{ value: string; label: string }> };

const MAIN: Spec[] = [
  { key: 'type', label: '类型', kind: 'enum', options: GROUP_TYPE_ORDER.map((t) => ({ value: t, label: GROUP_TYPES[t].label })) },
  { key: 'url', label: '测速地址', kind: 'text', placeholder: DEFAULT_TEST_URL },
  { key: 'interval', label: '测速间隔', kind: 'int', unit: '秒', min: 1, placeholder: '300' },
  { key: 'tolerance', label: '切换容差', kind: 'int', unit: '毫秒', min: 0, placeholder: '50' },
  { key: 'timeout', label: '超时', kind: 'int', unit: '毫秒', min: 1, placeholder: '5000' },
  { key: 'max-failed-times', label: '失败几次算不可用', kind: 'int', unit: '次', min: 1, placeholder: '5' },
  { key: 'expected-status', label: '期望状态码', kind: 'text', placeholder: '例如 204' },
  { key: 'lazy', label: '懒测速', kind: 'bool' },
  { key: 'strategy', label: '负载均衡策略', kind: 'enum', options: LB_STRATEGIES.map((s) => ({ value: s.value, label: s.label })) },
];

const MORE: Spec[] = [
  { key: 'include-all-proxies', label: '纳入全部节点', kind: 'bool' },
  { key: 'exclude-filter', label: '排除（正则）', kind: 'text', placeholder: '(?i)到期|剩余|官网' },
  { key: 'exclude-type', label: '排除协议类型', kind: 'text', placeholder: 'Shadowsocks|Vmess' },
  { key: 'empty-fallback', label: '空成员兜底', kind: 'text', placeholder: 'DIRECT' },
  { key: 'disable-udp', label: '禁用 UDP', kind: 'bool' },
  { key: 'hidden', label: '在客户端隐藏', kind: 'bool' },
  { key: 'icon', label: '图标地址', kind: 'text', placeholder: 'https://…/icon.png' },
  { key: 'dialer-proxy', label: '前置代理', kind: 'text' },
  { key: 'routing-mark', label: 'routing-mark', kind: 'int', min: -2147483648 },
  { key: 'include-all', label: 'include-all', kind: 'bool' },
  { key: 'include-all-providers', label: 'include-all-providers', kind: 'bool' },
];

const ALL = [...MAIN, ...MORE];
const UNSET = '__unset__';

type Values = Record<string, string>;

function toValues(t: ProxyGroupTemplate | null): Values {
  const values: Values = { name: t?.name ?? '', notes: t?.notes ?? '' };
  for (const spec of ALL) {
    const v = t ? (t as unknown as Record<string, unknown>)[spec.key] : undefined;
    values[spec.key] = v === undefined || v === null ? '' : String(v);
  }
  return values;
}

function buildBody(values: Values, original: ProxyGroupTemplate | null) {
  const body: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  const name = values.name.trim();
  if (!name) errors.name = '名字不能为空';
  else if (!/^[a-z0-9_-]+$/.test(name)) errors.name = '只能用小写字母、数字、- 和 _';
  if (!original || name !== original.name) body.name = name;
  const notes = values.notes.trim();
  if (!original) {
    if (notes) body.notes = notes;
  } else if (notes !== (original.notes ?? '')) body.notes = notes || null;

  for (const spec of ALL) {
    const raw = (values[spec.key] ?? '').trim();
    let value: unknown;
    if (raw) {
      if (spec.kind === 'int') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < spec.min) {
          errors[spec.key] = spec.min === 0 ? '请输入不小于 0 的整数' : '请输入正整数';
          continue;
        }
        value = n;
      } else if (spec.kind === 'bool') value = raw === 'true';
      else value = raw;
    }
    const before = original ? (original as unknown as Record<string, unknown>)[spec.key] : undefined;
    if (!original) {
      if (value !== undefined) body[spec.key] = value;
      continue;
    }
    if (before === value) continue;
    if (value === undefined) {
      if (spec.key === 'empty-fallback') body[spec.key] = null;
      else errors[spec.key] = '保存后无法清空这一项，请填一个值';
      continue;
    }
    body[spec.key] = value;
  }
  return { body, errors };
}

function SpecField({ spec, value, error, onChange }: { spec: Spec; value: string; error?: string; onChange: (v: string) => void }) {
  if (spec.kind === 'bool' || spec.kind === 'enum') {
    const options =
      spec.kind === 'bool'
        ? [
            { value: 'true', label: '开' },
            { value: 'false', label: '关' },
          ]
        : spec.options;
    return (
      <Field label={spec.label} error={error}>
        {(id) => (
          <Select
            id={id}
            value={value || UNSET}
            onValueChange={(v) => onChange(v === UNSET ? '' : v)}
            options={[{ value: UNSET, label: '不设置' }, ...options]}
          />
        )}
      </Field>
    );
  }
  return (
    <Field label={spec.label} error={error}>
      {(id) => (
        <Input
          id={id}
          mono={spec.kind === 'text'}
          inputMode={spec.kind === 'int' ? 'numeric' : undefined}
          value={value}
          invalid={!!error}
          placeholder={spec.placeholder}
          onChange={(event) => onChange(event.target.value)}
          trailing={spec.kind === 'int' && spec.unit ? <span className="pr-1 text-xs text-ink-3">{spec.unit}</span> : undefined}
        />
      )}
    </Field>
  );
}

function TemplateForm({
  values,
  setValues,
  errors,
}: {
  values: Values;
  setValues: (update: (v: Values) => Values) => void;
  errors: Record<string, string>;
}) {
  const [more, setMore] = useState(() => MORE.some((s) => values[s.key]));
  const set = (key: string) => (v: string) => setValues((current) => ({ ...current, [key]: v }));
  return (
    <div className="flex flex-col gap-4">
      <Field label="名字" error={errors.name} hint="小写字母、数字、- 和 _，例如 auto-test。">
        {(id) => <Input id={id} data-autofocus mono value={values.name} invalid={!!errors.name} onChange={(e) => set('name')(e.target.value)} />}
      </Field>
      <Field label="说明" optional>
        {(id) => <Textarea id={id} rows={2} className="min-h-[56px]" value={values.notes} onChange={(e) => set('notes')(e.target.value)} />}
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {MAIN.map((spec) => (
          <div key={spec.key} className={cn(spec.key === 'url' && 'sm:col-span-2')}>
            <SpecField spec={spec} value={values[spec.key]} error={errors[spec.key]} onChange={set(spec.key)} />
          </div>
        ))}
      </div>
      <button
        type="button"
        aria-expanded={more}
        onClick={() => setMore((v) => !v)}
        className="flex items-center gap-1.5 self-start text-xs font-medium text-ink-2 hover:text-ink"
      >
        <ChevronDown size={14} className={cn('transition-transform', more && 'rotate-180')} />
        更多字段
      </button>
      {more && (
        <div className="grid animate-fade-in gap-3 sm:grid-cols-2">
          {MORE.map((spec) => (
            <SpecField key={spec.key} spec={spec} value={values[spec.key]} error={errors[spec.key]} onChange={set(spec.key)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function TemplatesSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const ws = useWorkspace();
  const [editing, setEditing] = useState<ProxyGroupTemplate | null>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [busy, setBusy] = useState(false);
  const templates = ws.templates;

  const startEdit = (t: ProxyGroupTemplate | null) => {
    setEditing(t);
    setValues(toValues(t));
  };
  const back = () => {
    setEditing(null);
    setValues(null);
  };
  const result = values ? buildBody(values, editing) : null;
  const errorCount = result ? Object.keys(result.errors).length : 0;

  const save = async () => {
    if (!result || errorCount > 0) return;
    setBusy(true);
    try {
      if (editing) {
        if (Object.keys(result.body).length > 0) await templateApi.patch(editing.id, result.body);
      } else {
        await templateApi.create(result.body);
      }
      afterTemplateWrite();
      notify.success(editing ? '模版已保存' : '模版已创建', '所有引用它的策略组都会用上新值');
      back();
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: ProxyGroupTemplate) => {
    const users = ws.groups.filter((g) => g.template_id === t.id);
    const ok = await confirmAction({
      title: `删除模版「${t.name}」？`,
      description: users.length
        ? `这份配置里还有 ${users.length} 个策略组在用它，需要先在这些组里取消引用。`
        : '其他配置文件若还在用它，删除会被拒绝。',
      confirmText: '删除',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await templateApi.remove(t.id);
      afterTemplateWrite();
      notify.success(`已删除模版「${t.name}」`);
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) back();
        onOpenChange(next);
      }}
      width={560}
      title={values ? (editing ? `编辑模版 ${editing.name}` : '新建模版') : '策略组模版'}
      description={
        values ? '只填需要共用的字段，留空的不会写进模版。' : '模版保存一组共用的默认值。策略组引用后，自己没填的字段从模版继承。模版在所有配置文件间共享。'
      }
      footer={
        values ? (
          <>
            <Button variant="ghost" icon={ArrowLeft} onClick={back}>
              返回
            </Button>
            <Button variant="primary" loading={busy} disabled={errorCount > 0} onClick={() => void save()}>
              {editing ? '保存' : '创建'}
            </Button>
          </>
        ) : (
          <Button variant="primary" icon={Plus} onClick={() => startEdit(null)}>
            新建模版
          </Button>
        )
      }
    >
      {values ? (
        <TemplateForm values={values} setValues={(update) => setValues((v) => (v ? update(v) : v))} errors={result?.errors ?? {}} />
      ) : !templates ? (
        <div className="flex flex-col gap-3">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          compact
          icon={LayoutTemplate}
          title="还没有模版"
          description="比如把测速地址、间隔和容差存成一个模版，所有地区测速组共用。"
          actions={
            <Button size="sm" icon={Plus} onClick={() => startEdit(null)}>
              新建模版
            </Button>
          }
        />
      ) : (
        <ul className="-my-3 flex flex-col divide-y divide-line">
          {templates.map((t) => {
            const users = ws.groups.filter((g) => g.template_id === t.id).length;
            const fields = Object.keys(TEMPLATE_FIELD_LABELS).filter(
              (key) => (t as unknown as Record<string, unknown>)[key] !== undefined,
            );
            return (
              <li key={t.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[13px] font-medium text-ink">{t.name}</span>
                    {users > 0 && <Badge tone="accent">本配置 {users} 个组在用</Badge>}
                  </div>
                  {t.notes && <p className="mt-0.5 text-xs text-ink-3">{t.notes}</p>}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {fields.length === 0 && <span className="text-[11px] text-ink-4">没有设置字段</span>}
                    {fields.map((key) => (
                      <span key={key} className="inline-flex h-5 items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 text-[11px]">
                        <span className="text-ink-3">{TEMPLATE_FIELD_LABELS[key]}</span>
                        <span className="font-mono text-ink-2">
                          {key === 'type'
                            ? GROUP_TYPES[t.type as keyof typeof GROUP_TYPES]?.label
                            : templateFieldText(key, (t as unknown as Record<string, unknown>)[key])}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => startEdit(t)}>
                    编辑
                  </Button>
                  <Button size="sm" variant="danger-ghost" iconOnly icon={Trash2} aria-label={`删除模版 ${t.name}`} onClick={() => void remove(t)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
