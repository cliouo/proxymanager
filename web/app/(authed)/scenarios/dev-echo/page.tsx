'use client';

import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ShikiBlock } from '@/components/ui/ShikiBlock';
import { ApiError, api } from '@/lib/client/api';

export default function EchoScenarioPage() {
  const [payload, setPayload] = useState('{\n  "hello": "world"\n}');
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState<string>('');
  const [lastOp, setLastOp] = useState<string | null>(null);

  const call = useCallback(
    async (op: 'ping' | 'mark') => {
      setPending(true);
      setOutput('');
      setLastOp(op);
      try {
        const parsed = payload.trim() ? JSON.parse(payload) : null;
        const res = await api<{ data: unknown; events?: unknown[] }>('/api/v1/ops', {
          method: 'POST',
          body: { scenario: 'dev-echo', op, payload: parsed },
        });
        setOutput(JSON.stringify(res, null, 2));
      } catch (err) {
        setOutput(
          '// ERROR\n' +
            (err instanceof ApiError
              ? `${err.status}: ${err.message}`
              : err instanceof SyntaxError
                ? `JSON 解析失败：${err.message}`
                : String(err)),
        );
      } finally {
        setPending(false);
      }
    },
    [payload],
  );

  return (
    <div className="space-y-6">
      <header>
        <h1
          className="font-serif text-[28px] font-medium leading-[1.15] tracking-[-0.015em] text-[var(--color-ink)]"
          style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
        >
          Echo（调试）
        </h1>
        <p className="mt-1.5 text-[13px] text-[var(--color-muted)] leading-[1.6] max-w-2xl">
          端到端验证 scenario dispatcher。
          <code className="font-mono text-[12px] text-[var(--color-primary)] mx-1">ping</code> 回显 payload，
          <code className="font-mono text-[12px] text-[var(--color-primary)] mx-1">mark</code> 额外写一条审计事件。
        </p>
      </header>

      {/* Terminal input */}
      <section>
        <header className="flex items-baseline justify-between mb-2">
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            <span className="text-[var(--color-primary)]">▸</span> request payload
          </span>
          <span className="text-[11px] font-mono text-[var(--color-muted)]">json</span>
        </header>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full surface-dark bg-[var(--color-surface-dark)] text-[var(--color-on-dark)] font-mono text-[12px] leading-[1.6] rounded-xl px-4 py-3 caret-[var(--color-primary)] focus:outline-none focus:ring-[3px] focus:ring-[var(--color-primary)]/30"
          style={{ tabSize: 2 }}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              const next = payload.slice(0, start) + '  ' + payload.slice(end);
              setPayload(next);
              requestAnimationFrame(() => {
                el.selectionStart = el.selectionEnd = start + 2;
              });
            }
          }}
        />
        <div className="flex items-center gap-2 mt-3">
          <Button onClick={() => call('ping')} disabled={pending}>
            {pending && lastOp === 'ping' ? '…' : 'POST · ping'}
          </Button>
          <Button variant="secondary" onClick={() => call('mark')} disabled={pending}>
            {pending && lastOp === 'mark' ? '…' : 'POST · mark'}
          </Button>
          <span className="ml-auto text-[11px] font-mono text-[var(--color-muted)]">
            scenario: <span className="text-[var(--color-primary)]">dev-echo</span>
          </span>
        </div>
      </section>

      {/* Terminal output */}
      <section>
        <header className="flex items-baseline justify-between mb-2">
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            <span className="text-[var(--color-success)]">◂</span> response
          </span>
          {output && (
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(output)}
              className="text-[11px] font-mono text-[var(--color-muted)] hover:text-[var(--color-primary)] transition-colors"
            >
              复制
            </button>
          )}
        </header>
        {output ? (
          <ShikiBlock code={output} lang="json" />
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg-sunk)]/40 px-6 py-12 text-center text-[12px] font-mono text-[var(--color-muted)]">
            $ waiting for input…
          </div>
        )}
      </section>
    </div>
  );
}
