'use client';

import { useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { NamingField } from '@/lib/proxies/naming';
import type { SourceHealthReport } from '@/lib/proxies/namingHealth';
import { REGIONS } from '@/lib/proxies/regions';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Card, CardHeader, Input, Monogram, Select, Tooltip } from '@/ui/primitives';
import {
  ASSIGNED_FIELDS,
  escapeRegex,
  FIELD_META,
  FIELD_ORDER,
  RULE_FIELDS,
  sampleDisplay,
  type NamingPlan,
  type RecognitionRule,
  type RuleField,
} from './model';

/* ─── collapsible section ────────────────────────────────────────────── */

export function Section({
  title,
  description,
  badge,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  description: string;
  badge?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-start gap-2.5 px-4 py-3.5 text-left transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <ChevronRight size={15} className={cn('mt-0.5 shrink-0 text-ink-3 transition-transform', open && 'rotate-90')} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-tight text-ink">
            {title}
            {badge}
          </div>
          <p className="mt-0.5 text-xs text-ink-3">{description}</p>
        </div>
      </button>
      {open && <div className="animate-rise border-t border-line px-4 py-3.5">{children}</div>}
    </Card>
  );
}

/* ─── source aliases (pools) ─────────────────────────────────────────── */

export function AliasesEditor({
  health,
  plan,
  onChange,
}: {
  health: SourceHealthReport[];
  plan: NamingPlan;
  onChange: (plan: NamingPlan) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {health.map((report) => {
        const value = plan.sourceAliases[report.sourceKey] ?? '';
        return (
          <div key={report.sourceKey} className="flex items-center gap-2.5">
            <Monogram name={report.sourceLabel} size={22} />
            <span className="w-28 shrink-0 truncate text-[13px] text-ink-2" title={report.sourceLabel}>
              {report.sourceLabel}
            </span>
            <Input
              inputSize="sm"
              className="min-w-0 flex-1"
              value={value}
              maxLength={40}
              placeholder={`沿用「${report.sourceLabel}」`}
              aria-label={`${report.sourceLabel} 的别名`}
              onChange={(event) =>
                onChange({ ...plan, sourceAliases: { ...plan.sourceAliases, [report.sourceKey]: event.target.value } })
              }
            />
          </div>
        );
      })}
    </div>
  );
}

/* ─── recognition rules ──────────────────────────────────────────────── */

const REGION_OPTIONS = REGIONS.map((r) => ({ value: r.code, label: `${r.emoji} ${r.zh}` }));

export function RulesEditor({
  plan,
  onChange,
  errors,
}: {
  plan: NamingPlan;
  onChange: (plan: NamingPlan) => void;
  errors: Array<string | null>;
}) {
  const rules = plan.recognitionRules;
  const update = (index: number, patch: Partial<RecognitionRule>) =>
    onChange({ ...plan, recognitionRules: rules.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  return (
    <div className="flex flex-col gap-2.5">
      {rules.length === 0 && (
        <p className="text-xs leading-relaxed text-ink-3">
          例如节点名带「IPLC」时让线路显示为 IPLC：匹配 <span className="font-mono text-ink-2">IPLC</span> → 线路 = IPLC。
        </p>
      )}
      {rules.map((rule, index) => (
        <div key={index} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            <span>节点名匹配</span>
            <Input
              mono
              inputSize="sm"
              className="w-36 min-w-0 flex-1"
              value={rule.pattern}
              maxLength={100}
              placeholder="IPLC"
              invalid={!!errors[index] && !rule.pattern}
              aria-label="要匹配的文字或正则"
              onChange={(event) => update(index, { pattern: event.target.value })}
            />
            <span>时，</span>
            <Select<RuleField>
              size="sm"
              className="w-[88px]"
              value={rule.field}
              onValueChange={(field) => update(index, { field, value: field === 'region' ? '' : rule.value })}
              options={RULE_FIELDS}
            />
            <span>设为</span>
            {rule.field === 'region' ? (
              <Select<string>
                size="sm"
                className="w-[120px]"
                value={rule.value || undefined}
                placeholder="选择地区"
                onValueChange={(value) => update(index, { value })}
                options={REGION_OPTIONS}
              />
            ) : (
              <Input
                inputSize="sm"
                className="w-28"
                value={rule.value}
                maxLength={24}
                placeholder="IPLC"
                aria-label="设定的值"
                onChange={(event) => update(index, { value: event.target.value })}
              />
            )}
            <Button
              size="sm"
              variant="danger-ghost"
              iconOnly
              icon={Trash2}
              aria-label="删除规则"
              onClick={() => onChange({ ...plan, recognitionRules: rules.filter((_, i) => i !== index) })}
            />
          </div>
          {errors[index] && <p className="text-xs text-bad">{errors[index]}</p>}
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="secondary"
          icon={Plus}
          disabled={rules.length >= 32}
          onClick={() => onChange({ ...plan, recognitionRules: [...rules, { pattern: '', field: 'route', value: '' }] })}
        >
          添加规则
        </Button>
      </div>
      <p className="text-2xs text-ink-4">匹配不区分大小写，支持正则；最多 32 条，按顺序生效。</p>
    </div>
  );
}

/** Rule suggestion from a drift report: pattern prefilled, value left for the user. */
export function ruleFromDrift(field: NamingField, sample: string): RecognitionRule {
  const ruleField: RuleField = field === 'vendor' || field === 'region' || field === 'entry' ? field : 'route';
  return { pattern: escapeRegex(sample.replace(/[\u{1F000}-\u{1FFFF}]/gu, '').trim() || sample), field: ruleField, value: '' };
}

/* ─── coverage matrix ────────────────────────────────────────────────── */

const MATRIX_FIELDS = FIELD_ORDER.filter((f) => !ASSIGNED_FIELDS.has(f));

export function CoverageCard({
  health,
  rulesDiffer,
  onSuggestRule,
}: {
  health: SourceHealthReport[];
  rulesDiffer: boolean;
  onSuggestRule: (rule: RecognitionRule) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const multi = health.length > 1;
  const fields = showAll ? MATRIX_FIELDS : MATRIX_FIELDS.slice(0, 6);
  const notes = health.flatMap((report) => [
    ...(report.ambiguousCount > 0
      ? [{ key: `${report.sourceKey}:amb`, report, text: `${report.ambiguousCount} 个节点名的识别结果有冲突（例如国旗和文字指向不同地区）` }]
      : []),
    ...report.drift.map((d) => ({
      key: `${report.sourceKey}:${d.field}`,
      report,
      text: `${d.count} 个节点名疑似带有${FIELD_META[d.field].label}信息但没认出来：${d.samples.slice(0, 2).join('、')}`,
      drift: d,
    })),
  ]);
  return (
    <Card>
      <CardHeader
        title="识别情况"
        description={`每个字段在多少节点名里被认出来。覆盖不全的字段适合放进可选片段。${rulesDiffer ? '（按已应用的识别规则统计）' : ''}`}
      />
      <div className="overflow-x-auto px-4 pb-2">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-2xs text-ink-3">
              <th className="py-1.5 pr-3 font-medium">字段</th>
              {health.map((r) => (
                <th key={r.sourceKey} className="min-w-[120px] py-1.5 pr-3 font-medium">
                  {multi ? <span className="block max-w-[140px] truncate">{r.sourceLabel}</span> : `覆盖（${r.nodeCount} 个节点）`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {fields.map((field) => (
              <tr key={field}>
                <td className="whitespace-nowrap py-2 pr-3 text-ink-2">{FIELD_META[field].label}</td>
                {health.map((report) => {
                  const cov = report.fields.find((f) => f.field === field);
                  if (!cov) return <td key={report.sourceKey} />;
                  const samples = cov.samples.map((s) => `${sampleDisplay(field, s.value)} ×${s.count}`).join(' · ');
                  return (
                    <td key={report.sourceKey} className="py-2 pr-3">
                      <Tooltip content={cov.present ? `${samples}${cov.sampleTruncated ? ` 等 ${cov.sampleTotal} 种` : ''}` : '没有识别到'}>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-full min-w-[48px] overflow-hidden rounded-full bg-surface-3">
                            <div
                              className={cn('h-full rounded-full', cov.percent === 100 ? 'bg-ok' : 'bg-ink-3')}
                              style={{ width: `${cov.percent}%` }}
                            />
                          </div>
                          <span className={cn('tnum w-9 shrink-0 text-right', cov.percent ? 'text-ink-2' : 'text-ink-4')}>
                            {cov.percent ? `${cov.percent}%` : '—'}
                          </span>
                          {cov.confidence.low > 0 ? (
                            <Tooltip content={`${cov.confidence.low} 个结果不太确定`}>
                              <AlertTriangle size={12} className="shrink-0 text-warn" aria-label="有低置信结果" />
                            </Tooltip>
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                        </div>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between py-2">
          <span className="text-2xs text-ink-4">来源、序号由系统自动生成，始终可用。</span>
          <Button size="xs" variant="ghost" onClick={() => setShowAll(!showAll)}>
            {showAll ? '收起' : `全部 ${MATRIX_FIELDS.length} 个字段`}
          </Button>
        </div>
      </div>
      {notes.length > 0 && (
        <ul className="flex flex-col divide-y divide-line border-t border-line">
          {notes.map((note) => (
            <li key={note.key} className="flex items-start gap-2.5 px-4 py-2.5 text-xs">
              <AlertTriangle size={13} className="mt-px shrink-0 text-warn" />
              <span className="min-w-0 flex-1 text-ink-2">
                {multi && <Badge className="mr-1.5">{note.report.sourceLabel}</Badge>}
                {note.text}
              </span>
              {'drift' in note && note.drift && note.drift.samples[0] && (
                <Button size="xs" variant="secondary" onClick={() => onSuggestRule(ruleFromDrift(note.drift.field, note.drift.samples[0]))}>
                  加识别规则
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
