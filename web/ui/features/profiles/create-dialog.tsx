'use client';

import { useState, type ComponentType, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Radio, RadioGroup } from '@ui-sdk/react/radio';
import { CopyPlus, FilePlus2, LayoutTemplate } from 'lucide-react';
import { partitionProfilesByKind } from '@/lib/profiles/kind';
import { ApiError } from '@/ui/data/api';
import { refreshProfiles, useProfiles } from '@/ui/data/hooks';
import type { Profile, ProfileKind } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Dialog, Field, Input, Select, Textarea, notify } from '@/ui/primitives';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { profilePath } from '@/ui/shell/scope';
import { KindField, SourceField } from './fields';
import {
  cacheProfile,
  draftOf,
  freeSlug,
  profileApi,
  slugError,
  sourceOf,
  suggestSlug,
  type SourceDraft,
} from './model';

export type StartMode = 'template' | 'blank' | 'copy';

export interface CreateSeed {
  start?: StartMode;
  /** Template / profile to copy from. */
  fromId?: string;
  kind?: ProfileKind;
}

const FORM_ID = 'create-profile-form';

export function CreateProfileDialog({
  seed,
  open,
  onOpenChange,
}: {
  seed: CreateSeed;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { data } = useProfiles();
  const profiles = data ?? [];
  const { normal, templates } = partitionProfilesByKind(profiles);
  const taken = profiles.map((p) => p.name);
  const seedFrom = seed.fromId ? profiles.find((p) => p.id === seed.fromId) : undefined;

  const [start, setStart] = useState<StartMode>(seed.start ?? (templates.length ? 'template' : 'blank'));
  const [templateId, setTemplateId] = useState<string | undefined>(
    seed.start === 'template' && seedFrom ? seedFrom.id : templates[0]?.id,
  );
  const [copyId, setCopyId] = useState<string | undefined>(
    seed.start === 'copy' && seedFrom ? seedFrom.id : normal[0]?.id,
  );
  const copying = seed.start === 'copy' ? seedFrom : undefined;
  const [displayName, setDisplayName] = useState(copying ? `${profileTitle(copying)} 副本` : '');
  const [slug, setSlug] = useState(copying ? freeSlug(`${copying.name}-copy`, taken) : '');
  const [slugTouched, setSlugTouched] = useState(!!copying);
  const [source, setSource] = useState<SourceDraft | null>(null);
  const [kind, setKind] = useState<ProfileKind>(seed.kind ?? 'normal');
  const [notes, setNotes] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [serverSlugError, setServerSlugError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const from: Profile | undefined =
    start === 'template'
      ? templates.find((p) => p.id === templateId)
      : start === 'copy'
        ? normal.find((p) => p.id === copyId)
        : undefined;
  // The binding follows the profile you start from until you pick one yourself.
  const sourceDraft = source ?? draftOf(from?.source);
  const effectiveSlug = slugTouched ? slug : suggestSlug(displayName);
  const slugProblem = serverSlugError ?? slugError(effectiveSlug, taken);
  const showSlugProblem = !!slugProblem && (attempted || (slugTouched && slug.length > 0) || !!serverSlugError);
  const missingFrom = start !== 'blank' && !from;

  const submit = async () => {
    setAttempted(true);
    const boundSource = sourceOf(sourceDraft);
    if (slugProblem || !boundSource || missingFrom) return;
    setBusy(true);
    try {
      const created = await profileApi.create({
        name: effectiveSlug,
        display_name: displayName.trim() || undefined,
        source: boundSource,
        kind,
        notes: notes.trim() || undefined,
        copy_from: from?.id,
      });
      cacheProfile(created);
      refreshProfiles();
      notify.success(
        `已创建「${profileTitle(created)}」`,
        kind === 'template' ? '模版不会对外分发，新建配置文件时可以从它开始。' : undefined,
      );
      onOpenChange(false);
      router.push(profilePath(created.name));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setServerSlugError('已经有同名的配置文件，换一个标识');
      } else {
        notify.error(error, '创建失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新建配置文件"
      description="一份配置文件就是一套完整的客户端配置，有自己的订阅链接。"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={FORM_ID}
            loading={busy}
            data-agent-confirm={kind === 'template' ? '创建新配置模版' : '创建新配置文件'}
          >
            {kind === 'template' ? '创建模版' : '创建并打开'}
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-2">从哪里开始</span>
          <RadioGroup
            aria-label="从哪里开始"
            value={start}
            onValueChange={(next) => {
              if (next) setStart(next as StartMode);
            }}
            className="flex flex-col gap-2"
          >
            <StartOption
              value="template"
              selected={start === 'template'}
              icon={LayoutTemplate}
              title="从模版开始"
              badge={templates.length > 0 ? <Badge tone="accent">推荐</Badge> : undefined}
              description={
                templates.length > 0
                  ? '拷贝模版的策略组、规则、基础配置和设备，之后两边互不影响。'
                  : '还没有模版。可以在任意配置文件的「编辑」里把它转为模版。'
              }
              disabled={templates.length === 0}
            >
              <Select
                label="选择模版"
                value={templateId}
                onValueChange={setTemplateId}
                placeholder="选择模版"
                invalid={attempted && !from}
                options={templates.map((p) => ({ value: p.id, label: profileTitle(p), description: p.notes || p.name }))}
              />
            </StartOption>
            <StartOption
              value="blank"
              selected={start === 'blank'}
              icon={FilePlus2}
              title="空白"
              description={
                <>
                  只复制 <span className="font-mono text-ink-2">default</span> 的基础配置骨架（DNS、端口等），策略组和规则从零开始。
                </>
              }
            />
            <StartOption
              value="copy"
              selected={start === 'copy'}
              icon={CopyPlus}
              title="复制现有配置"
              description="完整复制一份配置文件的策略组、规则、基础配置和设备。"
              disabled={normal.length === 0}
            >
              <Select
                label="选择要复制的配置文件"
                value={copyId}
                onValueChange={setCopyId}
                placeholder="选择配置文件"
                invalid={attempted && !from}
                options={normal.map((p) => ({ value: p.id, label: profileTitle(p), description: p.name }))}
              />
            </StartOption>
          </RadioGroup>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="显示名称" optional hint="客户端导入后看到的名字，可以用中文。">
            {(id) => (
              <Input
                id={id}
                data-autofocus
                value={displayName}
                maxLength={120}
                placeholder="例如：出差精简版"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="标识"
            error={showSlugProblem ? slugProblem : undefined}
            hint={
              <>
                订阅链接的最后一段：<span className="font-mono text-ink-2">…/{effectiveSlug || 'travel-lite'}</span>
              </>
            }
          >
            {(id) => (
              <Input
                id={id}
                mono
                value={effectiveSlug}
                invalid={showSlugProblem}
                placeholder="travel-lite"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => {
                  setSlugTouched(true);
                  setServerSlugError(null);
                  setSlug(event.target.value.toLowerCase().replace(/\s+/g, '-'));
                }}
              />
            )}
          </Field>
        </div>

        <SourceField value={sourceDraft} onChange={setSource} showError={attempted} />

        <KindField value={kind} onChange={setKind} />

        <Field label="备注" optional>
          {(id) => (
            <Textarea
              id={id}
              rows={2}
              className="min-h-[60px]"
              value={notes}
              placeholder="这份配置给谁用、有什么不同"
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function StartOption({
  value,
  selected,
  icon: Icon,
  title,
  description,
  badge,
  disabled,
  children,
}: {
  value: StartMode;
  selected: boolean;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  title: string;
  description: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-lg border transition-[border-color,background-color,box-shadow] duration-150',
        selected ? 'border-accent bg-accent-soft/35 shadow-[var(--ring)]' : 'border-line hover:border-line-strong',
        disabled && 'opacity-55',
      )}
    >
      <Radio
        value={value}
        aria-label={title}
        disabled={disabled}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed"
      >
        <span
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors',
            selected ? 'border-accent-line bg-surface text-accent' : 'border-line bg-surface-2 text-ink-3',
          )}
        >
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
            {title}
            {badge}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{description}</span>
        </span>
        <span
          aria-hidden
          className={cn(
            'mt-1.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            selected ? 'border-accent bg-accent' : 'border-line-strong bg-surface',
          )}
        >
          {selected && <span className="size-1.5 rounded-full bg-accent-ink" />}
        </span>
      </Radio>
      {selected && children && <div className="px-3 pb-3 sm:pl-[52px]">{children}</div>}
    </div>
  );
}
