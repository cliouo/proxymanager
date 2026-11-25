'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@ui-sdk/react/alert-dialog';
import {
  Toast,
  ToastAction,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  createToaster,
} from '@ui-sdk/react/toast';
import { AlertTriangle, CircleAlert, CircleCheck, Info, ShieldAlert, X } from 'lucide-react';
import { ApiError, errorMessage, type ConfigIssue } from '@/ui/data/api';
import { cn } from '@/ui/lib/cn';
import { Button } from './button';
import { Dialog } from './overlay';
import { ASSISTANT_PERSISTENT_SELECTORS, useWorkspaceOverlayScope } from './overlay-scope';

function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: T) => {
      state = next;
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const appToaster = createToaster<ReactNode>();

interface IssuesState {
  title: string;
  detail?: string;
  issues: ConfigIssue[];
}

const issuesStore = createStore<IssuesState | null>(null);

export function showIssues(state: IssuesState) {
  issuesStore.set(state);
}

export const notify = {
  success(message: ReactNode, description?: ReactNode, action?: { label: string; onClick: () => void }) {
    appToaster.success(message, {
      description,
      action: action ? { label: action.label, onAction: () => action.onClick() } : undefined,
    });
  },
  info(message: ReactNode, description?: ReactNode) {
    appToaster.info(message, { description });
  },
  warn(message: ReactNode, description?: ReactNode) {
    appToaster.warning(message, { description });
  },
  error(error: unknown, fallback = '操作失败') {
    if (error instanceof ApiError) {
      const title = error.status === 422 && error.issues.length ? '配置校验未通过' : error.title || fallback;
      const description = errorMessage(error);
      const hasMore =
        error.issues.length > 1 ||
        (error.issues.length === 1 && error.detail && error.detail !== error.issues[0].message);
      appToaster.error(title, {
        description,
        duration: 7000,
        action: hasMore
          ? {
              label: '详情',
              onAction: () => showIssues({ title, detail: error.detail, issues: error.issues }),
            }
          : undefined,
      });
      return;
    }
    appToaster.error(fallback, { description: errorMessage(error) });
  },
};

export function AppToaster() {
  return (
    <ToastRegion
      toaster={appToaster}
      side="bottom"
      align="end"
      aria-label="通知"
      className="fixed bottom-5 right-5 z-[70] m-0 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2.5 border-0 bg-transparent p-0 outline-none"
    >
      {(item) => (
        <Toast
          className={cn(
            'relative flex items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm text-ink shadow-lg',
            'transition-[opacity,transform] duration-150 data-starting-style:translate-y-2 data-starting-style:opacity-0 data-ending-style:opacity-0',
          )}
        >
          <span className="mt-0.5 shrink-0" aria-hidden="true">
            {item.type === 'success' ? (
              <CircleCheck size={15} className="text-ok" />
            ) : item.type === 'error' ? (
              <CircleAlert size={15} className="text-bad" />
            ) : item.type === 'warning' ? (
              <AlertTriangle size={15} className="text-warn" />
            ) : (
              <Info size={15} className="text-accent" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <ToastTitle className="font-medium leading-snug text-ink" />
            <ToastDescription className="mt-0.5 text-xs leading-relaxed text-ink-2" />
          </div>
          {item.action && (
            <ToastAction className="shrink-0 rounded-md bg-inverse px-2.5 py-1 text-xs font-medium text-inverse-ink hover:bg-inverse/88" />
          )}
          <ToastClose
            aria-label="关闭通知"
            className="-mr-1 -mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <X size={13} />
          </ToastClose>
        </Toast>
      )}
    </ToastRegion>
  );
}

function IssuesDialog() {
  const state = useSyncExternalStore(issuesStore.subscribe, issuesStore.get, () => null);
  return (
    <Dialog
      open={!!state}
      onOpenChange={(open) => !open && issuesStore.set(null)}
      title={
        <span className="flex items-center gap-2">
          <ShieldAlert size={17} className="text-bad" />
          {state?.title ?? '校验未通过'}
        </span>
      }
      description="保存前会预演最终配置。以下问题阻止了这次写入，修正后再试即可。"
      footer={
        <Button variant="primary" onClick={() => issuesStore.set(null)}>
          知道了
        </Button>
      }
    >
      {state?.detail && <p className="mb-3 text-sm text-ink-2">{state.detail}</p>}
      <ul className="flex flex-col gap-2">
        {state?.issues.map((issue, index) => (
          <li
            key={`${issue.code ?? ''}-${issue.section ?? ''}-${index}`}
            className="flex gap-2.5 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2.5"
          >
            <CircleAlert size={15} className="mt-0.5 shrink-0 text-bad" />
            <div className="min-w-0 text-sm">
              <div className="text-ink">{issue.message}</div>
              {(issue.path || issue.section) && (
                <div className="mt-0.5 font-mono text-[11px] text-ink-3">
                  {[issue.section, Array.isArray(issue.path) ? issue.path.join('.') : issue.path]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

interface ConfirmRequest {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: 'danger' | 'default';
  confirmHint?: string;
  resolve: (ok: boolean) => void;
}

const confirmStore = createStore<ConfirmRequest | null>(null);

export function confirmAction(options: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    confirmStore.set({ ...options, resolve });
  });
}

function ConfirmDialog() {
  const request = useSyncExternalStore(confirmStore.subscribe, confirmStore.get, () => null);
  const { scopedContainer, keepAssistantInteractive } = useWorkspaceOverlayScope();
  const isScoped = Boolean(scopedContainer);
  const confirmMessage =
    request?.confirmHint ??
    (typeof request?.title === 'string' ? request.title : '确认执行此操作');

  const tree = (
    <AlertDialog
      open={!!request}
      persistentElements={keepAssistantInteractive ? ASSISTANT_PERSISTENT_SELECTORS : undefined}
      onOpenChange={(open, details) => {
        if (!open && request) {
          request.resolve(details.returnValue === 'confirm');
          confirmStore.set(null);
        }
      }}
    >
      <AlertDialogBackdrop
        className={cn(
          isScoped ? 'pointer-events-auto absolute inset-0 z-10' : 'fixed inset-0 z-50',
          'bg-overlay backdrop-blur-[1.5px] data-ending-style:animate-[fade-out_0.16s_ease-in_both] data-open:animate-fade-in',
        )}
      />
      <AlertDialogContent
        inline={keepAssistantInteractive || undefined}
        className={cn(
          isScoped
            ? 'pointer-events-auto absolute left-1/2 top-[min(14vh,120px)] z-20 max-h-[calc(100%-min(14vh,120px)-24px)]'
            : 'fixed left-1/2 top-[min(14vh,120px)] z-50 max-h-[calc(100dvh-min(14vh,120px)-24px)]',
          'm-0 flex w-[calc(100%-24px)] max-w-[420px] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl outline-none data-ending-style:animate-[sink_0.16s_ease-in_both] data-open:animate-pop',
        )}
      >
        <div className="flex flex-col gap-1.5 px-5 pb-4 pt-5">
          <AlertDialogTitle className="flex items-center gap-2 text-md font-semibold tracking-tight text-ink">
            {request?.tone === 'danger' && <AlertTriangle size={17} className="shrink-0 text-bad" />}
            {request?.title ?? '确认操作'}
          </AlertDialogTitle>
          {request?.description ? (
            <AlertDialogDescription className="text-sm leading-relaxed text-ink-2">
              {request.description}
            </AlertDialogDescription>
          ) : (
            <AlertDialogDescription className="sr-only">请确认是否继续</AlertDialogDescription>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 py-3">
          <AlertDialogClose className="inline-flex h-8 select-none items-center justify-center rounded-md px-3 text-sm font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            {request?.cancelText ?? '取消'}
          </AlertDialogClose>
          <AlertDialogClose
            value="confirm"
            data-agent-confirm={confirmMessage}
            className={cn(
              'inline-flex h-8 select-none items-center justify-center rounded-md px-3 text-sm font-medium shadow-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              request?.tone === 'danger'
                ? 'bg-bad text-white hover:bg-bad/90'
                : 'bg-inverse text-inverse-ink hover:bg-inverse/88',
            )}
          >
            {request?.confirmText ?? '确认'}
          </AlertDialogClose>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );

  return scopedContainer ? createPortal(tree, scopedContainer) : tree;
}

export function FeedbackHost() {
  return (
    <>
      <IssuesDialog />
      <ConfirmDialog />
    </>
  );
}
