'use client';

import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { refreshProfile, refreshProfiles, useProfiles } from '@/ui/data/hooks';
import type { Profile, ProfileKind, ProfileUpdate } from '@/ui/data/types';
import { Button, Field, Input, Sheet, Textarea, notify } from '@/ui/primitives';
import { useHotkey } from '@/ui/shell/hotkeys';
import { profileTitle } from '@/ui/shell/profile-switcher';
import { lastProfileName, rememberProfile } from '@/ui/shell/scope';
import { Callout, KindField, SourceField } from './fields';
import { cacheProfile, DEFAULT_PROFILE, draftOf, profileApi, sameSource, slugError, sourceOf, type SourceDraft } from './model';

export function EditProfileSheet({
  profile,
  open,
  onOpenChange,
  onDelete,
}: {
  profile: Profile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (profile: Profile) => void;
}) {
  const { data: profiles } = useProfiles();
  const taken = (profiles ?? []).filter((p) => p.id !== profile.id).map((p) => p.name);
  const isDefault = profile.name === DEFAULT_PROFILE;
  const storedKind: ProfileKind = profile.kind ?? 'normal';

  const [displayName, setDisplayName] = useState(profile.display_name ?? '');
  const [name, setName] = useState(profile.name);
  const [notes, setNotes] = useState(profile.notes ?? '');
  const [source, setSource] = useState<SourceDraft>(draftOf(profile.source));
  const [kind, setKind] = useState<ProfileKind>(storedKind);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const bound = sourceOf(source);
  const patch: ProfileUpdate = {};
  if (displayName.trim() !== (profile.display_name ?? '')) patch.display_name = displayName.trim() || null;
  if (name !== profile.name) patch.name = name;
  if (notes.trim() !== (profile.notes ?? '')) patch.notes = notes.trim() || null;
  if (bound && !sameSource(profile.source, bound)) patch.source = bound;
  if (kind !== storedKind) patch.kind = kind;
  const dirty = Object.keys(patch).length > 0 || (!bound && source.mode !== 'none');
  const nameProblem = name === profile.name ? null : slugError(name, taken);

  const save = async () => {
    setAttempted(true);
    if (!dirty || nameProblem || !bound) return;
    setBusy(true);
    try {
      const updated = await profileApi.update(profile.id, patch);
      if (patch.name && lastProfileName() === profile.name) rememberProfile(updated.name);
      cacheProfile(updated);
      refreshProfiles();
      refreshProfile(profile.id);
      notify.success(`已保存「${profileTitle(updated)}」`);
      onOpenChange(false);
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setBusy(false);
    }
  };

  useHotkey('mod+s', () => void save(), { enabled: open && dirty, allowInInput: true });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="编辑配置文件"
      description={
        <>
          {profileTitle(profile)} · <span className="font-mono">{profile.name}</span>
        </>
      }
      footer={
        <>
          {!isDefault && (
            <Button variant="danger-ghost" icon={Trash2} className="mr-auto" onClick={() => onDelete(profile)}>
              删除
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!dirty}
            data-agent-confirm={`保存配置文件「${profileTitle(profile)}」的修改`}
            onClick={() => void save()}
          >
            保存
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <Field label="显示名称" optional hint="客户端导入订阅后看到的名字，可以用中文。">
          {(id) => (
            <Input
              id={id}
              value={displayName}
              maxLength={120}
              placeholder={profile.name}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="标识"
          error={nameProblem && (attempted || name.length > 0) ? nameProblem : undefined}
          hint={
            isDefault
              ? '默认配置文件不能改名：新建配置文件时的骨架和作用域解析都按这个名字查找。'
              : '用在订阅链接和网址里，只能用小写字母、数字和 -。'
          }
        >
          {(id) => (
            <Input
              id={id}
              mono
              value={name}
              disabled={isDefault}
              invalid={!!nameProblem}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value.toLowerCase().replace(/\s+/g, '-'))}
            />
          )}
        </Field>
        {name !== profile.name && !nameProblem && (
          <Callout tone="warn" className="-mt-3">
            改名后订阅链接会变成 <span className="font-mono text-ink">…/{name}</span>。已经导入旧链接的客户端和设备需要重新导入。
          </Callout>
        )}

        <SourceField value={source} onChange={setSource} showError={attempted} />

        <KindField value={kind} onChange={setKind} initial={storedKind} />

        <Field label="备注" optional>
          {(id) => (
            <Textarea
              id={id}
              rows={3}
              value={notes}
              placeholder="这份配置给谁用、有什么不同"
              onChange={(event) => setNotes(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Sheet>
  );
}
