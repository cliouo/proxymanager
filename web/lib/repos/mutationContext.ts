import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditEvent } from '@/schemas';
export interface MutationPlan {
  mutation?: { script: string; keys: string[]; args: string[] };
  effects: Array<() => Promise<unknown>>;
  events: AuditEvent[];
}
export const mutationPlanning = new AsyncLocalStorage<MutationPlan>();
