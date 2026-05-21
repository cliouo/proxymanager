'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input, Select, Textarea } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface Subscription {
  id: string;
  name: string;
  kind: 'remote' | 'local';
  enabled: boolean;
  url?: string;
  ua_override?: string;
  custom_headers?: Record<string, string>;
  ttl_ms: number;
  content?: string;
  tags: string[];
  last_synced_at?: number;
  last_traffic?: {
    upload: number;
    download: number;
    total: number;
    expire: number;
  };
  last_error?: string;
}

interface Meta {
  subProvidersBase: string;
}

function fmtBytes(n: number): string {
  if (!n) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

function fmtTime(s: number | undefined): string {
  if (!s) return '—';
  return new Date(s * 1000).toLocaleString();
}

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [list, m] = await Promise.all([
        api<{ data: Subscription[] }>('/api/v1/subscriptions'),
        api<{ data: Meta }>('/api/v1/meta'),
      ]);
      setSubs(list.data);
      setMeta(m.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onRefresh(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/v1/subscriptions/${id}/refresh`, { method: 'POST' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Delete this subscription?')) return;
    setBusyId(id);
    try {
      await api(`/api/v1/subscriptions/${id}`, { method: 'DELETE' });
      setSubs((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function onToggle(sub: Subscription) {
    setBusyId(sub.id);
    try {
      const res = await api<{ data: Subscription }>(`/api/v1/subscriptions/${sub.id}`, {
        method: 'PATCH',
        body: { enabled: !sub.enabled },
      });
      setSubs((prev) => prev.map((s) => (s.id === sub.id ? res.data : s)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Subscriptions</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Per-airport sources. Remote URLs are fetched + cached (default 10 min TTL);
          local subscriptions store inline YAML. Aggregate them via{' '}
          <a href="/collections" className="text-[var(--color-accent)]">
            Collections
          </a>
          .
        </p>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <AddForm onAdded={reload} />

      <div className="space-y-3">
        {subs.map((sub) => {
          const providerUrl = meta ? `${meta.subProvidersBase}/${sub.name}` : '';
          const traffic = sub.last_traffic;
          return (
            <Card key={sub.id}>
              <CardHeader>
                <div className="flex items-center gap-2 min-w-0">
                  <CardTitle>{sub.name}</CardTitle>
                  <Badge tone={sub.enabled ? 'accent' : 'neutral'}>
                    {sub.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                  <Badge tone="neutral">{sub.kind}</Badge>
                  {sub.last_error && <Badge tone="danger">error</Badge>}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onToggle(sub)}
                    disabled={busyId === sub.id}
                  >
                    {sub.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  {sub.kind === 'remote' && (
                    <Button
                      size="sm"
                      onClick={() => onRefresh(sub.id)}
                      disabled={busyId === sub.id || !sub.enabled}
                    >
                      {busyId === sub.id ? '…' : 'Refresh'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onDelete(sub.id)}
                    disabled={busyId === sub.id}
                  >
                    Delete
                  </Button>
                </div>
              </CardHeader>
              <CardBody className="space-y-2 text-xs">
                {sub.kind === 'remote' && sub.url && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">Upstream</span>
                    <code className="flex-1 break-all font-mono">{sub.url}</code>
                  </div>
                )}
                {sub.kind === 'local' && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">Inline</span>
                    <code className="flex-1 font-mono text-[var(--color-muted)]">
                      {(sub.content?.length ?? 0).toLocaleString()} bytes
                    </code>
                  </div>
                )}
                {sub.tags.length > 0 && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">Tags</span>
                    <div className="flex flex-wrap gap-1">
                      {sub.tags.map((t) => (
                        <Badge key={t} tone="neutral">
                          {t}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {sub.ua_override && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">UA override</span>
                    <code className="flex-1 break-all font-mono">{sub.ua_override}</code>
                  </div>
                )}
                <div className="flex gap-2 items-start">
                  <span className="w-28 text-[var(--color-muted)] shrink-0">TTL</span>
                  <span>{Math.round(sub.ttl_ms / 1000)}s</span>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="w-28 text-[var(--color-muted)] shrink-0">Provider URL</span>
                  <code className="flex-1 break-all font-mono text-[var(--color-accent)]">
                    {providerUrl}
                  </code>
                </div>
                <div className="flex gap-2 items-start">
                  <span className="w-28 text-[var(--color-muted)] shrink-0">Last synced</span>
                  <span>{fmtTime(sub.last_synced_at)}</span>
                </div>
                {sub.last_error && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">Last error</span>
                    <span className="flex-1 break-words text-[var(--color-danger)]">
                      {sub.last_error}
                    </span>
                  </div>
                )}
                {traffic && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">Traffic</span>
                    <span>
                      ↑ {fmtBytes(traffic.upload)} · ↓ {fmtBytes(traffic.download)} /{' '}
                      {fmtBytes(traffic.total)}
                      {traffic.expire > 0 &&
                        ` · expires ${new Date(traffic.expire * 1000).toLocaleDateString()}`}
                    </span>
                  </div>
                )}
              </CardBody>
            </Card>
          );
        })}
        {subs.length === 0 && (
          <Card>
            <CardBody className="text-sm text-[var(--color-muted)] text-center py-8">
              No subscriptions yet. Add one above.
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function AddForm({ onAdded }: { onAdded: () => void }) {
  const [kind, setKind] = useState<'remote' | 'local'>('remote');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [ua, setUa] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [ttlSec, setTtlSec] = useState(Math.round(DEFAULT_TTL_MS / 1000));
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        enabled,
        ttl_ms: Math.max(1000, ttlSec * 1000),
        tags,
      };
      if (kind === 'remote') {
        body.url = url.trim();
        if (ua.trim()) body.ua_override = ua.trim();
      } else {
        body.content = content;
      }
      await api('/api/v1/subscriptions', { method: 'POST', body });
      setName('');
      setUrl('');
      setContent('');
      setUa('');
      setTagsInput('');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add subscription</CardTitle>
      </CardHeader>
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">Kind</label>
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'remote' | 'local')}>
                <option value="remote">remote (URL)</option>
                <option value="local">local (inline YAML)</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">Name (slug)</label>
              <Input
                placeholder="airport-a"
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-z0-9-]+"
                required
              />
            </div>
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">
                Fetch TTL (sec)
              </label>
              <Input
                type="number"
                min={1}
                value={ttlSec}
                onChange={(e) => setTtlSec(Math.max(1, Number(e.target.value) || 0))}
                disabled={kind === 'local'}
              />
            </div>
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">
                Tags (comma-separated)
              </label>
              <Input
                placeholder="optional, e.g. premium, asia"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
              />
            </div>
          </div>

          {kind === 'remote' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-[var(--color-muted)] mb-1 block">URL</label>
                <Input
                  placeholder="https://airport/sub?token=…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  type="url"
                  required
                />
              </div>
              <div>
                <label className="text-xs text-[var(--color-muted)] mb-1 block">UA override</label>
                <Input
                  placeholder="optional, e.g. clash.meta/1.18.0"
                  value={ua}
                  onChange={(e) => setUa(e.target.value)}
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="text-xs text-[var(--color-muted)] mb-1 block">
                Content (Clash provider YAML — needs a top-level `proxies:` array)
              </label>
              <Textarea
                rows={8}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={'proxies:\n  - name: my-node\n    type: ss\n    ...'}
                required
              />
            </div>
          )}

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enabled
            </label>
            <Button type="submit" disabled={pending || !name}>
              {pending ? 'Adding…' : 'Add'}
            </Button>
          </div>

          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </form>
      </CardBody>
    </Card>
  );
}
