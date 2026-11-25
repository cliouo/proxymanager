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
import { resolveAgentConfirm, usePendingAgentConfirm } from './confirm';

export function AgentConfirmDialog() {
  const request = usePendingAgentConfirm();
  const targetLabel = request?.step.label || request?.step.ref;

  return (
    <div data-agent-hidden>
      <AlertDialog
        open={Boolean(request)}
        onOpenChange={(open, details) => {
          if (!open && request) {
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
