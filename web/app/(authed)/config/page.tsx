'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Placeholder } from '@/components/ui/Reveal';
import { YamlEditor } from '@/components/ui/YamlEditor';
import { ApiError, api } from '@/lib/client/api';

interface PreviewData {
  content: string;
  build_id: string;
  anchors_applied: Array<{ anchor: string; ruleCount: number }>;
  unmatched_anchors: string[];
}

interface Meta {
  subscriptionUrl: string;
  buildId: string | null;
  hasBase: boolean;
}

export default function ConfigPage() {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<'config' | 'url' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadError(null);
    try {
      const [previewRes, metaRes] = await Promise.all([
        api<{ data: PreviewData }>('/api/v1/preview/default'),
        api<{ data: Meta }>('/api/v1/meta').catch(() => null),
      ]);
      setPreview(previewRes.data);
      if (metaRes) setMeta(metaRes.data);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPreview(null);
        setLoadError('尚未设置基础配置，先到「结构」页粘贴 base.yaml 并保存。');
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

  // 实时反映：从规则页 / 结构页改完切回来时，自动拉最新渲染结果。
  useEffect(() => {
    function onFocus() {
      load({ silent: true });
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const content = preview?.content ?? '';
  const lineCount = content ? content.split('\n').length : 0;
  const byteLen = new TextEncoder().encode(content).length;

  async function copyConfig() {
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setCopied('config');
    setTimeout(() => setCopied(null), 1500);
  }

  async function copyUrl() {
    if (!meta?.subscriptionUrl) return;
    await navigator.clipboard.writeText(meta.subscriptionUrl);
    setCopied('url');
    setTimeout(() => setCopied(null), 1500);
  }

  function download() {
    if (!content) return;
    const blob = new Blob([content], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'default.yaml';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="-mx-8 -mt-8 -mb-12 flex flex-col h-[calc(100vh-0px)]">
      {/* Toolbar */}
      <header className="shrink-0 flex items-center justify-between gap-4 px-6 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex items-baseline gap-3 min-w-0">
          <h1
            className="font-serif text-[22px] font-medium leading-[1.2] tracking-[-0.015em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 30' }}
          >
            最终配置
          </h1>
          <Badge tone="neutral">只读</Badge>
          {preview?.build_id && (
            <span className="text-[11px] uppercase tracking-[0.08em] font-mono text-[var(--color-muted)]">
              build · {preview.build_id}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--color-muted)] font-mono tabular-nums hidden md:inline">
            {lineCount} 行 · {byteLen.toLocaleString()} 字节
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
            className="ml-2"
          >
            {refreshing ? '刷新中…' : '刷新'}
          </Button>
          <Button variant="secondary" size="sm" onClick={download} disabled={!content}>
            下载
          </Button>
          <Button size="sm" onClick={copyConfig} disabled={!content}>
            {copied === 'config' ? '已复制 ✓' : '复制全文'}
          </Button>
        </div>
      </header>

      {/* Notice strip */}
      <div className="shrink-0 px-6 py-2 text-[12px] border-b border-[var(--color-border)] bg-[var(--color-primary-tint)] text-[var(--color-primary-hover)]">
        这是下发给 Mihomo / Clash 的完整渲染结果（骨架 + 全部规则）。所见即所得，要改请到「结构」或「规则」页，保存后这里实时刷新。
      </div>

      {loadError && (
        <div className="shrink-0 px-6 py-2 text-[12px] border-b border-[var(--color-border)] bg-[#F4D8D2]/40 text-[var(--color-danger)]">
          {loadError}
        </div>
      )}

      {/* Rendered config + inspector */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[1fr_280px]">
        {loaded ? (
          <>
            <div className="pm-reveal min-h-0 border-r border-[var(--color-border)]">
              <YamlEditor value={content} onChange={() => {}} readOnly />
            </div>
            <div className="pm-reveal min-h-0 hidden xl:flex">
              <Inspector
                preview={preview}
                meta={meta}
                onCopyUrl={copyUrl}
                urlCopied={copied === 'url'}
              />
            </div>
          </>
        ) : (
          <>
            <div className="border-r border-[var(--color-border)] p-6 space-y-3">
              <Placeholder rows={1} className="max-w-[180px]" />
              <Placeholder rows={6} />
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
  preview,
  meta,
  onCopyUrl,
  urlCopied,
}: {
  preview: PreviewData | null;
  meta: Meta | null;
  onCopyUrl: () => void;
  urlCopied: boolean;
}) {
  const anchors = preview?.anchors_applied ?? [];
  const unmatched = preview?.unmatched_anchors ?? [];
  const totalRules = anchors.reduce((sum, a) => sum + a.ruleCount, 0);

  return (
    <aside className="flex flex-col flex-1 overflow-y-auto bg-[var(--color-bg)] text-[13px]">
      <section className="px-5 py-4 border-b border-[var(--color-border)]">
        <header className="flex items-baseline justify-between gap-2 mb-2">
          <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            锚点注入
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--color-muted)] font-mono">
            {totalRules} 条规则
          </span>
        </header>
        {anchors.length === 0 ? (
          <p className="text-[12px] text-[var(--color-muted)] italic">未注入任何规则</p>
        ) : (
          <ul className="space-y-1">
            {anchors.map((a) => (
              <li
                key={a.anchor}
                className="flex items-baseline justify-between gap-2 font-mono text-[12px]"
              >
                <span className="text-[var(--color-fg)] truncate" title={a.anchor}>
                  <span className="text-[var(--color-primary)] mr-1">∎</span>
                  {a.anchor}
                </span>
                <span className="tabular-nums text-[var(--color-muted)]">{a.ruleCount}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {unmatched.length > 0 && (
        <section className="px-5 py-4 border-b border-[var(--color-border)] bg-[#F4D8D2]/20">
          <header className="flex items-baseline justify-between gap-2 mb-2">
            <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-danger)]">
              未匹配锚点
            </h2>
            <span className="text-[11px] tabular-nums text-[var(--color-danger)] font-mono">
              {unmatched.length}
            </span>
          </header>
          <p className="text-[11px] text-[var(--color-muted)] mb-2 leading-[1.5]">
            这些锚点下有规则，但骨架里没有对应标记，规则未被注入。
          </p>
          <ul className="space-y-1 text-[11px] font-mono">
            {unmatched.map((a) => (
              <li key={a} className="text-[var(--color-danger)] break-all">
                {a}
              </li>
            ))}
          </ul>
        </section>
      )}

      {meta?.subscriptionUrl && (
        <section className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
            订阅地址
          </h2>
          <code className="block font-mono text-[11px] leading-[1.5] text-[var(--color-fg-soft)] break-all mb-2">
            {meta.subscriptionUrl}
          </code>
          <Button variant="secondary" size="sm" onClick={onCopyUrl} className="w-full">
            {urlCopied ? '已复制 ✓' : '复制订阅 URL'}
          </Button>
          {meta.hasBase === false && (
            <Badge tone="warn" className="mt-2">
              基础配置尚未初始化
            </Badge>
          )}
        </section>
      )}

      <section className="px-5 py-4 mt-auto">
        <h2 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-2">
          说明
        </h2>
        <p className="text-[12px] text-[var(--color-muted)] leading-[1.55]">
          节点密码、订阅 token 等敏感字段在此页原样下发（仅你可见）。AI 助手读取时会脱敏。
        </p>
      </section>
    </aside>
  );
}
