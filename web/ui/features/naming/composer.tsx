'use client';

import { useMemo, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, HelpCircle, X } from 'lucide-react';
import { Button as UiButton } from '@ui-sdk/react/button';
import type { NamingField } from '@/lib/proxies/naming';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { cn } from '@/ui/lib/cn';
import { Card, CardHeader, Code, Eyebrow, Popover, SegmentedControl, Switch, Textarea, Tooltip } from '@/ui/primitives';
import {
  exampleName,
  FIELD_META,
  FIELD_ORDER,
  insertAt,
  presetsFor,
  templatePieces,
  tokenFor,
  type FieldStat,
  type NamingPlan,
  type Piece,
} from './model';

const SEPARATORS = [
  { value: ' · ', label: '·' },
  { value: ' | ', label: '|' },
  { value: ' - ', label: '-' },
  { value: ' ', label: '空格' },
] as const;

export function TemplateComposer({
  plan,
  onChange,
  aggregate,
  recommended,
  stats,
  error,
}: {
  plan: NamingPlan;
  onChange: (plan: NamingPlan) => void;
  aggregate: boolean;
  recommended: string;
  stats: Map<NamingField, FieldStat>;
  error: string | null;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  const caret = useRef<number | null>(null);
  const [mode, setMode] = useState<'required' | 'optional'>('optional');
  const [separator, setSeparator] = useState<string>(' · ');
  const presets = useMemo(() => presetsFor(aggregate, recommended), [aggregate, recommended]);
  const pieces = useMemo(() => (error ? null : templatePieces(plan.template)), [plan.template, error]);

  useIsomorphicLayoutEffect(() => {
    const el = inputRef.current;
    if (caret.current === null || !el) return;
    el.focus();
    el.setSelectionRange(caret.current, caret.current);
    selection.current = { start: caret.current, end: caret.current };
    caret.current = null;
  }, [plan.template]);

  const setTemplate = (template: string) => onChange({ ...plan, template });

  const insert = (field: NamingField) => {
    const t = plan.template;
    const sel = selection.current ?? { start: t.length, end: t.length };
    const optional = mode === 'optional' && t.trim() !== '';
    const { next, caret: at } = insertAt(t, sel.start, sel.end, tokenFor(field, optional, separator), !optional);
    if (next.length > 512) return;
    caret.current = at;
    setTemplate(next);
  };

  const remember = () => {
    const el = inputRef.current;
    if (el) selection.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  return (
    <Card>
      <CardHeader
        title="命名模板"
        description="从一个预设开始，再点字段增减。所有节点都会按这个格式改名。"
        actions={<SyntaxHelp />}
      />
      <div className="flex flex-col gap-4 px-4 pb-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {presets.map((preset) => {
            const active = preset.template === plan.template;
            return (
              <UiButton
                key={preset.id}
                aria-pressed={active}
                onClick={() => setTemplate(preset.template)}
                className={cn(
                  'flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                  active ? 'border-accent-line bg-accent-soft/60' : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/60',
                )}
              >
                <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                  {preset.label}
                  {preset.id === 'recommended' && <span className="text-2xs font-normal text-accent">默认</span>}
                </span>
                <span className="truncate text-2xs text-ink-3" title={exampleName(preset.template) ?? undefined}>
                  {exampleName(preset.template) ?? preset.hint}
                </span>
              </UiButton>
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5">
          <Textarea
            ref={inputRef}
            mono
            rows={2}
            invalid={!!error}
            value={plan.template}
            aria-label="命名模板"
            spellCheck={false}
            className="min-h-[60px] resize-none text-[13px] [field-sizing:content]"
            onChange={(event) => setTemplate(event.target.value.replace(/\r?\n/g, ' '))}
            onSelect={remember}
            onKeyUp={remember}
            onClick={remember}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.preventDefault();
            }}
          />
          <div className="flex items-start justify-between gap-3 text-xs">
            {error ? (
              <span className="flex items-start gap-1.5 text-bad">
                <CircleAlert size={13} className="mt-px shrink-0" />
                {error}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-ink-3">
                <CircleCheck size={13} className="text-ok" />
                模板有效
              </span>
            )}
            <span className="tnum shrink-0 text-ink-4">{plan.template.length}/512</span>
          </div>
          {pieces && pieces.length > 0 && (
            <Structure pieces={pieces} onRemove={(p) => setTemplate(plan.template.slice(0, p.start) + plan.template.slice(p.end))} />
          )}
        </div>

        <div className="flex flex-col gap-2.5 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Eyebrow>字段 · 点击插入到光标处</Eyebrow>
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                size="sm"
                label="字段插入方式"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'optional', label: '可选片段', hint: '字段缺失时连同分隔符一起省略' },
                  { value: 'required', label: '直接插入' },
                ]}
              />
              {mode === 'optional' && (
                <SegmentedControl
                  size="sm"
                  label="可选片段分隔符"
                  value={separator}
                  onChange={setSeparator}
                  options={SEPARATORS.map((s) => ({ value: s.value, label: s.label, hint: `用「${s.value}」分隔` }))}
                />
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FIELD_ORDER.map((field) => {
              const stat = stats.get(field);
              const meta = FIELD_META[field];
              const missing = stat !== undefined && stat.total > 0 && stat.percent === 0;
              const partial = stat !== undefined && stat.percent > 0 && stat.percent < 100;
              return (
                <Tooltip
                  key={field}
                  content={
                    missing
                      ? `${meta.hint}。这批节点名里没认出${meta.label}，插入后会留空`
                      : partial
                        ? `${meta.hint}。${stat.percent}% 的节点有这个信息，建议作为可选片段`
                        : meta.hint
                  }
                >
                  <UiButton
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(field)}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-[13px] shadow-xs transition-colors',
                      'hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent',
                      missing && 'border-dashed text-ink-3 shadow-none',
                    )}
                  >
                    <span className="font-medium">{meta.label}</span>
                    <span className="max-w-[96px] truncate text-xs text-ink-3">{stat?.sample ?? meta.example}</span>
                    {(missing || partial) && (
                      <span className={cn('tnum text-2xs', missing ? 'text-ink-4' : 'text-warn')}>{stat.percent}%</span>
                    )}
                  </UiButton>
                </Tooltip>
              );
            })}
          </div>
          <p className="text-xs leading-relaxed text-ink-3">
            {mode === 'optional'
              ? '可选片段：节点缺这个信息时，整段（连同分隔符）一起省略，不会留下多余的「·」。'
              : '直接插入：字段原样放进名字；缺失时这一处为空。'}
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line pt-3.5">
          <div>
            <div className="text-[13px] font-medium text-ink">台湾节点使用 🇨🇳 国旗</div>
            <p className="mt-0.5 text-xs text-ink-3">只换国旗，地区名仍是「台湾」。</p>
          </div>
          <Switch checked={plan.tw2cn} onCheckedChange={(tw2cn) => onChange({ ...plan, tw2cn })} label="台湾节点使用中国国旗" />
        </div>
      </div>
    </Card>
  );
}

function Structure({ pieces, onRemove }: { pieces: Piece[]; onRemove: (piece: Piece) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg bg-surface-2/60 p-1.5" aria-label="模板结构">
      {pieces.map((piece) =>
        piece.kind === 'literal' ? (
          <span key={piece.start} className="whitespace-pre px-0.5 font-mono text-xs text-ink-4">
            {piece.text.trim() === '' ? '␣' : piece.text}
          </span>
        ) : (
          <span
            key={piece.start}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-md pl-1.5 pr-0.5 text-xs',
              piece.kind === 'field'
                ? 'border border-line bg-surface text-ink shadow-xs'
                : 'border border-dashed border-line-strong text-ink-2',
            )}
            title={piece.kind === 'optional' ? `可选：没有${FIELD_META[piece.field].label}时整段省略` : undefined}
          >
            {piece.kind === 'optional' ? (
              <>
                <span className="text-ink-4">?</span>
                {piece.inner.map((inner) =>
                  inner.kind === 'literal' ? (
                    <span key={inner.start} className="whitespace-pre font-mono text-ink-4">
                      {inner.text}
                    </span>
                  ) : (
                    <span key={inner.start}>{FIELD_META[inner.field].label}</span>
                  ),
                )}
              </>
            ) : (
              <span>
                {FIELD_META[piece.field].label}
                {piece.mod && <span className="ml-1 font-mono text-2xs text-ink-3">:{piece.mod}</span>}
              </span>
            )}
            <UiButton
              aria-label={`移除${FIELD_META[piece.field].label}`}
              onClick={() => onRemove(piece)}
              className="flex size-5 items-center justify-center rounded text-ink-4 hover:bg-surface-3 hover:text-ink"
            >
              <X size={11} />
            </UiButton>
          </span>
        ),
      )}
    </div>
  );
}

function SyntaxHelp() {
  const rows: Array<[string, string]> = [
    ['${region}', '插入字段，例如「香港」'],
    ['${?rate: · ${rate}}', '可选片段：没有倍率时整段省略'],
    ['${index:3}', '序号补足 3 位：001'],
    ['${protocol:upper}', '协议大写：VLESS'],
    ['${rate:include1x}', '1x 也显示'],
    ['$$', '原样输出 $'],
  ];
  return (
    <Popover
      align="end"
      className="w-[320px] p-3"
      trigger={
        <UiButton className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
          <HelpCircle size={13} />
          写法
        </UiButton>
      }
    >
      <div className="mb-2 text-xs text-ink-2">模板里除了字段，其余文字原样保留。</div>
      <dl className="flex flex-col gap-1.5">
        {rows.map(([code, text]) => (
          <div key={code} className="flex items-baseline justify-between gap-3">
            <dt>
              <Code>{code}</Code>
            </dt>
            <dd className="text-right text-xs text-ink-3">{text}</dd>
          </div>
        ))}
      </dl>
    </Popover>
  );
}
