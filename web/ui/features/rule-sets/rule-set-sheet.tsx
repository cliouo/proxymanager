'use client';

import { useMemo, useState } from 'react';
import { Button as UiButton } from '@ui-sdk/react/button';
import { CloudDownload, Globe, HardDrive, Link2, Trash2 } from 'lucide-react';
import { api } from '@/ui/data/api';
import { refreshShared, useRuleSet } from '@/ui/data/hooks';
import type { RuleSet, RuleSetListItem } from '@/ui/data/types';
import { CodeEditor } from '@/ui/editor/code-editor';
import { cn } from '@/ui/lib/cn';
import {
  Button,
  Combobox,
  CopyButton,
  Field,
  Input,
  notify,
  SegmentedControl,
  Sheet,
  Skeleton,
  Tooltip,
} from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { PolicyChip } from '@/ui/viz/lines';
import { usePolicyOptions } from '@/ui/features/rules/composer';
import { ruleText } from '@/ui/features/rules/rule-model';
import {
  BEHAVIOR_META,
  contentPlaceholder,
  countEntries,
  FORMAT_META,
  INTERVAL_PRESETS,
  NAME_RE,
  sourceOf,
  type Behavior,
  type Format,
  type Source,
  type Usage,
} from './model';

export type SheetTarget = { kind: 'create' } | { kind: 'edit'; id: string };

interface Form {
  name: string;
  source: Source;
  format: Format;
  behavior: Behavior | '';
  content: string;
  url: string;
  interval: string;
  proxy: string;
  note: string;
}

const EMPTY: Form = {
  name: '',
  source: 'local',
  format: 'text',
  behavior: 'domain',
  content: '',
  url: '',
  interval: '',
  proxy: '',
  note: '',
};

function formOf(set: RuleSet): Form {
  return {
    name: set.name,
    source: sourceOf(set),
    format: set.format,
    behavior: set.behavior ?? '',
    content: set.content ?? '',
    url: set.url ?? '',
    interval: set.interval ? String(set.interval) : '',
    proxy: set.proxy ?? '',
    note: set.note ?? '',
  };
}

function validate(form: Form, taken: Set<string>, original?: string) {
  const errors: Partial<Record<keyof Form, string>> = {};
  if (!form.name) errors.name = '请填写名称';
  else if (!NAME_RE.test(form.name)) errors.name = '只能用小写字母、数字、- 和 _';
  else if (form.name !== original && taken.has(form.name)) errors.name = '已经有同名的规则集';
  if (!form.behavior) errors.behavior = '请选择行为，客户端需要它来解析规则集';
  if (form.format === 'mrs' && form.behavior === 'classical') errors.behavior = 'mrs 只支持域名或 IP 段';
  if (form.source === 'local') {
    if (form.format === 'mrs') errors.format = '本地托管不支持 mrs，请用 text 或 yaml';
    if (!form.content.trim()) errors.content = '本地规则集需要内容';
  } else if (!/^https?:\/\/\S+$/i.test(form.url.trim())) {
    errors.url = '请填写 http(s) 开头的地址';
  }
  if (form.interval && !(Number.isInteger(Number(form.interval)) && Number(form.interval) > 0)) {
    errors.interval = '请填写正整数（秒）';
  }
  return errors;
}

export function RuleSetSheet({
  target,
  onClose,
  profileId,
  profileName,
  sets,
  usage,
  policies,
  hostedBase,
  onDelete,
  onLocalize,
}: {
  target: SheetTarget | null;
  onClose: () => void;
  profileId: string | undefined;
  profileName: string;
  sets: RuleSetListItem[];
  usage: Map<string, Usage>;
  policies: string[] | undefined;
  hostedBase: string | undefined;
  onDelete: (set: RuleSetListItem) => void;
  onLocalize: (set: RuleSetListItem) => Promise<boolean>;
}) {
  const editId = target?.kind === 'edit' ? target.id : null;
  const detail = useRuleSet(editId);
  const meta = sets.find((s) => s.id === editId);
  const initial = editId ? detail.data : undefined;
  const formKey = target ? (editId ? (initial ? `${initial.id}:${initial.updated_at}` : null) : 'create') : null;

  const [form, setForm] = useState<Form>(EMPTY);
  const [formFor, setFormFor] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localizing, setLocalizing] = useState(false);
  // Derived state: (re)initialise the form whenever a different record arrives.
  if (formKey && formKey !== formFor) {
    setFormFor(formKey);
    setForm(initial ? formOf(initial) : EMPTY);
    setTouched(false);
  }

  const taken = useMemo(() => new Set(sets.map((s) => s.name)), [sets]);
  const errors = validate(form, taken, initial?.name);
  const valid = Object.keys(errors).length === 0;
  const original = initial ? formOf(initial) : null;
  const dirty = !original || (Object.keys(form) as Array<keyof Form>).some((k) => form[k] !== original[k]);
  const policyOptions = usePolicyOptions(policies);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const show = (key: keyof Form) => (touched ? errors[key] : undefined);
  const use = meta ? usage.get(meta.name) : undefined;
  const inUse = !!use && (use.active.length > 0 || use.disabled.length > 0 || use.inBase);

  const submit = async () => {
    setTouched(true);
    if (!valid || saving || !profileId) return;
    const interval = form.interval ? Number(form.interval) : undefined;
    setSaving(true);
    try {
      if (!initial) {
        const body = {
          name: form.name,
          source: form.source,
          format: form.format,
          behavior: form.behavior || undefined,
          note: form.note.trim() || undefined,
          interval,
          proxy: form.proxy.trim() || undefined,
          ...(form.source === 'local' ? { content: form.content } : { url: form.url.trim() }),
        };
        await api.post<RuleSet>('/rule-sets', body, { profileId });
        notify.success(`已创建规则集「${form.name}」`, '在规则里用 RULE-SET 引用它后，才会写入最终配置。');
      } else {
        const patch: Record<string, unknown> = {};
        const o = formOf(initial);
        if (form.name !== o.name) patch.name = form.name;
        if (form.source !== o.source) patch.source = form.source;
        if (form.format !== o.format) patch.format = form.format;
        if (form.behavior !== o.behavior) patch.behavior = form.behavior || null;
        if (form.source === 'local' && form.content !== o.content) patch.content = form.content;
        if (form.source === 'remote' && form.url.trim() !== o.url) patch.url = form.url.trim();
        if (form.interval !== o.interval) patch.interval = interval ?? null;
        if (form.proxy.trim() !== o.proxy) patch.proxy = form.proxy.trim() || null;
        if (form.note.trim() !== o.note) patch.note = form.note.trim() || null;
        await api.patch<RuleSet>(`/rule-sets/${initial.id}`, patch, { profileId }, { 'If-Match': `"${initial.updated_at}"` });
        notify.success(
          '规则集已保存',
          patch.name ? '引用它的规则已同步改名。' : inUse ? '引用它的配置文件会在下次更新时拿到新内容。' : undefined,
        );
      }
      refreshShared();
      onClose();
    } catch (error) {
      notify.error(error, '保存失败');
      if ((error as { status?: number }).status === 412) void detail.refetch();
    } finally {
      setSaving(false);
    }
  };

  useHotkey('mod+s', () => void submit(), { enabled: !!target });

  const localize = async () => {
    if (!meta) return;
    setLocalizing(true);
    const ok = await onLocalize(meta);
    setLocalizing(false);
    if (ok) void detail.refetch();
  };

  const loading = !!editId && !initial;
  const hostedUrl = hostedBase && initial && sourceOf(initial) === 'local' ? `${hostedBase}/${initial.name}` : null;

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      width={600}
      title={initial ? <span className="font-mono">{initial.name}</span> : editId ? '规则集' : '新建规则集'}
      description={
        initial
          ? '规则集全局共享：修改会影响所有引用它的配置文件。'
          : '规则集是一组域名或 IP，可被多条规则用 RULE-SET 引用。'
      }
      footer={
        <>
          {meta && (
            <Tooltip content={inUse ? '还有规则或基础配置在引用它，先改掉这些引用' : undefined}>
              <span className="mr-auto">
                <Button variant="danger-ghost" size="sm" icon={Trash2} disabled={inUse || saving} onClick={() => onDelete(meta)}>
                  删除
                </Button>
              </span>
            </Tooltip>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={saving}
            disabled={loading || (!!initial && !dirty)}
            data-agent-confirm={initial ? `保存规则集「${form.name}」` : `创建规则集「${form.name || '新规则集'}」`}
          >
            {initial ? '保存' : '创建'}
          </Button>
        </>
      }
    >
      {loading ? (
        detail.error ? (
          <p className="text-sm text-bad">加载失败：{(detail.error as Error).message}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-48 w-full" />
          </div>
        )
      ) : (
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {initial && use && (
            <UsageCard usage={use} profileName={profileName} hostedUrl={hostedUrl} />
          )}

          <Field
            label="名称"
            error={show('name')}
            hint={initial ? '在规则里以这个名字引用。改名会同步更新引用它的规则。' : '在规则里以这个名字引用，如 RULE-SET,cn-direct。'}
          >
            {(id) => (
              <Input
                id={id}
                mono
                value={form.name}
                invalid={!!show('name')}
                autoFocus={!initial}
                placeholder="例如 streaming-cn"
                onChange={(event) => set('name', event.target.value.trim().toLowerCase())}
              />
            )}
          </Field>

          <Field label="来源" hint={form.source === 'local' ? '内容存在这里，由本服务提供下载地址。' : '客户端直接从这个地址下载，这里不保存内容。'}>
            {() => (
              <SegmentedControl<Source>
                label="来源"
                value={form.source}
                stretch
                onChange={(value) => {
                  set('source', value);
                  if (value === 'local' && form.format === 'mrs') set('format', 'text');
                }}
                options={[
                  { value: 'local', label: '本地托管', icon: HardDrive },
                  { value: 'remote', label: '远程地址', icon: Globe },
                ]}
              />
            )}
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="格式" error={show('format')} hint={FORMAT_META[form.format]}>
              {() => (
                <SegmentedControl<Format>
                  label="格式"
                  value={form.format}
                  stretch
                  size="sm"
                  onChange={(value) => set('format', value)}
                  options={[
                    { value: 'text', label: 'text' },
                    { value: 'yaml', label: 'yaml' },
                    { value: 'mrs', label: 'mrs', disabled: form.source === 'local', hint: form.source === 'local' ? '本地托管不支持 mrs' : undefined },
                  ]}
                />
              )}
            </Field>
            <Field label="行为" error={show('behavior')} hint={form.behavior ? BEHAVIOR_META[form.behavior].hint : undefined}>
              {() => (
                <SegmentedControl<Behavior | ''>
                  label="行为"
                  value={form.behavior}
                  stretch
                  size="sm"
                  onChange={(value) => set('behavior', value)}
                  options={(Object.keys(BEHAVIOR_META) as Behavior[]).map((value) => ({
                    value,
                    label: BEHAVIOR_META[value].label,
                    disabled: form.format === 'mrs' && value === 'classical',
                  }))}
                />
              )}
            </Field>
          </div>

          {form.source === 'local' ? (
            <Field
              label={
                <span className="flex w-full items-center justify-between">
                  内容
                  <span className="tnum font-normal text-ink-3">{countEntries(form.content)} 条</span>
                </span>
              }
              error={show('content')}
              hint={original?.source === 'remote' ? '从远程改为本地托管时，可以用「下载到本地」直接把远程内容取过来。' : undefined}
            >
              {() => (
                <div
                  className={cn(
                    'overflow-hidden rounded-lg border bg-surface shadow-xs',
                    show('content') ? 'border-bad' : 'border-line',
                  )}
                >
                  <CodeEditor
                    label="规则集内容"
                    value={form.content}
                    onChange={(value) => set('content', value)}
                    language={form.format === 'yaml' ? 'yaml' : 'text'}
                    placeholder={contentPlaceholder(form.format, (form.behavior || 'classical') as Behavior)}
                    height="300px"
                  />
                </div>
              )}
            </Field>
          ) : (
            <Field label="地址" error={show('url')} hint="客户端会按更新间隔从这里重新下载。">
              {(id) => (
                <Input
                  id={id}
                  mono
                  value={form.url}
                  invalid={!!show('url')}
                  placeholder="https://example.com/rules/reject.txt"
                  onChange={(event) => set('url', event.target.value)}
                />
              )}
            </Field>
          )}

          {initial && sourceOf(initial) === 'remote' && initial.format !== 'mrs' && (
            <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">
              <CloudDownload size={15} className="mt-0.5 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1 text-xs leading-relaxed text-ink-2">
                <div className="text-[13px] font-medium text-ink">转为本地托管</div>
                现在下载一次远程内容存到这里，之后由本服务提供，不再依赖原地址。
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={localizing}
                data-agent-confirm={`将规则集「${meta?.name ?? ''}」下载到本地托管`}
                onClick={() => void localize()}
              >
                下载到本地
              </Button>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="更新间隔" optional error={show('interval')} hint="留空为每天（86400 秒）。">
              {(id) => (
                <div className="flex flex-col gap-1.5">
                  <Input
                    id={id}
                    mono
                    inputMode="numeric"
                    value={form.interval}
                    invalid={!!show('interval')}
                    placeholder="86400"
                    trailing={<span className="pr-1 text-2xs text-ink-3">秒</span>}
                    onChange={(event) => set('interval', event.target.value.replace(/[^\d]/g, ''))}
                  />
                  <div className="flex flex-wrap gap-1">
                    {INTERVAL_PRESETS.map((preset) => (
                      <UiButton
                        key={preset.value}
                        type="button"
                        onClick={() => set('interval', String(preset.value))}
                        className={cn(
                          'h-6 rounded-md border px-2 text-2xs transition-colors',
                          form.interval === String(preset.value)
                            ? 'border-accent-line bg-accent-soft text-accent'
                            : 'border-line text-ink-2 hover:bg-surface-2',
                        )}
                      >
                        {preset.label}
                      </UiButton>
                    ))}
                  </div>
                </div>
              )}
            </Field>
            <Field
              label={
                <span className="flex w-full items-center justify-between">
                  <span>
                    下载代理 <span className="font-normal text-ink-4">可选</span>
                  </span>
                  {form.proxy && (
                    <UiButton type="button" aria-label="清除下载代理" className="font-normal text-accent hover:underline" onClick={() => set('proxy', '')}>
                      清除
                    </UiButton>
                  )}
                </span>
              }
              hint="客户端通过哪个策略下载它，不指定则直连。"
            >
              {(id) => (
                <Combobox
                  id={id}
                  value={form.proxy || null}
                  onChange={(value) => set('proxy', value)}
                  options={policyOptions}
                  allowCustom
                  placeholder="不指定"
                  renderValue={(value) => <PolicyChip policy={value} size="sm" />}
                />
              )}
            </Field>
          </div>

          <Field label="备注" optional>
            {(id) => (
              <Input id={id} value={form.note} placeholder="这组规则是做什么的" onChange={(event) => set('note', event.target.value)} />
            )}
          </Field>
        </form>
      )}
    </Sheet>
  );
}

function UsageCard({ usage, profileName, hostedUrl }: { usage: Usage; profileName: string; hostedUrl: string | null }) {
  const rules = [...usage.active, ...usage.disabled];
  return (
    <div className="rounded-xl border border-line bg-surface-2/50">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className={cn('size-1.5 rounded-full', usage.injected ? 'bg-ok' : 'bg-ink-4')} />
        <span className="text-[13px] font-medium text-ink">
          {usage.injected ? `写入了「${profileName}」的最终配置` : `「${profileName}」没有使用它`}
        </span>
      </div>
      {(rules.length > 0 || usage.inBase) && (
        <ul className="flex flex-col gap-1 border-t border-line px-3.5 py-2.5">
          {usage.inBase && <li className="text-xs text-ink-2">基础配置正文直接引用（如 DNS 的 nameserver-policy）</li>}
          {rules.slice(0, 6).map((rule) => (
            <li key={rule.id} className={cn('flex min-w-0 items-center gap-2 text-xs', rule.enabled === false && 'opacity-50')}>
              <span className="w-14 shrink-0 truncate font-mono text-[11px] text-ink-3">{rule.anchor}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{ruleText(rule)}</span>
              {rule.enabled === false && <span className="shrink-0 text-2xs text-ink-3">已停用</span>}
            </li>
          ))}
          {rules.length > 6 && <li className="text-2xs text-ink-3">还有 {rules.length - 6} 条</li>}
        </ul>
      )}
      {hostedUrl && (
        <div className="flex items-center gap-2 border-t border-line py-1.5 pl-3.5 pr-1.5">
          <Link2 size={13} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-3" title={hostedUrl}>
            {hostedUrl}
          </span>
          <CopyButton text={hostedUrl} size="sm" label="复制托管地址" message="已复制托管地址" />
        </div>
      )}
    </div>
  );
}
