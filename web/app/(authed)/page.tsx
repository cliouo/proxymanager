'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Placeholder, Reveal } from '@/components/ui/Reveal';
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
  const [qrOpen, setQrOpen] = useState(false);

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

  async function copy() {
    if (!meta) return;
    await navigator.clipboard.writeText(meta.subscriptionUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-8">
      <header className="flex items-baseline justify-between gap-4">
        <h1
          className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
        >
          总览
        </h1>
        {meta?.buildId && (
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] font-mono">
            build · {meta.buildId.slice(0, 8)}
          </span>
        )}
      </header>

      {error && (
        <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[#F4D8D2]/30 px-4 py-3 text-[13px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px] gap-8 items-start">
        {/* Hero: subscription URL */}
        <section>
          <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-3">
            你的订阅地址
          </h2>
          {meta ? (
            <Reveal when={!!meta}>
              <div className="rounded-2xl bg-[var(--color-surface-dark)] surface-dark px-5 py-5 shadow-[var(--shadow-card)]">
                <code className="block font-mono text-[14px] leading-[1.6] text-[var(--color-on-dark)] break-all">
                  {meta.subscriptionUrl}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Button onClick={copy}>{copied ? '已复制 ✓' : '复制 URL'}</Button>
                <Button variant="secondary" onClick={() => setQrOpen(true)}>
                  显示二维码
                </Button>
                {!meta.hasBase && (
                  <Badge tone="warn" className="ml-1">
                    基础配置尚未初始化
                  </Badge>
                )}
              </div>
              <p className="mt-3 text-[13px] text-[var(--color-muted)] leading-[1.55]">
                把这条 URL 粘贴到 Mihomo / Clash 作为订阅地址即可。
              </p>
            </Reveal>
          ) : (
            <div className="space-y-3">
              <div className="rounded-2xl bg-[var(--color-surface-dark)] surface-dark px-5 py-5 h-[64px] pm-pulse" />
              <Placeholder rows={1} className="max-w-[280px]" />
            </div>
          )}
        </section>

        {/* Side rail: numbers */}
        <aside className="lg:border-l lg:border-[var(--color-border)] lg:pl-6 lg:pt-7 grid grid-cols-2 lg:grid-cols-1 gap-y-4 gap-x-6">
          <StatLine label="锚点" value={counts?.anchors} href="/base" />
          <StatLine label="策略" value={counts?.policies} href="/base" />
          <StatLine label="规则" value={counts?.rules} href="/scenarios/rule-anchor-append" />
          <StatLine label="订阅" value={counts?.subscriptions} href="/subscriptions" />
        </aside>
      </div>

      {/* Quick links footer */}
      <section className="pt-4 border-t border-[var(--color-border)]">
        <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-3">
          快捷入口
        </h2>
        <div className="flex flex-wrap gap-2">
          <QuickLink href="/base" label="编辑基础配置" hint="base.yaml" />
          <QuickLink href="/scenarios/rule-anchor-append" label="编辑规则" hint="rule editor" />
          <QuickLink href="/history" label="操作历史" hint="audit log" />
          <QuickLink href="/docs" label="API 文档" hint="OpenAPI" />
        </div>
      </section>

      {qrOpen && meta && <QrModal url={meta.subscriptionUrl} onClose={() => setQrOpen(false)} />}
    </div>
  );
}

function StatLine({
  label,
  value,
  href,
}: {
  label: string;
  value: number | undefined;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-1 transition-colors active:scale-[0.98]"
    >
      <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] group-hover:text-[var(--color-primary)] transition-colors">
        {label}
      </span>
      <span
        className="font-serif text-[32px] font-medium leading-[1] tracking-[-0.02em] tabular-nums text-[var(--color-ink)]"
        style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
      >
        {value ?? '—'}
      </span>
    </Link>
  );
}

function QuickLink({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <Link
      href={href}
      className="group inline-flex flex-col px-3 py-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-surface-hover)] transition-[border-color,background-color,transform] active:scale-[0.98]"
    >
      <span className="text-[13px] text-[var(--color-fg)] group-hover:text-[var(--color-primary)] transition-colors">
        {label}
      </span>
      <span className="text-[10px] uppercase tracking-[0.08em] font-mono text-[var(--color-muted)]">
        {hint}
      </span>
    </Link>
  );
}

function QrModal({ url, onClose }: { url: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 280,
      color: { dark: '#1F1E1B', light: '#FAF9F5' },
    }).catch(() => undefined);
  }, [url]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-ink)]/30 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-modal)] p-6 max-w-[360px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          className="font-serif text-[20px] font-medium tracking-[-0.01em] text-[var(--color-ink)] mb-3"
          style={{ fontVariationSettings: '"opsz" 48, "SOFT" 50' }}
        >
          扫码导入订阅
        </h3>
        <canvas ref={canvasRef} className="rounded-lg" />
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
}
