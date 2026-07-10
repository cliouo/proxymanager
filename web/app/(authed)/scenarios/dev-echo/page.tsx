'use client';

import { useCallback, useState } from 'react';
import { ShikiBlock } from '@/components/ui/ShikiBlock';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';

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
      <PageTopbar>
        <h1>Echo（调试）</h1>
        <div className="grow" />
      </PageTopbar>

      <p className="text-[13px] text-[var(--color-muted)] leading-[1.6] max-w-2xl">
        端到端验证 scenario dispatcher。
        <code className="font-mono text-[12px] text-[var(--color-primary)] mx-1">ping</code> 回显
        payload，
        <code className="font-mono text-[12px] text-[var(--color-primary)] mx-1">mark</code>{' '}
        额外写一条审计事件。
      </p>

      {/* Terminal input */}
      <section>
        <header className="flex items-baseline justify-between mb-2">
          <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            <span className="text-[var(--color-primary)]">▸</span> request payload
          </span>
          <span className="text-[11px] font-mono text-[var(--color-muted)]">json</span>
        </header>
        {/* P1-11: 主题感知代码底色（--code-bg/--code-fg），取代写死暖褐 surface-dark + 空类 */}
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          rows={6}
          spellCheck={false}
          className="w-full bg-[var(--code-bg)] text-[var(--code-fg)] border border-[var(--color-border)] font-mono text-[12px] leading-[1.6] rounded-lg px-4 py-3 caret-[var(--color-primary)] focus:outline-none focus:border-[var(--color-primary)] focus:ring-[3px] focus:ring-[var(--color-primary)]/20"
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
          {/* P1-11: 旧 ui/Button → v2 .btn 类，与其它 v2 场景页一致 */}
          <button type="button" className="btn primary" onClick={() => call('ping')} disabled={pending}>
            {pending && lastOp === 'ping' ? '…' : 'POST · ping'}
          </button>
          <button type="button" className="btn" onClick={() => call('mark')} disabled={pending}>
            {pending && lastOp === 'mark' ? '…' : 'POST · mark'}
          </button>
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
