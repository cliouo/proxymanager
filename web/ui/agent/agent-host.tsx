'use client';

import { useEffect } from 'react';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@ui-sdk/react/alert-dialog';
import { ShieldAlert } from 'lucide-react';
import { registerAppWebMcp, type AppAgent } from './bridge';
import {
  findConfirmTargetElement,
  resolveAgentConfirm,
  useHasInlineConfirmHost,
  usePendingAgentConfirm,
  type AgentConfirmRequest,
} from './confirm';

function useConfirmTargetHighlight(request: AgentConfirmRequest | null) {
  useEffect(() => {
    if (!request) return;
    const target = findConfirmTargetElement(request.step);
    if (!target) return;
    target.setAttribute('data-agent-confirm-target', 'true');
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return () => {
      target.removeAttribute('data-agent-confirm-target');
    };
  }, [request]);
}

export function AgentConfirmCard({ request }: { request: AgentConfirmRequest }) {
  const targetLabel =
    (typeof request.step.args[0] === 'string' && request.step.args[0]) ||
    request.step.label ||
    request.step.ref;

  return (
    <div
      role="region"
      aria-label="AI 操作确认"
      data-agent-hidden
      className="animate-rise rounded-xl border border-warn/35 bg-warn-soft/55 p-3.5 shadow-xs"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-warn/15 text-warn">
          <ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-ink">AI 请求确认</div>
          <p className="mt-1 text-sm leading-relaxed text-ink">{request.message}</p>
          {targetLabel && (
            <div className="mt-1.5 text-2xs text-ink-3">
              目标操作：<span className="font-medium text-ink-2">{targetLabel}</span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => resolveAgentConfirm(request.id, false)}
          className="inline-flex h-7 select-none items-center justify-center rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={() => resolveAgentConfirm(request.id, true)}
          className="inline-flex h-7 select-none items-center justify-center rounded-md bg-inverse px-3 text-xs font-medium text-inverse-ink shadow-xs transition hover:bg-inverse/88 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          允许执行
        </button>
      </div>
    </div>
  );
}

export function AgentConfirmDialog() {
  const request = usePendingAgentConfirm();
  const hasInlineHost = useHasInlineConfirmHost();
  useConfirmTargetHighlight(request);

  const showModal = Boolean(request) && !hasInlineHost;
  const targetLabel = request?.step.label || request?.step.ref;

  return (
    <div data-agent-hidden>
      <AlertDialog
        open={showModal}
        onOpenChange={(open, details) => {
          if (!open && request && !hasInlineHost) {
            resolveAgentConfirm(request.id, details.returnValue === 'confirm');
          }
        }}
      >
        <AlertDialogBackdrop className="fixed inset-0 z-50 bg-overlay backdrop-blur-[1.5px] transition-opacity duration-150 data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <AlertDialogContent
          data-agent-hidden
          className="fixed left-1/2 top-[min(18vh,140px)] z-50 m-0 flex w-[calc(100%-24px)] max-w-[440px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl outline-none transition-[opacity,transform] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
        >
          <div className="flex flex-col gap-2 px-5 pb-4 pt-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <ShieldAlert size={16} strokeWidth={1.85} aria-hidden="true" />
              </span>
              <AlertDialogTitle className="text-md font-semibold tracking-tight text-ink">
                AI 操作确认
              </AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-sm leading-relaxed text-ink-2">
              {request?.message ?? '需要你的确认才能继续执行这项操作。'}
            </AlertDialogDescription>
            {targetLabel && (
              <div className="rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-ink-3">
                目标控件：<span className="font-medium text-ink-2">{targetLabel}</span>
              </div>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
            <AlertDialogClose className="inline-flex h-8 select-none items-center justify-center rounded-md px-3 text-sm font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              拒绝
            </AlertDialogClose>
            <AlertDialogClose
              value="confirm"
              className="inline-flex h-8 select-none items-center justify-center rounded-md bg-inverse px-3 text-sm font-medium text-inverse-ink shadow-xs transition hover:bg-inverse/88 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              允许执行
            </AlertDialogClose>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function AgentHost({ agent }: { agent?: AppAgent } = {}) {
  useEffect(() => registerAppWebMcp(agent), [agent]);
  return <AgentConfirmDialog />;
}
