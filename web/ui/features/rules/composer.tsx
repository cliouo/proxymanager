'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Input as UiInput } from '@ui-sdk/react/input';
import { ArrowRight, CornerDownLeft, ListPlus, Sparkles, Wand2 } from 'lucide-react';
import type { Rule, RuleSetListItem, RuleType } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Checkbox, Combobox, Dialog, notify, Select, Tooltip, type ComboOption } from '@/ui/primitives';
import { BUILTIN_LABEL, isBuiltinPolicy, LineDot, PolicyChip, useLineColors } from '@/ui/viz/lines';
import { detectRule, RULE_TYPE_ORDER, RULE_TYPES, type Detected } from './rule-model';
import { afterRuleWrite, ruleApi, type RuleDraft } from './use-rule-book';

const LAST_POLICY = 'pm.rules.last-policy';
const LAST_ANCHOR = 'pm.rules.last-anchor';

export function usePolicyOptions(policies: string[] | undefined): ComboOption[] {
  const { color } = useLineColors();
  return useMemo(
    () =>
      (policies ?? []).map((policy) => ({
        value: policy,
        label: policy,
        group: isBuiltinPolicy(policy) ? '内置' : '策略组',
        keywords: isBuiltinPolicy(policy) ? [BUILTIN_LABEL[policy]] : [],
        description: isBuiltinPolicy(policy) ? BUILTIN_LABEL[policy] : undefined,
        icon: <LineDot color={color(policy)} size={8} hollow={isBuiltinPolicy(policy)} />,
      })),
    [policies, color],
  );
}

export interface ComposerHandle {
  focus: () => void;
  prefill: (value: string) => void;
}

export const RuleComposer = forwardRef<
  ComposerHandle,
  {
    profileId: string;
    anchors: string[];
    policies: string[] | undefined;
    ruleSets: RuleSetListItem[] | undefined;
    rules: Rule[];
    onCreated?: (rule: Rule) => void;
  }
>(function RuleComposer({ profileId, anchors, policies, ruleSets, rules, onCreated }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [typeChoice, setTypeChoice] = useState<RuleType | 'auto'>('auto');
  const [policy, setPolicy] = useState<string>('');
  const [anchor, setAnchor] = useState<string>('');
  const [noResolve, setNoResolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [batchLines, setBatchLines] = useState<string[] | null>(null);
  const policyOptions = usePolicyOptions(policies);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    prefill: (next: string) => {
      setValue(next);
      inputRef.current?.focus();
    },
  }));

  // Defaults: remembered policy/anchor, else the first managed group and the middle anchor.
  useEffect(() => {
    if (!policies?.length || policy) return;
    const remembered = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_POLICY) : null;
    setPolicy(remembered && policies.includes(remembered) ? remembered : (policies.find((p) => !isBuiltinPolicy(p)) ?? policies[0]));
  }, [policies, policy]);
  useEffect(() => {
    if (!anchors.length || anchor) return;
    const remembered = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_ANCHOR) : null;
    setAnchor(
      remembered && anchors.includes(remembered)
        ? remembered
        : (anchors.find((a) => a === 'manual') ?? anchors[Math.floor((anchors.length - 1) / 2)]),
    );
  }, [anchors, anchor]);

  const detected: Detected | null = useMemo(() => {
    if (typeChoice !== 'auto') return value.trim() ? { type: typeChoice, value: value.trim() } : null;
    return detectRule(value);
  }, [value, typeChoice]);
  const type = detected?.type ?? (typeChoice === 'auto' ? null : typeChoice);
  const meta = type ? RULE_TYPES[type] : null;
  const hasActiveMatch = rules.some((r) => r.type === 'MATCH' && r.enabled !== false);
  const matchBlocked = type === 'MATCH' && hasActiveMatch;
  const canSubmit = !!policy && !!anchor && (type === 'MATCH' ? !matchBlocked : !!detected?.value) && !busy;

  const submit = async () => {
    if (!canSubmit || !type) return;
    setBusy(true);
    const draft: RuleDraft = {
      anchor,
      type,
      value: type === 'MATCH' ? '' : (detected?.value ?? ''),
      policy,
      ...(meta?.options && noResolve ? { options: ['no-resolve'] } : {}),
    };
    try {
      const created = await ruleApi.create(profileId, draft);
      window.localStorage.setItem(LAST_POLICY, policy);
      window.localStorage.setItem(LAST_ANCHOR, anchor);
      notify.success('已添加规则', `${draft.type} ${draft.value} → ${draft.policy}`);
      setValue('');
      setTypeChoice('auto');
      afterRuleWrite(profileId);
      onCreated?.(created);
      inputRef.current?.focus();
    } catch (error) {
      notify.error(error, '添加失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm transition-shadow focus-within:shadow-md">
      <div className="flex flex-wrap items-center gap-2 p-2 md:flex-nowrap">
        <Select<RuleType | 'auto'>
          label="规则类型"
          value={typeChoice}
          onValueChange={setTypeChoice}
          size="md"
          className="w-[132px] shrink-0"
          renderValue={(v) =>
            v === 'auto' ? (
              <span className="flex items-center gap-1.5">
                <Wand2 size={13} className="text-accent" />
                {detected ? RULE_TYPES[detected.type].label : '自动识别'}
              </span>
            ) : (
              RULE_TYPES[v].label
            )
          }
          options={[
            { value: 'auto', label: '自动识别', description: '根据输入判断类型' },
            ...RULE_TYPE_ORDER.map((t) => ({ value: t, label: RULE_TYPES[t].label, description: t })),
          ]}
        />
        <div className="relative min-w-[200px] flex-1">
          {type === 'RULE-SET' && typeChoice === 'RULE-SET' ? (
            <Combobox
              aria-label="选择规则集"
              value={value || null}
              onChange={setValue}
              placeholder="选择规则集"
              searchPlaceholder="搜索规则集…"
              options={(ruleSets ?? []).map((set) => ({
                value: set.name,
                label: set.name,
                description: `${set.source === 'remote' ? '远程' : '本地托管'} · ${set.behavior ?? set.format}`,
              }))}
            />
          ) : (
            <UiInput
              ref={inputRef}
              value={type === 'MATCH' && typeChoice === 'MATCH' ? '' : value}
              disabled={typeChoice === 'MATCH'}
              onValueChange={setValue}
              onPaste={(event) => {
                const text = event.clipboardData.getData('text');
                const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                if (lines.length > 1) {
                  event.preventDefault();
                  setBatchLines(lines);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={typeChoice === 'MATCH' ? '兜底规则不需要填写内容' : '粘贴域名、网址、IP 段，或输入关键字…'}
              aria-label="规则内容"
              className="h-8 w-full rounded-md bg-transparent px-2 font-mono text-[13px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4"
            />
          )}
        </div>
        <ArrowRight size={15} className="hidden shrink-0 text-ink-4 md:block" />
        <Combobox
          aria-label="规则去向"
          value={policy}
          onChange={setPolicy}
          options={policyOptions}
          placeholder="选择去向"
          searchPlaceholder="搜索策略组…"
          className="w-[168px] shrink-0"
          renderValue={(v) => <PolicyChip policy={v} size="sm" className="max-w-[130px] border-0 bg-transparent px-0" />}
        />
        {anchors.length > 1 && (
          <Tooltip content="插入位置：规则会加到这个锚点的末尾">
            <div className="w-[112px] shrink-0">
              <Select
                label="插入锚点"
                value={anchor}
                onValueChange={setAnchor}
                mono
                options={anchors.map((a) => ({ value: a, label: a }))}
              />
            </div>
          </Tooltip>
        )}
        <Button
          variant="primary"
          onClick={() => void submit()}
          disabled={!canSubmit}
          loading={busy}
          data-agent-confirm={`添加规则：${type ?? ''}${detected?.value ? ` ${detected.value}` : ''} → ${policy}`}
          className="shrink-0"
        >
          添加
          <CornerDownLeft size={13} className="opacity-60" />
        </Button>
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface-2/50 px-3 py-1.5 text-xs text-ink-3">
        {matchBlocked ? (
          <span className="text-warn">已经有一条生效的兜底规则。要改去向，直接编辑它即可。</span>
        ) : meta && type ? (
          <>
            <span className="flex items-center gap-1.5">
              将作为 <Badge mono>{type}</Badge>
              <span className="text-ink-2">{meta.label}</span>
              {detected?.value && detected.value !== value.trim() && (
                <span className="font-mono text-[12px] text-ink">{detected.value}</span>
              )}
            </span>
            <span className="text-ink-4">·</span>
            <span>{meta.hint}</span>
            {detected?.note && (
              <span className="flex items-center gap-1 text-accent">
                <Sparkles size={12} />
                {detected.note}
              </span>
            )}
            {meta.options && (
              <Checkbox
                className="ml-auto text-xs text-ink-2"
                checked={noResolve}
                onCheckedChange={setNoResolve}
                label={<span title="匹配域名时不做 DNS 解析，避免泄露与延迟">no-resolve</span>}
              />
            )}
          </>
        ) : (
          <span className="flex min-w-0 items-start gap-1.5">
            <ListPlus size={13} className="mt-[3px] shrink-0" />
            <span>
              输入后回车即可添加
              <span className="hidden sm:inline">
                ；一次粘贴多行会进入批量添加。示例：<span className="font-mono text-ink-2">openai.com</span>、
                <span className="font-mono text-ink-2">10.0.0.0/8</span>、<span className="font-mono text-ink-2">geosite:cn</span>
              </span>
            </span>
          </span>
        )}
      </div>
      <BatchAddDialog
        lines={batchLines}
        onClose={() => setBatchLines(null)}
        profileId={profileId}
        anchors={anchors}
        defaultAnchor={anchor}
        defaultPolicy={policy}
        policyOptions={policyOptions}
      />
    </div>
  );
});

function BatchAddDialog({
  lines,
  onClose,
  profileId,
  anchors,
  defaultAnchor,
  defaultPolicy,
  policyOptions,
}: {
  lines: string[] | null;
  onClose: () => void;
  profileId: string;
  anchors: string[];
  defaultAnchor: string;
  defaultPolicy: string;
  policyOptions: ComboOption[];
}) {
  const [policy, setPolicy] = useState(defaultPolicy);
  const [anchor, setAnchor] = useState(defaultAnchor);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (lines) {
      setPolicy(defaultPolicy);
      setAnchor(defaultAnchor);
    }
  }, [lines, defaultPolicy, defaultAnchor]);
  const parsed = useMemo(
    () =>
      (lines ?? []).map((line) => ({ line, detected: detectRule(line) })).filter((item) => item.detected?.type !== 'MATCH'),
    [lines],
  );
  const valid = parsed.filter((p) => p.detected);

  const submit = async () => {
    setBusy(true);
    try {
      const results = await ruleApi.batch(
        profileId,
        valid.map(({ detected }) => ({
          op: 'create' as const,
          rule: { anchor, type: detected!.type, value: detected!.value, policy, source: 'manual' as const },
        })),
      );
      const failed = results.filter((r) => r.status >= 400);
      if (failed.length) {
        notify.warn(`${results.length - failed.length} 条已添加，${failed.length} 条失败`, failed[0].error?.detail ?? failed[0].error?.title);
      } else {
        notify.success(`已添加 ${results.length} 条规则`);
      }
      afterRuleWrite(profileId);
      onClose();
    } catch (error) {
      notify.error(error, '批量添加失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!lines}
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title="批量添加规则"
      description={`识别出 ${valid.length} 条规则，它们会全部指向同一个策略组。`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!valid.length || !policy}
            data-agent-confirm={`批量添加 ${valid.length} 条规则`}
            onClick={() => void submit()}
          >
            添加 {valid.length} 条
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        全部指向
        <Combobox
          aria-label="批量规则去向"
          value={policy}
          onChange={setPolicy}
          options={policyOptions}
          className="w-[180px]"
          renderValue={(v) => <PolicyChip policy={v} size="sm" className="border-0 bg-transparent px-0" />}
        />
        插入到
        <div className="w-[120px]">
          <Select label="批量插入锚点" value={anchor} onValueChange={setAnchor} mono options={anchors.map((a) => ({ value: a, label: a }))} />
        </div>
      </div>
      <div className="max-h-[340px] overflow-y-auto rounded-lg border border-line">
        <table className="w-full text-left text-xs">
          <tbody className="divide-y divide-line">
            {parsed.map(({ line, detected }, index) => (
              <tr key={`${line}-${index}`} className={cn(!detected && 'text-ink-4')}>
                <td className="w-10 px-3 py-2 tnum text-ink-4">{index + 1}</td>
                <td className="px-2 py-2 font-mono text-ink-2">{line}</td>
                <td className="px-2 py-2">{detected ? <Badge mono>{detected.type}</Badge> : <span>无法识别</span>}</td>
                <td className="px-3 py-2 font-mono text-ink">{detected?.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
