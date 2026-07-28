import { api } from '@/lib/client/api';
import {
  SetupBootstrapRequestSchema,
  SetupBootstrapResponseSchema,
  SetupStatusSchema,
  type SetupApiStatus,
  type SetupBootstrapApiResponse,
  type SetupBootstrapRequest,
} from '@/schemas/setup';

export const SETUP_DRAFT_KEY = 'pm.setup.draft.v1';

export type SetupDraftStep = 'welcome' | 'review';

export interface SetupDraft {
  step: SetupDraftStep;
  revision: number;
  starter_version: SetupApiStatus['starter_version'];
}

export interface RestoredSetupDraft {
  step: SetupDraftStep;
}

export const STARTER_SUMMARY = {
  profileName: 'default',
  mode: 'rule',
  allowLan: false,
  logLevel: 'info',
  autoGroup: {
    name: '自动选择',
    type: 'url-test',
    fallback: 'DIRECT',
    interval: 600,
  },
  defaultGroup: {
    name: '默认',
    type: 'select',
    members: ['自动选择', 'DIRECT'] as const,
  },
  finalRule: 'MATCH,默认',
  disabledByDefault: ['DNS', 'TUN', 'sniffer', 'rule-set'] as const,
} as const;

export function setupNeedsAttention(status: SetupApiStatus): boolean {
  return status.state !== 'configured';
}

export function setupCanRun(status: SetupApiStatus): boolean {
  return status.can_bootstrap && (status.state === 'empty' || status.state === 'recoverable');
}

export function setupNeedsRepair(status: SetupApiStatus): boolean {
  return status.state === 'recoverable' && status.can_bootstrap;
}

export function encodeSetupDraft(step: SetupDraftStep, status: SetupApiStatus): string {
  const draft: SetupDraft = {
    step,
    revision: status.revision,
    starter_version: status.starter_version,
  };
  return JSON.stringify(draft);
}

export function restoreSetupDraft(raw: string | null, status: SetupApiStatus): RestoredSetupDraft {
  const fallback = { step: 'welcome' as const };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<SetupDraft>;
    if (
      (value.step === 'welcome' || value.step === 'review') &&
      value.revision === status.revision &&
      value.starter_version === status.starter_version
    ) {
      return { step: value.step };
    }
  } catch {
    // A malformed or stale draft is disposable. Server setup status stays authoritative.
  }
  return fallback;
}

export async function fetchSetupStatus(): Promise<SetupApiStatus> {
  const response = await api<{ data: SetupApiStatus }>('/api/v1/setup/status', {
    cache: 'no-store',
  });
  return SetupStatusSchema.parse(response.data);
}

export async function runSetupBootstrap(
  request: SetupBootstrapRequest,
): Promise<SetupBootstrapApiResponse> {
  const body = SetupBootstrapRequestSchema.parse(request);
  const response = await api<{ data: SetupBootstrapApiResponse }>('/api/v1/setup/bootstrap', {
    method: 'POST',
    body,
  });
  return SetupBootstrapResponseSchema.parse(response.data);
}
