'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowDown,
  ArrowRight,
  KeyRound,
  ListChecks,
  PlusCircle,
  RefreshCw,
  Rss,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Waypoints,
  X,
} from 'lucide-react';
import { errorMessage } from '@/ui/data/api';
import { useAssistantConfig } from '@/ui/data/hooks';
import { useIsomorphicLayoutEffect } from '@/ui/data/query';
import { cn } from '@/ui/lib/cn';
import { Button, Monogram, Skeleton, Tooltip } from '@/ui/primitives';
import { modKey } from '@/ui/shell/hotkeys';
import { useActiveProfile } from '@/ui/shell/scope';
import { setUi, useUi } from '@/ui/shell/state';
import { Composer, type ComposerHandle } from './composer';
import type { AssistantRuntimeContext } from './prompt';
import { clearConversation, retry, sendMessage, stop, useConversation } from './session';
import { Thread } from './thread';

const SUGGESTIONS = [
  { icon: ScanSearch, text: '看看当前页面有哪些内容' },
  { icon: Rss, text: '帮我检查一下我的订阅源都正常吗？' },
  { icon: Waypoints, text: '带我去看看当前配置的策略组' },
  { icon: PlusCircle, text: '帮我新建一个订阅源' },
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
    { icon: ListChecks, text: '直接读取和操作当前页面的规则、策略组、订阅源和配置' },
    { icon: ShieldCheck, text: '所有写入和删除操作都会先弹出确认框，你点确认才会执行' },
    { icon: KeyRound, text: '用你自己的 DeepSeek（或 OpenAI 兼容）模型，浏览器直接调用' },
  ];
  return (
    <div className="flex flex-1 flex-col justify-center gap-5 px-5 py-8 animate-rise">
      <div className="flex flex-col items-start gap-3">
        <IconTile icon={Sparkles} />
        <div>
          <h2 className="text-md font-semibold tracking-tight text-ink">先接入一个模型</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            填好模型地址和 API Key 后，就能用一句话查看和操作界面。
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

function Welcome({ profileLabel, onPick }: { profileLabel: string | null; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-1 flex-col justify-end gap-5 px-4 pb-3 pt-8 animate-rise">
      <div className="flex flex-col items-start gap-3 px-1">
        <IconTile icon={Sparkles} />
        <div>
          <h2 className="text-md font-semibold tracking-tight text-ink">有什么可以帮你？</h2>
          <p className="mt-1 text-xs leading-relaxed text-ink-3">
            {profileLabel
              ? `我可以直接查看和操作当前页面（当前配置「${profileLabel}」），任何写入改动都会先弹窗请你确认。`
              : '我可以直接查看和操作当前页面，任何写入改动都会先弹窗请你确认。'}
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
  const pathname = usePathname() ?? '/';
  const profile = useActiveProfile();
  const config = useAssistantConfig();
  const profileContext = useMemo(
    () => (profile ? { id: profile.id, name: profile.name, label: profile.display_name || profile.name } : null),
    [profile],
  );
  const runtimeContext: AssistantRuntimeContext = useMemo(
    () => ({ pathname, profile: profileContext }),
    [pathname, profileContext],
  );
  const convo = useConversation();
  const composerRef = useRef<ComposerHandle>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const draft = useUi((s) => s.assistantDraft);

  const configured = !!config.data;
  const loading = config.isLoading;

  useEffect(() => {
    if (!configured) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [configured]);

  useEffect(() => {
    if (draft === null || !configured) return;
    composerRef.current?.setValue(draft);
    requestAnimationFrame(() => composerRef.current?.focus());
    setUi({ assistantDraft: null });
  }, [draft, configured]);

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
      pinned.current = true;
      setShowJump(false);
      sendMessage(runtimeContext, text);
    },
    [runtimeContext],
  );

  const onRetry = useCallback(() => retry(runtimeContext), [runtimeContext]);

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
  else if (!hasConversation) body = <Welcome profileLabel={profileContext?.label ?? null} onPick={send} />;
  else
    body = (
      <div className="px-4 py-4">
        <Thread items={convo.items} running={convo.running} onRetry={onRetry} />
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
        {profileContext && (
          <Tooltip content="当前选中的配置文件">
            <span className="inline-flex h-6 max-w-[132px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 pl-1 pr-2 text-2xs font-medium text-ink-2">
              <Monogram name={profileContext.label} colorKey={profileContext.name} size={16} />
              <span className="truncate">{profileContext.label}</span>
            </span>
          </Tooltip>
        )}
        {configured && (
          <Tooltip content="新对话">
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon={SquarePen}
              aria-label="新对话"
              disabled={!hasConversation}
              onClick={() => {
                clearConversation();
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

      {configured && <Composer ref={composerRef} running={convo.running} onSend={send} onStop={stop} />}
    </div>
  );
}
