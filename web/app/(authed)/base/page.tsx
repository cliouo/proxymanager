'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Kbd } from '@/components/ui/Kbd';
import { Placeholder } from '@/components/ui/Reveal';
import { YamlEditor, type YamlEditorHandle } from '@/components/ui/YamlEditor';
import { ApiError, api } from '@/lib/client/api';

interface BaseData {
  content: string;
  anchors: string[];
  policies: string[];
  etag: string;
  updated_at: number;
}

interface ValidationResult {
  valid: boolean;
  anchors: string[];
  policies: string[];
  orphans: Array<{ rule_id: string; reason: string }>;
}

export default function BasePage() {
  const [data, setData] = useState<BaseData | null>(null);
  const [content, setContent] = useState('');
  const [etag, setEtag] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: 'info' | 'success' | 'error'; message: string } | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | null>(null);
  const [loaded, setLoaded] = useState(false);
  const editorRef = useRef<YamlEditorHandle>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api<{ data: BaseData }>('/api/v1/base');
      setData(res.data);
      setContent(res.data.content);
      setEtag(res.data.etag);
      setValidation(null);
      setStatus(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setData(null);
        setContent('');
        setEtag(null);
        setStatus({ kind: 'info', message: '尚未设置基础配置，请粘贴 base.yaml 内容后保存。' });
      } else {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty = data ? content !== data.content : content.length > 0;
  const lineCount = content ? content.split('\n').length : 0;
  const byteLen = new TextEncoder().encode(content).length;

  const onValidate = useCallback(async () => {
    setBusy('validate');
    setStatus(null);
    try {
      const res = await api<{ data: ValidationResult }>('/api/v1/base/validate', {
        method: 'POST',
        body: { content },
      });
      setValidation(res.data);
      setStatus(
        res.data.valid
          ? { kind: 'success', message: '校验通过' }
          : { kind: 'error', message: `校验未通过 — ${res.data.orphans.length} 条孤立规则` },
      );
    } catch (err) {
      const detail = err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setStatus({ kind: 'error', message: detail });
      if (err instanceof ApiError && Array.isArray(err.problem.errors)) {
        setValidation({
          valid: false,
          anchors: [],
          policies: [],
          orphans: err.problem.errors as ValidationResult['orphans'],
        });
      }
    } finally {
      setBusy(null);
    }
  }, [content]);

  const onSave = useCallback(async () => {
    setBusy('save');
    setStatus(null);
    try {
      const headers: Record<string, string> = {};
      if (etag) headers['If-Match'] = `"${etag}"`;
      await api('/api/v1/base', {
        method: 'PUT',
        body: { content },
        headers,
      });
      setStatus({ kind: 'success', message: '已保存' });
      await load();
    } catch (err) {
      const detail = err instanceof ApiError ? err.problem.detail ?? err.message : String(err);
      setStatus({ kind: 'error', message: detail });
      if (err instanceof ApiError && Array.isArray(err.problem.errors)) {
        setValidation({
          valid: false,
          anchors: [],
          policies: [],
          orphans: err.problem.errors as ValidationResult['orphans'],
        });
      }
    } finally {
      setBusy(null);
    }
  }, [content, etag, load]);

  return (
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-[calc(100vh-0px)]">
      {/* Toolbar */}
      <header className="shrink-0 flex items-center justify-between gap-4 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1
            className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            结构
          </h1>
          {etag && (
            <span className="text-[11px] uppercase tracking-[0.08em] font-mono text-[var(--color-muted)]">
              etag · {etag.slice(0, 8)}
            </span>
          )}
          {dirty && (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-[var(--color-warn)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warn)]" />
              未保存
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-muted)] font-mono tabular-nums hidden md:inline">
            {lineCount} 行 · {byteLen.toLocaleString()} 字节
          </span>
          <span className="hidden lg:inline-flex items-center gap-1 text-[11px] text-[var(--color-muted)] ml-2">
            <Kbd>⌘</Kbd>
            <Kbd>S</Kbd>
            <span>保存</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={onValidate}
            disabled={busy !== null}
            className="ml-2"
          >
            {busy === 'validate' ? '校验中…' : '校验'}
          </Button>
          <Button size="sm" onClick={onSave} disabled={busy !== null || !dirty}>
            {busy === 'save' ? '保存中…' : '保存'}
          </Button>
        </div>
      </header>

      {/* Role hint */}
      <div className="shrink-0 px-6 py-2 text-[12px] border-b border-[var(--color-border)] bg-[var(--color-primary-tint)] text-[var(--color-primary-hover)]">
        这里只编辑骨架（dns / 策略组 / 嗅探 / tun / 订阅源 / 规则集声明 等）。<code className="font-mono">rules:</code> 块只放锚点标记 —— 规则统一到「规则」页管理；保存时出现规则行会被拒绝。
      </div>

      {/* Status strip */}
      {(loadError || status) && (
        <div
          className={`shrink-0 px-6 py-2 text-[12px] border-b border-[var(--color-border)] ${
            (loadError || status?.kind === 'error')
              ? 'bg-[#F4D8D2]/40 text-[var(--color-danger)]'
              : status?.kind === 'success'
                ? 'bg-[#E6EEDD]/40 text-[var(--color-success)]'
                : 'bg-[var(--color-primary-tint)] text-[var(--color-primary-hover)]'
          }`}
        >
          {loadError ?? status?.message}
        </div>
      )}

      {/* Editor + inspector */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[1fr_280px]">
        {loaded ? (
          <>
            <div className="pm-reveal min-h-0 border-r border-[var(--color-border)]">
              <YamlEditor
                ref={editorRef}
                value={content}
                onChange={setContent}
                onSave={onSave}
              />
            </div>
            <div className="pm-reveal min-h-0 hidden xl:flex">
              <Inspector data={data} validation={validation} />
            </div>
          </>
        ) : (
          <>
            <div className="border-r border-[var(--color-border)] p-6 space-y-3">
              <Placeholder rows={1} className="max-w-[180px]" />
              <Placeholder rows={5} />
              <Placeholder rows={4} />
              <Placeholder rows={3} />
            </div>
            <div className="hidden xl:block bg-[var(--color-bg)] p-5 space-y-4">
              <Placeholder rows={1} className="max-w-[60px]" />
              <Placeholder rows={3} />
              <Placeholder rows={1} className="max-w-[60px]" />
              <Placeholder rows={4} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Inspector({
  data,
  validation,
}: {
  data: BaseData | null;
  validation: ValidationResult | null;
}) {
  const anchors = validation?.anchors.length ? validation.anchors : data?.anchors ?? [];
  const policies = validation?.policies.length ? validation.policies : data?.policies ?? [];
  const orphans = validation?.orphans ?? [];

  return (
    <aside className="flex flex-col flex-1 overflow-y-auto bg-[var(--color-bg)] text-[13px]">
      <section className="px-5 py-4 border-b border-[var(--color-border)]">
        <header className="flex items-baseline justify-between gap-2 mb-2">
          <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            锚点
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--color-muted)] font-mono">
            {anchors.length}
          </span>
        </header>
        {anchors.length === 0 ? (
          <p className="text-[12px] text-[var(--color-muted)] italic">未发现锚点</p>
        ) : (
          <ul className="space-y-1">
            {anchors.map((a) => (
              <li
                key={a}
                className="font-mono text-[12px] text-[var(--color-fg)] truncate"
                title={a}
              >
                <span className="text-[var(--color-primary)] mr-1">∎</span>
                {a}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="px-5 py-4 border-b border-[var(--color-border)]">
        <header className="flex items-baseline justify-between gap-2 mb-2">
          <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            策略
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--color-muted)] font-mono">
            {policies.length}
          </span>
        </header>
        {policies.length === 0 ? (
          <p className="text-[12px] text-[var(--color-muted)] italic">未发现策略</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {policies.slice(0, 30).map((p) => (
              <span
                key={p}
                className="inline-flex items-center px-1.5 h-5 rounded bg-[var(--color-bg-strong)] text-[var(--color-fg-soft)] font-mono text-[11px]"
              >
                {p}
              </span>
            ))}
            {policies.length > 30 && (
              <span className="text-[11px] text-[var(--color-muted)]">+{policies.length - 30}</span>
            )}
          </div>
        )}
      </section>

      {orphans.length > 0 && (
        <section className="px-5 py-4 border-b border-[var(--color-border)] bg-[#F4D8D2]/20">
          <header className="flex items-baseline justify-between gap-2 mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-danger)]">
              孤立规则
            </h2>
            <span className="text-[11px] tabular-nums text-[var(--color-danger)] font-mono">
              {orphans.length}
            </span>
          </header>
          <ul className="space-y-1 text-[11px] font-mono">
            {orphans.map((o, i) => (
              <li key={i} className="text-[var(--color-danger)] break-all">
                <code>{o.rule_id}</code>: {o.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="px-5 py-4 mt-auto">
        <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
          编辑器
        </h2>
        <dl className="space-y-1.5 text-[12px]">
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--color-muted)]">Tab</dt>
            <dd className="font-mono text-[var(--color-fg-soft)]">2 空格</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--color-muted)]">缩进</dt>
            <dd className="font-mono text-[var(--color-fg-soft)]">自动</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-[var(--color-muted)]">搜索</dt>
            <dd>
              <Kbd>⌘</Kbd>
              <Kbd className="ml-0.5">F</Kbd>
            </dd>
          </div>
        </dl>
      </section>
    </aside>
  );
}

