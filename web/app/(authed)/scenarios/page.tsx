'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';

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
    <div className="max-w-3xl space-y-8">
      <PageTopbar>
        <h1>扩展中心</h1>
        <div className="grow" />
      </PageTopbar>

      <p className="text-[14px] text-[var(--color-muted)] leading-[1.6]">
        每个扩展聚焦 Clash 配置的一个切片；常用的几个在侧边栏「扩展」组里有独立入口。
      </p>

      {/* P1-11: 弃用写死暖粉底（深色发浑），改用主题感知的 danger-dim 约定 */}
      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-dim)] px-4 py-3 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {items.length === 0 ? (
        <p className="text-[13px] text-[var(--color-muted)]">
          暂无注册的场景。请在{' '}
          <code className="font-mono text-[12px] text-[var(--color-primary)]">
            web/lib/scenarios/
          </code>{' '}
          下添加，并在{' '}
          <code className="font-mono text-[12px] text-[var(--color-primary)]">registry.ts</code>{' '}
          中注册。
        </p>
      ) : (
        <ol className="space-y-0">
          {items.map((s, idx) => {
            const inner = (
              <article className="group grid grid-cols-[3rem_1fr] gap-4 py-6 border-b border-[var(--color-border)] hover:bg-[var(--color-bg-sunk)]/40 -mx-4 px-4 transition-colors active:scale-[0.998]">
                {/* P1-11: 去 font-serif（Fraunces 从未接入，落到 Georgia）+ 去 opsz/SOFT
                    可变字轴，回默认 sans；--color-muted-strong→--muted、--color-ink→--fg */}
                <div className="text-[24px] font-medium tabular-nums leading-none tracking-[-0.015em] text-[var(--muted)] group-hover:text-[var(--color-primary)] transition-colors pt-0.5">
                  {String(idx + 1).padStart(2, '0')}
                </div>
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-4">
                    <h2 className="text-[24px] font-medium tracking-[-0.015em] leading-[1.2] text-[var(--fg)] group-hover:text-[var(--color-primary)] transition-colors">
                      {s.title}
                    </h2>
                    <code className="shrink-0 font-mono text-[11px] text-[var(--color-muted)] tracking-[0.04em]">
                      {s.id}
                    </code>
                  </div>
                  {s.description && (
                    <p className="mt-1.5 text-[13px] text-[var(--color-muted)] leading-[1.6]">
                      {s.description}
                    </p>
                  )}
                  <span className="inline-flex items-center mt-3 text-[12px] text-[var(--color-primary)] opacity-0 group-hover:opacity-100 transition-opacity font-mono">
                    打开 →
                  </span>
                </div>
              </article>
            );
            return s.navHref ? (
              <li key={s.id}>
                <Link href={s.navHref} className="block">
                  {inner}
                </Link>
              </li>
            ) : (
              <li key={s.id}>{inner}</li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
