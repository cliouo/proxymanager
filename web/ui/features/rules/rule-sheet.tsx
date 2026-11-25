'use client';

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Rule, RuleSetListItem, RuleType } from '@/ui/data/types';
import { Button, Checkbox, Combobox, confirmAction, Field, Input, notify, Select, Sheet, Switch } from '@/ui/primitives';
import { PolicyChip } from '@/ui/viz/lines';
import { usePolicyOptions } from './composer';
import { RULE_TYPE_ORDER, RULE_TYPES, ruleText } from './rule-model';
import { afterRuleWrite, ruleApi } from './use-rule-book';

interface Draft {
  anchor: string;
  type: RuleType;
  value: string;
  policy: string;
  noResolve: boolean;
  src: boolean;
  note: string;
  enabled: boolean;
}

function toDraft(rule: Rule): Draft {
  return {
    anchor: rule.anchor,
    type: rule.type,
    value: rule.value,
    policy: rule.policy,
    noResolve: rule.options?.includes('no-resolve') ?? false,
    src: rule.options?.includes('src') ?? false,
    note: rule.note ?? '',
    enabled: rule.enabled !== false,
  };
}

export function RuleSheet({
  rule,
  onClose,
  profileId,
  anchors,
  policies,
  ruleSets,
  hasOtherActiveMatch,
}: {
  rule: Rule | null;
  onClose: () => void;
  profileId: string;
  anchors: string[];
  policies: string[] | undefined;
  ruleSets: RuleSetListItem[] | undefined;
  hasOtherActiveMatch: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const policyOptions = usePolicyOptions(policies);

  useEffect(() => {
    setDraft(rule ? toDraft(rule) : null);
  }, [rule]);

  const meta = draft ? RULE_TYPES[draft.type] : null;
  const anchorOptions = useMemo(() => {
    const list = [...anchors];
    if (rule && !list.includes(rule.anchor)) list.push(rule.anchor);
    return list.map((a) => ({ value: a, label: a, description: anchors.includes(a) ? undefined : '基础配置中不存在' }));
  }, [anchors, rule]);

  if (!rule || !draft) {
    return <Sheet open={false} onOpenChange={() => onClose()} />;
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const options = [...(meta?.options && draft.noResolve ? ['no-resolve'] : []), ...(meta?.options && draft.src ? ['src'] : [])];
  const valueMissing = draft.type !== 'MATCH' && !draft.value.trim();
  const matchConflict = draft.type === 'MATCH' && draft.enabled && hasOtherActiveMatch;

  const changed = (() => {
    const original = toDraft(rule);
    return (Object.keys(original) as (keyof Draft)[]).some((k) => original[k] !== draft[k]);
  })();

  const save = async () => {
    if (valueMissing || matchConflict) return;
    setSaving(true);
    try {
      await ruleApi.patch(profileId, rule, {
        anchor: draft.anchor,
        type: draft.type,
        value: draft.type === 'MATCH' ? '' : draft.value.trim(),
        policy: draft.policy,
        options,
        note: draft.note,
        enabled: draft.enabled,
      });
      notify.success('规则已保存');
      afterRuleWrite(profileId);
      onClose();
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: '删除这条规则？',
      description: `${ruleText(rule)}。删除后匹配它的流量会继续往下找规则；可以在操作历史中撤销。`,
      confirmText: '确认删除',
      confirmHint: `删除规则 ${ruleText(rule)}`,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await ruleApi.remove(profileId, rule.id);
      notify.success('规则已删除');
      afterRuleWrite(profileId);
      onClose();
    } catch (error) {
      notify.error(error, '删除失败');
    }
  };

  return (
    <Sheet
      open={!!rule}
      onOpenChange={(open) => !open && onClose()}
      title="编辑规则"
      description={<span className="font-mono">{ruleText(rule)}</span>}
      width={460}
      footer={
        <>
          <Button variant="danger-ghost" icon={Trash2} onClick={() => void remove()} className="mr-auto">
            删除
          </Button>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!changed || valueMissing || matchConflict}
            data-agent-confirm={`保存规则 ${draft.type}${draft.value ? ` ${draft.value}` : ''} → ${draft.policy}`}
            onClick={() => void save()}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="类型" hint={meta?.hint}>
          {(id) => (
            <Select
              id={id}
              value={draft.type}
              onValueChange={(type) => set({ type })}
              options={RULE_TYPE_ORDER.map((t) => ({ value: t, label: RULE_TYPES[t].label, description: t }))}
              renderValue={(t) => (
                <span className="flex items-center gap-2">
                  {RULE_TYPES[t].label}
                  <span className="font-mono text-[11px] text-ink-3">{t}</span>
                </span>
              )}
            />
          )}
        </Field>

        {draft.type !== 'MATCH' && (
          <Field label="内容" error={valueMissing ? '请填写匹配内容' : undefined}>
            {(id) =>
              draft.type === 'RULE-SET' ? (
                <Combobox
                  id={id}
                  value={draft.value || null}
                  onChange={(value) => set({ value })}
                  allowCustom
                  placeholder="选择规则集"
                  options={(ruleSets ?? []).map((s) => ({
                    value: s.name,
                    label: s.name,
                    description: `${s.source === 'remote' ? '远程' : '本地托管'} · ${s.behavior ?? s.format}`,
                  }))}
                />
              ) : (
                <Input
                  id={id}
                  mono
                  value={draft.value}
                  invalid={valueMissing}
                  placeholder={meta?.placeholder}
                  onChange={(event) => set({ value: event.target.value })}
                />
              )
            }
          </Field>
        )}

        <Field
          label="去向"
          hint="命中这条规则的流量交给哪个策略组（或直连 / 拦截）"
          error={matchConflict ? '已经有另一条生效的兜底规则，兜底规则只能有一条' : undefined}
        >
          {(id) => (
            <Combobox
              id={id}
              value={draft.policy}
              onChange={(policy) => set({ policy })}
              options={policyOptions}
              allowCustom
              searchPlaceholder="搜索策略组…"
              renderValue={(v) => <PolicyChip policy={v} size="sm" className="border-0 bg-transparent px-0" />}
            />
          )}
        </Field>

        <Field label="插入位置" hint="锚点决定这条规则出现在基础配置 rules 段的哪个位置">
          {(id) => <Select id={id} mono value={draft.anchor} onValueChange={(anchor) => set({ anchor })} options={anchorOptions} />}
        </Field>

        {meta?.options && (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-ink-2">修饰</span>
            <Checkbox
              checked={draft.noResolve}
              onCheckedChange={(noResolve) => set({ noResolve })}
              label={
                <span>
                  <span className="font-mono text-[12.5px]">no-resolve</span>
                  <span className="ml-2 text-xs text-ink-3">匹配域名时不做 DNS 解析</span>
                </span>
              }
            />
            <Checkbox
              checked={draft.src}
              onCheckedChange={(src) => set({ src })}
              label={
                <span>
                  <span className="font-mono text-[12.5px]">src</span>
                  <span className="ml-2 text-xs text-ink-3">改为匹配来源 IP</span>
                </span>
              }
            />
          </div>
        )}

        <Field label="备注" optional>
          {(id) => <Input id={id} value={draft.note} placeholder="为什么加这条规则" onChange={(event) => set({ note: event.target.value })} />}
        </Field>

        <Field
          inline
          label="启用"
          hint={draft.enabled ? '生效中' : '停用的规则会保留，但不会出现在最终配置里'}
          className="rounded-lg border border-line px-3 py-2"
        >
          {(id) => <Switch id={id} checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />}
        </Field>
      </div>
    </Sheet>
  );
}
