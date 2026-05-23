export type DedupBy = 'name' | 'server-port' | 'none';

export interface Collection {
  id: string;
  name: string;
  subscription_ids: string[];
  subscription_tags: string[];
  dedup_by: DedupBy;
  name_prefix?: string;
  notes?: string;
  updated_at?: number;
}

export function dedupLabel(d: DedupBy): string {
  if (d === 'name') return '按名称去重';
  if (d === 'server-port') return '按 server:port 去重';
  return '不去重';
}
