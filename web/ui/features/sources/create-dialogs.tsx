'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Globe, HardDrive } from 'lucide-react';
import { api } from '@/ui/data/api';
import { refreshShared } from '@/ui/data/hooks';
import type { CollectionCreate, SubscriptionCreate } from '@/ui/data/types';
import { CodeEditor } from '@/ui/editor/code-editor';
import { cn } from '@/ui/lib/cn';
import {
  Button,
  Dialog,
  Field,
  Input,
  Monogram,
  MultiCombobox,
  notify,
  SegmentedControl,
  TagInput,
  Textarea,
} from '@/ui/primitives';
import { refreshSource } from './actions';
import {
  DEFAULT_TTL_MINUTES,
  DEFAULT_UA,
  resolvePoolMembers,
  rowsToHeaders,
  sourceTitle,
  suggestPoolSlug,
  suggestSourceSlug,
  validateSlug,
  validateTag,
  validateTtl,
  validateUrl,
  type FailurePolicy,
  type HeaderRow,
  type Pool,
  type Source,
} from './model';
import { HeaderRowsEditor, PolicyPicker } from './shared';

const LOCAL_PLACEHOLDER = `proxies:
  - name: "🇯🇵 东京 VPS"
    type: trojan
    server: vps.example.com
    port: 443
    password: your-password`;

/* ─── 添加订阅源 ──────────────────────────────────────────────────────── */

export function AddSourceDialog({ open, onOpenChange, sources }: { open: boolean; onOpenChange: (open: boolean) => void; sources: Source[] }) {
  const router = useRouter();
  const taken = useMemo(() => new Set(sources.map((s) => s.name)), [sources]);
  const [kind, setKind] = useState<'remote' | 'local'>('remote');
  const [url, setUrl] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [advanced, setAdvanced] = useState(false);
  const [ua, setUa] = useState('');
  const [rows, setRows] = useState<HeaderRow[]>([]);
  const [ttl, setTtl] = useState(String(DEFAULT_TTL_MINUTES));
  const [policy, setPolicy] = useState<FailurePolicy>('use-stale-cache');
  const [content, setContent] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const effectiveSlug = slugTouched ? slug : suggestSourceSlug(displayName, kind === 'remote' ? url : '', taken);
  const headers = rowsToHeaders(rows);
  const errors = {
    url: kind === 'remote' ? validateUrl(url) : null,
    slug: validateSlug(effectiveSlug, taken),
    ttl: kind === 'remote' ? validateTtl(ttl) : null,
    content: kind === 'local' && !content.trim() ? '请粘贴节点内容（YAML，包含 proxies: 列表）' : null,
  };
  const headerErrors = kind === 'remote' ? headers.errors : {};
  const invalid = Object.values(errors).some(Boolean) || Object.keys(headerErrors).length > 0;
  const show = (key: keyof typeof errors) => (submitted || (key === 'slug' && slugTouched) ? errors[key] : null);

  const reset = () => {
    setKind('remote');
    setUrl('');
    setDisplayName('');
    setSlug('');
    setSlugTouched(false);
    setTags([]);
    setAdvanced(false);
    setUa('');
    setRows([]);
    setTtl(String(DEFAULT_TTL_MINUTES));
    setPolicy('use-stale-cache');
    setContent('');
    setSubmitted(false);
  };

  const submit = async () => {
    setSubmitted(true);
    if (invalid) {
      if (Object.keys(headerErrors).length || errors.ttl) setAdvanced(true);
      return;
    }
    const body: SubscriptionCreate =
      kind === 'remote'
        ? {
            kind,
            name: effectiveSlug,
            display_name: displayName.trim() || undefined,
            enabled: true,
            url: url.trim(),
            ua_override: ua.trim() && ua.trim() !== DEFAULT_UA ? ua.trim() : undefined,
            custom_headers: Object.keys(headers.headers).length ? headers.headers : undefined,
            ttl_ms: Number(ttl) * 60_000,
            fetch_failure_policy: policy,
            tags,
            operators: [],
          }
        : {
            kind,
            name: effectiveSlug,
            display_name: displayName.trim() || undefined,
            enabled: true,
            content,
            ttl_ms: DEFAULT_TTL_MINUTES * 60_000,
            tags,
            operators: [],
          };
    setSaving(true);
    try {
      const created = await api.post<Source>('/subscriptions', body);
      notify.success(`已添加「${sourceTitle(created)}」`, kind === 'remote' ? '正在第一次拉取节点…' : undefined);
      refreshShared();
      if (created.kind === 'remote') void refreshSource(created, true);
      reset();
      onOpenChange(false);
      router.push(`/sources/${created.id}`);
    } catch (error) {
      notify.error(error, '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="添加订阅源"
      description="订阅源由所有配置文件共享。添加后可以把它绑定到配置文件，或放进聚合订阅。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            添加
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <SegmentedControl
          stretch
          value={kind}
          onChange={setKind}
          options={[
            { value: 'remote', label: '远程订阅', icon: Globe },
            { value: 'local', label: '本地节点', icon: HardDrive },
          ]}
        />
        {kind === 'remote' && (
          <Field label="订阅链接" error={show('url')} hint="机场提供的 Clash / 通用订阅地址，支持 http 和 https。">
            {(id) => (
              <Input
                id={id}
                data-autofocus
                mono
                value={url}
                invalid={!!show('url')}
                placeholder="https://example.com/api/v1/client/subscribe?token=…"
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="显示名称" optional hint="在界面里看到的名字，可以用中文。">
            {(id) => (
              <Input
                id={id}
                value={displayName}
                placeholder={kind === 'remote' ? '例如 Nebula 机场' : '例如 自建节点'}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            )}
          </Field>
          <Field label="标识" error={show('slug')} hint="用在分发链接里，只能是小写字母、数字和 -。">
            {(id) => (
              <Input
                id={id}
                mono
                value={effectiveSlug}
                invalid={!!show('slug')}
                placeholder="例如 nebula"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
        </div>
        {kind === 'local' && (
          <Field label="节点内容" error={submitted ? errors.content : null} hint="Clash 格式的 YAML，包含一个 proxies: 列表。">
            {() => (
              <div className={cn('overflow-hidden rounded-md border bg-surface', submitted && errors.content ? 'border-bad' : 'border-line')}>
                <CodeEditor value={content} onChange={setContent} placeholder={LOCAL_PLACEHOLDER} height="220px" />
              </div>
            )}
          </Field>
        )}
        <Field label="标签" optional hint="聚合订阅可以按标签自动收录订阅源。">
          {() => <TagInput value={tags} onChange={setTags} validate={validateTag} placeholder="例如 airport，回车添加" />}
        </Field>
        {kind === 'remote' && (
          <div className="rounded-xl border border-line">
            <button
              type="button"
              aria-expanded={advanced}
              onClick={() => setAdvanced((v) => !v)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[13px] font-medium text-ink-2 hover:text-ink"
            >
              <ChevronRight size={14} className={cn('transition-transform', advanced && 'rotate-90')} />
              高级
              <span className="text-xs font-normal text-ink-3">User-Agent、请求头、缓存时长、失败策略</span>
            </button>
            {advanced && (
              <div className="flex flex-col gap-4 border-t border-line px-3.5 py-3.5">
                <Field label="User-Agent" optional hint={`留空使用默认的 ${DEFAULT_UA}。部分机场按它决定返回的格式。`}>
                  {(id) => <Input id={id} mono value={ua} placeholder={DEFAULT_UA} onChange={(e) => setUa(e.target.value)} />}
                </Field>
                <Field label="自定义请求头" optional>
                  {() => <HeaderRowsEditor rows={rows} onChange={setRows} errors={headerErrors} />}
                </Field>
                <Field label="缓存时长" error={show('ttl')} hint="这段时间内重复使用上次拉取的结果，减少对机场的请求。">
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="numeric"
                      value={ttl}
                      invalid={!!show('ttl')}
                      onChange={(e) => setTtl(e.target.value.replace(/[^\d]/g, ''))}
                      trailing={<span className="pr-1 text-xs text-ink-3">分钟</span>}
                      className="w-40"
                    />
                  )}
                </Field>
                <Field label="拉取失败时">{() => <PolicyPicker value={policy} onChange={setPolicy} />}</Field>
              </div>
            )}
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/* ─── 新建聚合订阅 ────────────────────────────────────────────────────── */

export function NewPoolDialog({
  open,
  onOpenChange,
  sources,
  pools,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Source[];
  pools: Pool[];
}) {
  const router = useRouter();
  const taken = useMemo(() => new Set(pools.map((p) => p.slug).filter((s): s is string => !!s)), [pools]);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  const effectiveSlug = slugTouched ? slug : suggestPoolSlug(name, taken);
  const allTags = useMemo(() => [...new Set(sources.flatMap((s) => s.tags))].sort(), [sources]);
  const members = resolvePoolMembers({ subscription_ids: ids, subscription_tags: tags }, sources);
  const errors = { name: name.trim() ? null : '请填写名称', slug: validateSlug(effectiveSlug, taken) };
  const show = (key: keyof typeof errors) => (submitted || (key === 'slug' && slugTouched) ? errors[key] : null);
  const options = sources.map((s) => ({
    value: s.id,
    label: sourceTitle(s),
    keywords: [s.name, ...s.tags],
    description: s.name + (s.enabled ? '' : ' · 已停用'),
    icon: <Monogram name={sourceTitle(s)} colorKey={s.id} size={18} />,
  }));

  const submit = async () => {
    setSubmitted(true);
    if (errors.name || errors.slug) return;
    const body: CollectionCreate = {
      name: name.trim(),
      slug: effectiveSlug,
      enabled: true,
      type: 'select',
      subscription_ids: ids,
      subscription_tags: tags,
      operators: [],
      notes: notes.trim() || undefined,
    };
    setSaving(true);
    try {
      const created = await api.post<Pool>('/collections', body);
      notify.success(`已创建聚合订阅「${created.name}」`);
      refreshShared();
      onOpenChange(false);
      setName('');
      setSlug('');
      setSlugTouched(false);
      setIds([]);
      setTags([]);
      setNotes('');
      setSubmitted(false);
      router.push(`/pools/${created.id}`);
    } catch (error) {
      notify.error(error, '创建失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="新建聚合订阅"
      description="把多个订阅源合成一份节点列表，可以整体再加工、整体绑定到配置文件。"
      footer={
        <>
          <span className="mr-auto text-xs text-ink-3">将包含 {members.filter((m) => m.source?.enabled).length} 个启用的订阅源</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            创建
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="名称" error={show('name')}>
            {(id) => (
              <Input id={id} data-autofocus value={name} invalid={!!show('name')} placeholder="例如 全部机场" onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field label="标识" error={show('slug')} hint="用在分发链接里，创建后不能修改。">
            {(id) => (
              <Input
                id={id}
                mono
                value={effectiveSlug}
                invalid={!!show('slug')}
                placeholder="例如 all-airports"
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase());
                }}
              />
            )}
          </Field>
        </div>
        <Field label="成员订阅源" hint="排在前面的订阅源优先：节点重名时保留先出现的那个。">
          {() => (
            <MultiCombobox
              value={ids}
              onChange={setIds}
              options={options}
              placeholder="添加订阅源"
              searchPlaceholder="搜索订阅源"
              emptyText="没有订阅源"
              renderChip={(value, option) => option?.label ?? '已删除的订阅源'}
            />
          )}
        </Field>
        <Field label="按标签自动加入" optional hint="带这些标签的订阅源会自动加入，以后新加的也一样。">
          {() => (
            <div className="flex flex-col gap-2">
              <TagInput value={tags} onChange={setTags} validate={validateTag} placeholder="输入标签，回车添加" />
              {allTags.filter((t) => !tags.includes(t)).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                  现有标签：
                  {allTags
                    .filter((t) => !tags.includes(t))
                    .map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => setTags([...tags, tag])}
                        className="rounded-md border border-line bg-surface px-1.5 py-px text-ink-2 hover:border-line-strong hover:text-ink"
                      >
                        + {tag}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )}
        </Field>
        <Field label="备注" optional>
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="写给自己看的说明" className="min-h-[64px]" />}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
