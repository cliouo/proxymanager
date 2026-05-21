'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { ApiError, api } from '@/lib/client/api';

interface ScenarioDescriptor {
  id: string;
  title: string;
  description?: string;
  navHref?: string;
}

export default function ScenariosIndexPage() {
  const [items, setItems] = useState<ScenarioDescriptor[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: ScenarioDescriptor[] }>('/api/v1/scenarios')
      .then((r) => setItems(r.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Scenarios</h1>
        <p className="text-sm text-[var(--color-muted)]">
          Each scenario is a focused editor for one slice of your Clash config.
          New scenarios show up here automatically.
        </p>
      </div>
      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-sm text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}
      {items.length === 0 ? (
        <Card>
          <CardBody className="text-sm text-[var(--color-muted)]">
            No scenarios registered. Add one under{' '}
            <code className="font-mono">web/lib/scenarios/</code> and reference
            it in <code className="font-mono">registry.ts</code>.
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map((s) => {
            const inner = (
              <Card className="hover:border-[var(--color-accent)]/40 transition-colors h-full">
                <CardBody className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold">{s.title}</h2>
                    <code className="font-mono text-[10px] text-[var(--color-muted)]">
                      {s.id}
                    </code>
                  </div>
                  {s.description && (
                    <p className="text-xs text-[var(--color-muted)]">{s.description}</p>
                  )}
                </CardBody>
              </Card>
            );
            return s.navHref ? (
              <Link key={s.id} href={s.navHref} className="block">
                {inner}
              </Link>
            ) : (
              <div key={s.id}>{inner}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
