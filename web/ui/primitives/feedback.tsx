'use client';

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlertTriangle, CircleAlert, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, errorMessage, type ConfigIssue } from '@/ui/data/api';
import { Button } from './button';
import { Dialog } from './overlay';

/* ─── tiny external store ────────────────────────────────────────────── */

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

/* ─── notify ─────────────────────────────────────────────────────────── */

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
  success(message: ReactNode, description?: ReactNode) {
    toast.success(message, { description });
  },
  info(message: ReactNode, description?: ReactNode) {
    toast(message, { description });
  },
  warn(message: ReactNode, description?: ReactNode) {
    toast.warning(message, { description });
  },
  /** Errors from the API keep their structure: multi-issue failures get a details action. */
  error(error: unknown, fallback = '操作失败') {
    if (error instanceof ApiError) {
      const title = error.status === 422 && error.issues.length ? '配置校验未通过' : error.title || fallback;
      const description = errorMessage(error);
      const hasMore = error.issues.length > 1 || (error.issues.length === 1 && error.detail && error.detail !== error.issues[0].message);
      toast.error(title, {
        description,
        duration: 7000,
        action: hasMore
          ? {
              label: '详情',
              onClick: () => showIssues({ title, detail: error.detail, issues: error.issues }),
            }
          : undefined,
      });
      return;
    }
    toast.error(fallback, { description: errorMessage(error) });
  },
};

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
          <li key={index} className="flex gap-2.5 rounded-lg border border-bad/20 bg-bad-soft px-3 py-2.5">
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

/* ─── confirm ────────────────────────────────────────────────────────── */

interface ConfirmRequest {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: 'danger' | 'default';
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
  const [busy, setBusy] = useState(false);
  const close = (ok: boolean) => {
    request?.resolve(ok);
    confirmStore.set(null);
    setBusy(false);
  };
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => !open && close(false)}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          {request?.tone === 'danger' && <AlertTriangle size={17} className="text-bad" />}
          {request?.title}
        </span>
      }
      description={request?.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {request?.cancelText ?? '取消'}
          </Button>
          <Button
            data-autofocus
            variant={request?.tone === 'danger' ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => {
              setBusy(true);
              close(true);
            }}
          >
            {request?.confirmText ?? '确认'}
          </Button>
        </>
      }
    />
  );
}

/** Mount once inside the app shell. */
export function FeedbackHost() {
  return (
    <>
      <IssuesDialog />
      <ConfirmDialog />
    </>
  );
}
