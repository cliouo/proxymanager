'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowRight,
  Clapperboard,
  Gauge,
  KeyRound,
  ListChecks,
  RefreshCw,
  Rss,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  SquarePen,
  X,
} from 'lucide-react';
import { useAssistantConfig, useProfiles } from '@/ui/data/hooks';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { errorMessage } from '@/ui/data/api';
import { cn } from '@/ui/lib/cn';
import { Button, Monogram, Skeleton, Tooltip } from '@/ui/primitives';
import { modKey } from '@/ui/shell/hotkeys';
import { useActiveProfile } from '@/ui/shell/scope';
import { setUi, useUi } from '@/ui/shell/state';
import { Composer, type ComposerHandle } from './composer';
import {
  clearConversation,
  markExpired,
  resolveConfirm,
  retry,
  sendMessage,
  stop,
  useConversation,
  type ConfirmItem,
  type ProfileTarget,
} from './session';
import { Thread, type ThreadHandlers } from './thread';

const SUGGESTIONS = [
  { icon: ScanSearch, text: '帮我检查一下这份配置有没有问题' },
  { icon: Clapperboard, text: '把 netflix.com 走流媒体' },
  { icon: Gauge, text: '新建一个美国节点自动测速组' },
  { icon: Rss, text: '我的订阅源都正常吗？' },
];

function IconTile({ icon: Icon }: { icon: typeof Sparkles }) {
  return (
    <span className="flex size-10 items-center justify-center rounded-xl border border-accent-line/60 bg-accent-soft text-accent shadow-xs">
      <Icon size={18} strokeWidth={1.75} />
    </span>
  );
}

function NotConfigured({ onNavigate }: { onNavigate: () => void }) {
  const points = [
    { icon: ListChecks, text: '查看与修改规则、策略组、节点处理、基础配置' },
    { icon: ShieldCheck, text: '所有写操作都会先出确认卡，你点确认才会执行' },
    { icon: KeyRound, text: '用你自己的 DeepSeek（或 OpenAI 兼容）模型，浏览器直接调用' },
  ];
  return (
    <div className="flex flex-1 flex-col justify-center gap-5 px-5 py-8 animate-rise">
      <div className="flex flex-col items-start gap-3">
        <IconTile icon={Sparkles} />
        <div>
          <h2 className="text-md font-semibold tracking-tight text-ink">先接入一个模型</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            填好模型地址和 API Key 后，就能用一句话查看和调整配置。
          </p>
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-surface shadow-xs">
        {points.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2.5 px-3.5 py-3 text-xs leading-relaxed text-ink-2">
            <Icon size={14} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-3" />
            {text}
          </li>
        ))}
      </ul>
      <Button variant="primary" trailingIcon={ArrowRight} className="self-start" asChild>
        <Link href="/settings#assistant" onClick={onNavigate}>
          去配置模型
        </Link>
      </Button>
    </div>
  );
}

function Welcome({ profileLabel, onPick }: { profileLabel: string; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col justify-end gap-5 px-4 pb-3 pt-8 animate-rise">
      <div className="flex flex-col items-start gap-3 px-1">
        <IconTile icon={Sparkles} />
        <div>
          <h2 className="text-md font-semibold tracking-tight text-ink">有什么可以帮你？</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            我会在「{profileLabel}」里查看规则、策略组、节点和基础配置。任何改动都会先给你确认。
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {SUGGESTIONS.map(({ icon: Icon, text }) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className="group flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-sm text-ink-2 shadow-xs transition-[border-color,background-color,color] hover:border-line-strong hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Icon size={15} strokeWidth={1.75} className="shrink-0 text-ink-3 group-hover:text-accent" />
            <span className="min-w-0 flex-1">{text}</span>
            <ArrowRight size={13} className="shrink-0 text-ink-4 opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 flex-col justify-end gap-3 px-5 pb-6" aria-busy>
      <Skeleton className="size-10 rounded-xl" />
      <Skeleton className="h-4 w-36" />
      <Skeleton className="h-3 w-64" />
      <div className="mt-2 flex flex-col gap-1.5">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

const isDocked = () => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches;

export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const profile = useActiveProfile();
  const profiles = useProfiles();
  const config = useAssistantConfig();
  const target: ProfileTarget | null = useMemo(
    () => (profile ? { id: profile.id, name: profile.name, label: profile.display_name || profile.name } : null),
    [profile],
  );
  const convo = useConversation(target?.id ?? null);
  const composerRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const draft = useUi((s) => s.assistantDraft);

  const configured = !!config.data;
  const ready = configured && !!target;
  const loading = config.isLoading || (!target && profiles.isLoading);

  // Focus the composer once the panel is usable (after Radix's own open autofocus).
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  // Hand-off from openAssistant(draft): prefill, then clear.
  useEffect(() => {
    if (draft === null || !ready) return;
    composerRef.current?.setValue(draft);
    requestAnimationFrame(() => composerRef.current?.focus());
    setUi({ assistantDraft: null });
  }, [draft, ready]);

  // Follow the conversation unless the user scrolled up.
  useIsomorphicLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [convo.items]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  };
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setShowJump(false);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const send = useCallback(
    (text: string) => {
      if (!target) return;
      pinned.current = true;
      setShowJump(false);
      sendMessage(target, text);
    },
    [target],
  );

  const handlers: ThreadHandlers = useMemo(
    () => ({
      onRetry: () => target && retry(target),
      onConfirm: (id: string) => target && void resolveConfirm(target, id, 'confirm'),
      onCancel: (id: string) => target && void resolveConfirm(target, id, 'cancel'),
      onExpire: (id: string) => target && markExpired(target.id, id),
      onReissue: (item: ConfirmItem) => send(`刚才的确认卡过期了，请重新发起这项改动：${item.summary}`),
    }),
    [target, send],
  );

  const hasConversation = convo.items.length > 0;

  let body: React.ReactNode;
  if (loading) body = <LoadingState />;
  else if (config.error)
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-ink">AI 设置读取失败</p>
        <p className="text-xs text-ink-3">{errorMessage(config.error)}</p>
        <Button size="sm" icon={RefreshCw} onClick={() => void config.refetch()}>
          重试
        </Button>
      </div>
    );
  else if (!configured) body = <NotConfigured onNavigate={() => !isDocked() && onClose()} />;
  else if (!target)
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-ink">还没有配置文件</p>
        <p className="text-xs text-ink-3">先创建一份配置文件，助手才能帮你查看和修改。</p>
      </div>
    );
  else if (!hasConversation) body = <Welcome profileLabel={target.label} onPick={send} />;
  else
    body = (
      <div className="px-4 py-4">
        <Thread items={convo.items} running={convo.running} profileLabel={target.label} handlers={handlers} />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-line pl-3.5 pr-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Sparkles size={15} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold text-ink">AI 助手</div>
          <div className="truncate font-mono text-2xs text-ink-3">
            {config.data?.model ?? (loading ? ' ' : '未配置模型')}
          </div>
        </div>
        {target && (
          <Tooltip content="助手读写的是这份配置文件">
            <span className="inline-flex h-6 max-w-[132px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 pl-1 pr-2 text-2xs font-medium text-ink-2">
              <Monogram name={target.label} colorKey={target.name} size={16} />
              <span className="truncate">{target.label}</span>
            </span>
          </Tooltip>
        )}
        {ready && (
          <Tooltip content="新对话">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={SquarePen}
              aria-label="新对话"
              disabled={!hasConversation}
              onClick={() => {
                clearConversation(target.id);
                composerRef.current?.focus();
              }}
            />
          </Tooltip>
        )}
        <Tooltip content="关闭" shortcut={`${modKey()} J`}>
          <Button variant="ghost" size="sm" iconOnly icon={X} aria-label="关闭 AI 助手" onClick={onClose} />
        </Tooltip>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
          aria-live="off"
        >
          {body}
        </div>
        {showJump && hasConversation && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="回到底部"
            className={cn(
              'absolute bottom-2 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-md animate-pop',
              'hover:text-ink',
            )}
          >
            <ArrowDown size={15} />
          </button>
        )}
      </div>

      {ready && (
        <Composer
          ref={composerRef}
          running={convo.running}
          onSend={send}
          onStop={() => stop(target.id)}
        />
      )}
    </div>
  );
}
