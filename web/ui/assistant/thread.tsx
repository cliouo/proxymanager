'use client';

import { memo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Brain, Check, ChevronRight, CircleAlert, Play, RotateCcw, Settings2, X } from 'lucide-react';
import { cn } from '@/ui/lib/cn';
import { Button, CopyButton, Spinner } from '@/ui/primitives';
import { formatSeconds, toYamlish } from './format';
import { TOOL_ERROR_LABELS } from './diagnostics';
import { toolLabel } from './labels';
import { Markdown } from './markdown';
import type { AssistantItem, Item, NoticeItem, ToolItem } from './session';

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end pl-10">
      <div className="max-w-full whitespace-pre-wrap rounded-2xl rounded-br-md bg-inverse px-3.5 py-2 text-sm leading-relaxed text-inverse-ink [overflow-wrap:anywhere]">
        {text}
      </div>
    </div>
  );
}

function Thinking({ text, ms, live }: { text: string; ms?: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const expanded = open || live;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 rounded-md py-0.5 text-xs text-ink-3 transition-colors hover:text-ink-2"
      >
        <Brain size={13} strokeWidth={1.75} className={cn(live && 'animate-pulse text-accent')} />
        <span>{live ? '正在思考…' : `思考过程${ms ? ` · ${formatSeconds(ms)}` : ''}`}</span>
        {!live && <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />}
      </button>
      {expanded && (
        <div
          className={cn(
            'mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 text-xs leading-relaxed text-ink-3 [overflow-wrap:anywhere]',
            live && 'flex max-h-24 flex-col justify-end overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,#000_45%)]',
          )}
        >
          {text}
        </div>
      )}
    </div>
  );
}

function Dots() {
  return (
    <div role="status" aria-label="正在思考" className="flex h-6 items-center gap-1">
      {[0, 160, 320].map((delay) => (
        <span key={delay} className="size-1.5 animate-pulse rounded-full bg-ink-4" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </div>
  );
}

const AssistantBlock = memo(function AssistantBlock({ item }: { item: AssistantItem }) {
  const hasText = item.text.trim().length > 0;
  return (
    <div className="group/msg flex flex-col gap-2">
      {item.reasoning.trim() && <Thinking text={item.reasoning} ms={item.thinkingMs} live={item.streaming && !hasText} />}
      {hasText && <Markdown text={item.text} streaming={item.streaming} />}
      {!hasText && !item.reasoning.trim() && item.streaming && <Dots />}
      {item.truncated && <p className="text-2xs text-warn">回答达到长度上限，被截断了。</p>}
      {hasText && !item.streaming && (
        <div className="-ml-1 -mt-1 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100">
          <CopyButton text={item.text} size="sm" label="复制回答" />
        </div>
      )}
    </div>
  );
});

function StatusIcon({ status }: { status: ToolItem['status'] }) {
  if (status === 'pending' || status === 'running') return <Spinner size={12} className="text-accent" />;
  if (status === 'error') return <X size={12} strokeWidth={2.5} className="text-bad" />;
  return <Check size={12} strokeWidth={2.5} className="text-ok" />;
}

const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const busy = item.status === 'pending' || item.status === 'running';
  const expandable = !busy;
  const hasInput = !!item.input && typeof item.input === 'object' && Object.keys(item.input as object).length > 0;
  return (
    <li>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        aria-disabled={!expandable || undefined}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg py-1 pr-1.5 text-left text-xs transition-colors',
          expandable && 'hover:bg-surface-2',
        )}
      >
        <span className="relative z-[1] flex size-[22px] shrink-0 items-center justify-center rounded-full border border-line bg-surface">
          <StatusIcon status={item.status} />
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className={cn('font-medium', item.status === 'error' ? 'text-bad' : 'text-ink-2')}>
            {busy && item.status === 'pending' ? `准备${toolLabel(item.name)}` : toolLabel(item.name)}
          </span>
          {item.hint && <span className="ml-1.5 font-mono text-[11px] text-ink-3">{item.hint}</span>}
        </span>
        {item.status === 'error' && !open && <span className="max-w-[45%] truncate text-2xs text-bad">{item.error}</span>}
        {item.summary && <span className="tnum shrink-0 text-2xs text-ink-3">{item.summary}</span>}
        {expandable && (
          <ChevronRight size={13} className={cn('shrink-0 text-ink-4 transition-transform', open && 'rotate-90')} />
        )}
      </button>
      {open && (
        <div className="mb-1.5 ml-[32px] mt-0.5 overflow-hidden rounded-lg border border-line bg-sunken text-[11px]">
          {hasInput && (
            <div className="border-b border-line px-2.5 py-2">
              <div className="mb-1 text-2xs text-ink-3">参数</div>
              <pre className="whitespace-pre-wrap font-mono text-ink-2 [overflow-wrap:anywhere]">{toYamlish(item.input)}</pre>
            </div>
          )}
          <div className="px-2.5 py-2">
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
              <span>{item.status === 'error' ? '错误' : '结果'}</span>
              {item.status === 'error' && item.errorCode && (
                <span className="rounded bg-bad-soft px-1.5 py-0.5 font-medium text-bad">
                  {TOOL_ERROR_LABELS[item.errorCode]}
                </span>
              )}
              {item.status === 'error' && typeof item.failedStepIndex === 'number' && (
                <span className="text-ink-3">
                  第 {item.failedStepIndex + 1} 步失败
                  {typeof item.completedSteps === 'number' && item.completedSteps > 0
                    ? `（前 ${item.completedSteps} 步已执行）`
                    : ''}
                </span>
              )}
            </div>
            <pre
              className={cn(
                'max-h-60 overflow-auto whitespace-pre-wrap font-mono [overflow-wrap:anywhere]',
                item.status === 'error' ? 'text-bad' : 'text-ink-2',
              )}
            >
              {item.status === 'error' ? item.error : item.preview || '（空）'}
            </pre>
            {item.status === 'error' && item.errorHint && (
              <p className="mt-1.5 rounded-md border border-line bg-surface px-2 py-1.5 text-[11px] leading-relaxed text-ink-2">
                建议：{item.errorHint}
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  );
});

function ToolGroup({ items }: { items: ToolItem[] }) {
  return (
    <ul aria-label="助手的操作" className="relative flex flex-col">
      {items.length > 1 && <span aria-hidden className="absolute bottom-3.5 left-[10.5px] top-3.5 w-px bg-line" />}
      {items.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </ul>
  );
}

function Notice({ item, onRetry, canRetry }: { item: NoticeItem; onRetry: () => void; canRetry: boolean }) {
  if (item.tone === 'info') {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex w-full items-center gap-3 text-2xs text-ink-3">
          <span className="h-px flex-1 bg-line" />
          {item.text}
          <span className="h-px flex-1 bg-line" />
        </div>
        {item.continue && canRetry && (
          <Button size="xs" variant="secondary" icon={Play} onClick={onRetry}>
            继续执行
          </Button>
        )}
      </div>
    );
  }
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-bad/20 bg-bad-soft px-3 py-2.5">
      <CircleAlert size={15} className="mt-px shrink-0 text-bad" />
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-relaxed text-ink [overflow-wrap:anywhere]">{item.text}</p>
        {((item.retry && canRetry) || item.settings) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.retry && canRetry && (
              <Button size="xs" variant="secondary" icon={RotateCcw} onClick={onRetry}>
                重试
              </Button>
            )}
            {item.settings && (
              <Button size="xs" variant="ghost" icon={Settings2} asChild>
                <Link href="/settings#assistant">检查 AI 设置</Link>
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function Thread({
  items,
  running,
  onRetry,
}: {
  items: Item[];
  running: boolean;
  onRetry: () => void;
}) {
  const blocks: ReactNode[] = [];
  let tools: ToolItem[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    blocks.push(<ToolGroup key={`tools-${tools[0].id}`} items={tools} />);
    tools = [];
  };
  items.forEach((item, index) => {
    if (item.type === 'tool') {
      tools.push(item);
      return;
    }
    flushTools();
    if (item.type === 'user') blocks.push(<UserBubble key={item.id} text={item.text} />);
    else if (item.type === 'assistant') blocks.push(<AssistantBlock key={item.id} item={item} />);
    else if (item.type === 'notice')
      blocks.push(
        <Notice key={item.id} item={item} onRetry={onRetry} canRetry={!running && index === items.length - 1} />,
      );
  });
  flushTools();
  const last = items[items.length - 1];
  const waiting =
    running &&
    (!last ||
      last.type === 'user' ||
      last.type === 'notice' ||
      (last.type === 'tool' && last.status !== 'running' && last.status !== 'pending'));
  return (
    <div className="flex flex-col gap-4">
      {blocks}
      {waiting && <Dots />}
    </div>
  );
}
