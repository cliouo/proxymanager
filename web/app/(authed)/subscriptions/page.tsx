'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ApiError, api } from '@/lib/client/api';

interface Subscription {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  ua_override?: string;
  last_synced_at?: number;
  last_traffic?: {
    upload: number;
    download: number;
    total: number;
    expire: number;
  };
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
          Airport URLs aggregated as Clash <code>proxy-providers</code>.
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
                <div className="flex items-center gap-2">
                  <CardTitle>{sub.name}</CardTitle>
                  <Badge tone={sub.enabled ? 'accent' : 'neutral'}>
                    {sub.enabled ? 'enabled' : 'disabled'}
                  </Badge>
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
                  <Button
                    size="sm"
                    onClick={() => onRefresh(sub.id)}
                    disabled={busyId === sub.id || !sub.enabled}
                  >
                    {busyId === sub.id ? '…' : 'Refresh'}
                  </Button>
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
                <div className="flex gap-2 items-start">
                  <span className="w-28 text-[var(--color-muted)] shrink-0">Upstream</span>
                  <code className="flex-1 break-all font-mono">{sub.url}</code>
                </div>
                {sub.ua_override && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">UA override</span>
                    <code className="flex-1 break-all font-mono">{sub.ua_override}</code>
                  </div>
                )}
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
                {traffic && (
                  <div className="flex gap-2 items-start">
                    <span className="w-28 text-[var(--color-muted)] shrink-0">Traffic</span>
                    <span>
                      ↑ {fmtBytes(traffic.upload)} · ↓ {fmtBytes(traffic.download)} /{' '}
                      {fmtBytes(traffic.total)}
                      {traffic.expire > 0 && ` · expires ${new Date(traffic.expire * 1000).toLocaleDateString()}`}
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
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [ua, setUa] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await api('/api/v1/subscriptions', {
        method: 'POST',
        body: {
          name: name.trim(),
          url: url.trim(),
          enabled,
          ua_override: ua.trim() || undefined,
        },
      });
      setName('');
      setUrl('');
      setUa('');
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
        <form onSubmit={onSubmit} className="grid grid-cols-1 md:grid-cols-6 gap-2 items-start">
          <Input
            placeholder="name (slug, e.g. airport-a)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[a-z0-9-]+"
            required
          />
          <Input
            className="md:col-span-3"
            placeholder="https://airport/sub?token=…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
          />
          <Input
            placeholder="UA override (optional)"
            value={ua}
            onChange={(e) => setUa(e.target.value)}
          />
          <Button type="submit" disabled={pending}>
            {pending ? 'Adding…' : 'Add'}
          </Button>
          <label className="md:col-span-6 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          {error && (
            <p className="md:col-span-6 text-xs text-[var(--color-danger)]">{error}</p>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
