'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
import { ApiError, api } from '@/lib/client/api';

interface Meta {
  subscriptionUrl: string;
  subProvidersBase: string;
  buildId: string | null;
  hasBase: boolean;
}

interface Counts {
  anchors: number;
  policies: number;
  rules: number;
  subscriptions: number;
}

export default function DashboardPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [metaRes, anchors, policies, rules, subs] = await Promise.all([
          api<{ data: Meta }>('/api/v1/meta'),
          api<{ data: string[] }>('/api/v1/anchors').catch(() => ({ data: [] as string[] })),
          api<{ data: string[] }>('/api/v1/policies').catch(() => ({ data: [] as string[] })),
          api<{ meta: { total: number } }>('/api/v1/rules?limit=1'),
          api<{ meta: { total: number } }>('/api/v1/subscriptions'),
        ]);
        if (cancelled) return;
        setMeta(metaRes.data);
        setCounts({
          anchors: anchors.data.length,
          policies: policies.data.length,
          rules: rules.meta.total,
          subscriptions: subs.meta.total,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-[var(--color-muted)]">Overview of your ProxyManager config.</p>
      </div>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Subscription URL</CardTitle>
          {meta?.buildId && <Badge tone="accent">build {meta.buildId.slice(0, 8)}</Badge>}
        </CardHeader>
        <CardBody className="space-y-3">
          {meta ? (
            <>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-md bg-[var(--color-surface-2)] px-3 py-2 text-xs font-mono">
                  {meta.subscriptionUrl}
                </code>
                <Button size="sm" variant="secondary" onClick={() => copy(meta.subscriptionUrl)}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="text-xs text-[var(--color-muted)]">
                Paste this into Mihomo / Clash as the subscription URL.
              </p>
              {!meta.hasBase && (
                <Badge tone="warn">Base config not initialised — set one in &quot;Base config&quot;.</Badge>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">Loading…</p>
          )}
        </CardBody>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Anchors" value={counts?.anchors} />
        <Stat label="Policies" value={counts?.policies} />
        <Stat label="Rules" value={counts?.rules} />
        <Stat label="Subscriptions" value={counts?.subscriptions} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs text-[var(--color-muted)]">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value ?? '—'}</div>
      </CardBody>
    </Card>
  );
}
