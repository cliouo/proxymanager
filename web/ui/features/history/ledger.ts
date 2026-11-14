import { request } from '@/ui/data/api';
import type { HistoryPage } from '@/ui/data/types';

/** First page of the audit ledger; older pages are appended by cursor in the view. */
export const LEDGER_PAGE = 50;
export const LEDGER_KEY = 'history:ledger';
export const fetchLedgerHead = (limit = LEDGER_PAGE) => request<HistoryPage>('/history', { query: { limit } });
