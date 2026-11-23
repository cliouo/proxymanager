'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, TriangleAlert } from 'lucide-react';
import { refreshShared, useSources } from '@/ui/data/hooks';
import type { SubscriptionUpdate } from '@/ui/data/types';
import { CodeEditor } from '@/ui/editor/code-editor';
import { Button, Card, Field, Input, notify, Switch, TagInput } from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { SaveBar } from '@/ui/shell/page';
import { deleteSource, patchSource } from './actions';
import {
  DEFAULT_UA,
  headersToRows,
  msToMinutes,
  rowsToHeaders,
  sameHeaders,
  stableKey,
  validateSlug,
  validateTag,
  validateTtl,
  validateUrl,
  type FailurePolicy,
  type Source,
} from './model';
import { HeaderRowsEditor, PolicyPicker } from './shared';

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8">
      <div>
        <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
        {description && <p className="mt-1 text-xs leading-relaxed text-ink-3">{description}</p>}
      </div>
      <Card className="flex min-w-0 flex-col gap-4 p-4">{children}</Card>
    </section>
  );
}

export function SourceSettings({ source, active }: { source: Source; active: boolean }) {
  const router = useRouter();
  const { data: all } = useSources();
  const taken = useMemo(() => new Set((all ?? []).filter((s) => s.id !== source.id).map((s) => s.name)), [all, source.id]);
  const initial = useMemo(
    () => ({
      display_name: source.display_name ?? '',
      name: source.name,
      tags: source.tags,
      enabled: source.enabled,
      keepInfoNodes: source.keep_info_nodes === true,
      url: source.url ?? '',
      ua: source.ua_override ?? '',
      rows: headersToRows(source.custom_headers),
      ttl: String(msToMinutes(source.ttl_ms)),
      policy: (source.fetch_failure_policy ?? 'use-stale-cache') as FailurePolicy,
      content: source.content ?? '',
    }),
    [source],
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const remote = source.kind === 'remote';
  const headers = rowsToHeaders(form.rows);
  const errors = {
    name: validateSlug(form.name, taken, source.name),
    url: remote ? validateUrl(form.url) : null,
    ttl: remote ? validateTtl(form.ttl) : null,
    content: !remote && !form.content.trim() ? '节点内容不能为空' : null,
  };
  const invalid = Object.values(errors).some(Boolean) || (remote && Object.keys(headers.errors).length > 0);

  const patch: SubscriptionUpdate = {};
  if (form.display_name.trim() !== (source.display_name ?? '')) patch.display_name = form.display_name.trim();
  if (form.name !== source.name) patch.name = form.name;
  if (stableKey(form.tags) !== stableKey(source.tags)) patch.tags = form.tags;
  if (form.enabled !== source.enabled) patch.enabled = form.enabled;
  if (form.keepInfoNodes !== initial.keepInfoNodes) patch.keep_info_nodes = form.keepInfoNodes;
  if (remote) {
    if (form.url.trim() !== (source.url ?? '')) patch.url = form.url.trim();
    if (form.ua.trim() !== (source.ua_override ?? '').trim()) patch.ua_override = form.ua.trim();
    if (!sameHeaders(headers.headers, source.custom_headers)) patch.custom_headers = headers.headers;
    if (!errors.ttl && Number(form.ttl) !== msToMinutes(source.ttl_ms)) patch.ttl_ms = Number(form.ttl) * 60_000;
    if (form.policy !== (source.fetch_failure_policy ?? 'use-stale-cache')) patch.fetch_failure_policy = form.policy;
  } else if (form.content !== (source.content ?? '')) {
    patch.content = form.content;
  }
  const dirty = Object.keys(patch).length > 0 || stableKey(form.rows.map((r) => [r.name, r.value])) !== stableKey(initial.rows.map((r) => [r.name, r.value]));
  const renamed = form.name !== source.name;

  const save = async () => {
    if (saving || !dirty) return;
    if (invalid) {
      notify.warn('还有设置需要修正', '请按红色提示修改后再保存。');
      return;
    }
    setSaving(true);
    try {
      await patchSource(source, patch);
      notify.success('设置已保存', renamed ? '分发链接已换成新标识，记得更新客户端里的旧链接。' : undefined);
      refreshShared();
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  useHotkey('mod+s', () => void save(), { enabled: active && dirty });

  return (
    <div className="flex flex-col gap-8">
      <Section title="基本信息" description="名称和标签只影响显示与归类；标识决定分发链接。">
        <Field label="显示名称" optional>
          {(id) => (
            <Input id={id} value={form.display_name} placeholder={source.name} onChange={(e) => set('display_name', e.target.value)} />
          )}
        </Field>
        <Field label="标识" error={errors.name} hint="用在分发链接 /source/<标识> 里，只能是小写字母、数字和 -。">
          {(id) => (
            <Input id={id} mono value={form.name} invalid={!!errors.name} onChange={(e) => set('name', e.target.value.toLowerCase())} />
          )}
        </Field>
        {renamed && (
          <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2.5 text-xs leading-relaxed text-ink">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
            <span>改名会断开旧分发链接，并重置命名别名和序号。已经导入旧链接的客户端需要换成新链接。</span>
          </div>
        )}
        <Field label="标签" optional hint="聚合订阅可以按标签自动收录订阅源。">
          {() => <TagInput value={form.tags} onChange={(tags) => set('tags', tags)} validate={validateTag} />}
        </Field>
        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div>
            <div className="text-[13px] font-medium text-ink">启用</div>
            <p className="mt-0.5 text-xs text-ink-3">停用后不再拉取，也不向任何配置文件提供节点。</p>
          </div>
          <Switch checked={form.enabled} onCheckedChange={(on) => set('enabled', on)} label="启用这个订阅源" />
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div>
            <div className="text-[13px] font-medium text-ink">保留订阅信息节点</div>
            <p className="mt-0.5 text-xs text-ink-3">默认从节点列表移除流量、到期和官网等信息节点，流量和到期信息仍会显示。</p>
          </div>
          <Switch checked={form.keepInfoNodes} onCheckedChange={(on) => set('keepInfoNodes', on)} label="保留订阅信息节点" />
        </div>
      </Section>

      {remote ? (
        <Section title="拉取设置" description="服务器按这些参数去机场拉取订阅。">
          <Field label="订阅链接" error={errors.url}>
            {(id) => <Input id={id} mono value={form.url} invalid={!!errors.url} onChange={(e) => set('url', e.target.value)} />}
          </Field>
          <Field label="User-Agent" optional hint={`留空使用默认的 ${DEFAULT_UA}。`}>
            {(id) => <Input id={id} mono value={form.ua} placeholder={DEFAULT_UA} onChange={(e) => set('ua', e.target.value)} />}
          </Field>
          <Field label="自定义请求头" optional>
            {() => <HeaderRowsEditor rows={form.rows} onChange={(rows) => set('rows', rows)} errors={headers.errors} />}
          </Field>
          <Field label="缓存时长" error={errors.ttl} hint="这段时间内重复使用上次拉取的结果。">
            {(id) => (
              <Input
                id={id}
                inputMode="numeric"
                value={form.ttl}
                invalid={!!errors.ttl}
                onChange={(e) => set('ttl', e.target.value.replace(/[^\d]/g, ''))}
                trailing={<span className="pr-1 text-xs text-ink-3">分钟</span>}
                className="w-40"
              />
            )}
          </Field>
          <Field label="拉取失败时">{() => <PolicyPicker value={form.policy} onChange={(p) => set('policy', p)} />}</Field>
        </Section>
      ) : (
        <Section title="节点内容" description="Clash 格式的 YAML，包含一个 proxies: 列表。保存前会检查所有用到它的配置文件。">
          {errors.content && <p className="text-xs text-bad">{errors.content}</p>}
          <div className="-m-4 overflow-hidden rounded-xl">
            <CodeEditor value={form.content} onChange={(content) => set('content', content)} height="360px" onSave={() => void save()} />
          </div>
        </Section>
      )}

      <Section title="删除" description="删除后不能恢复，用到它的配置文件和聚合订阅会失去这些节点。">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-ink-3">删除前会告诉你哪些地方正在使用它。</p>
          <Button
            variant="danger-ghost"
            icon={Trash2}
            onClick={async () => {
              if (await deleteSource(source)) router.push('/sources');
            }}
          >
            删除订阅源
          </Button>
        </div>
      </Section>

      <SaveBar visible={dirty} saving={saving} onSave={() => void save()} onDiscard={() => setForm(initial)} />
    </div>
  );
}
