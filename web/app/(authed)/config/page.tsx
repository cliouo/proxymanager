'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { CodeView } from '@/components/ui/CodeView';
import styles from './config.module.css';

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

type Tab = 'yaml' | 'summary';

export default function ConfigPage() {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<'config' | 'url' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('yaml');
  const [inspOpen, setInspOpen] = useState(false);

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
        setLoadError('尚未设置基础配置，先到「结构骨架」页粘贴 base.yaml 并保存。');
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

  // 实时反映：从规则页 / 结构页改完切回来时自动拉最新渲染结果。
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
  // 渲染产物可能几 MB —— 行数 / 字节数只在内容变化时算一次
  const { lineCount, byteLen } = useMemo(
    () => ({
      lineCount: content ? content.split('\n').length : 0,
      byteLen: new TextEncoder().encode(content).length,
    }),
    [content],
  );
  const anchors = preview?.anchors_applied ?? [];
  const unmatched = preview?.unmatched_anchors ?? [];
  const totalRules = anchors.reduce((sum, a) => sum + a.ruleCount, 0);

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
    <div className={styles.workbench}>
      {/* —— 页头注入共享 topbar(对齐 v2/config.html:标题 / pill / 渲染状态 /
          crumb / 重新渲染 / 下载 / 复制全文 上提,视图条只留 tabs + 检查) —— */}
      <PageTopbar>
        <h1>最终配置</h1>
        <ScopePill />
        {loaded && preview && <span className="pill ok">渲染成功</span>}
        {preview && (
          <span className="crumb num">
            build {preview.build_id.slice(0, 8)} · {lineCount} 行
          </span>
        )}
        <div className="grow" />
        <button className="btn" onClick={refresh} disabled={refreshing}>
          {refreshing ? '渲染中…' : '重新渲染'}
        </button>
        <button className="btn" onClick={download} disabled={!content}>
          下载
        </button>
        <button className="btn primary" onClick={copyConfig} disabled={!content}>
          {copied === 'config' ? '已复制 ✓' : '复制全文'}
        </button>
      </PageTopbar>

      <div className={styles.view}>
        <div className={styles.bar}>
          <div className="tabs">
            <button
              className={`tab${tab === 'yaml' ? ' on' : ''}`}
              onClick={() => setTab('yaml')}
            >
              渲染产物
            </button>
            <button
              className={`tab${tab === 'summary' ? ' on' : ''}`}
              onClick={() => setTab('summary')}
            >
              渲染摘要
            </button>
          </div>
          <div style={{ flex: 1 }} />
          <span className={styles.note}>只读 · 由 base + 资源实时渲染</span>
          <button className={`btn sm ${styles.inspBtn}`} onClick={() => setInspOpen(true)}>
            注入 / 警告
          </button>
        </div>

        {tab === 'yaml' ? (
          <div className={`codebox ${styles.code}`}>
            {!loaded ? (
              <pre className="cm-com">正在渲染最终配置 …</pre>
            ) : loadError ? (
              <pre style={{ color: 'var(--warn)' }}>{loadError}</pre>
            ) : (
              /* CodeMirror 只读视图：虚拟化渲染，几万行也只为可视行建 DOM */
              <CodeView value={content} className={styles.cmFill} />
            )}
          </div>
        ) : (
          <div className={styles.summary}>
            <div className="panel" style={{ maxWidth: 560 }}>
              <div className="panel-body">
                <div className={styles.sumRow}>
                  <span>渲染产物</span>
                  <span className="num">
                    {lineCount} 行 · {byteLen.toLocaleString()} 字节
                  </span>
                </div>
                {preview?.build_id && (
                  <div className={styles.sumRow}>
                    <span>构建标识</span>
                    <span className="num">{preview.build_id}</span>
                  </div>
                )}
                <div className={styles.sumRow}>
                  <span>注入锚点</span>
                  <span className="num">{anchors.length} 个</span>
                </div>
                <div className={styles.sumRow}>
                  <span>注入规则</span>
                  <span className="num">{totalRules} 条</span>
                </div>
                <div className={styles.sumRow}>
                  <span>未匹配锚点</span>
                  <span className="num">{unmatched.length} 个</span>
                </div>
                <div className={styles.sumRow}>
                  <span>基础配置</span>
                  <span className="num">{meta?.hasBase === false ? '未初始化' : '已就绪'}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <aside className={`${styles.inspector}${inspOpen ? ` ${styles.open}` : ''}`}>
        <button className={`btn ghost sm ${styles.inspClose}`} onClick={() => setInspOpen(false)}>
          关闭
        </button>

        <div className={`${styles.inspH} ${styles.first}`}>锚点注入 · {totalRules} 条</div>
        {anchors.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 8px' }}>
            未注入任何规则
          </div>
        ) : (
          anchors.map((a) => (
            <div className={styles.inj} key={a.anchor}>
              <span>{a.anchor}</span>
              <span className={styles.injN}>+{a.ruleCount}</span>
            </div>
          ))
        )}

        <div className={styles.inspH}>警告</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {unmatched.length > 0 ? (
            unmatched.map((a) => (
              <span className="pill warn" key={a}>
                锚点 {a} 无对应标记
              </span>
            ))
          ) : (
            <span className="pill ok">所有锚点均已匹配</span>
          )}
        </div>

        {meta?.subscriptionUrl && (
          <>
            <div className={styles.inspH}>订阅地址</div>
            <div
              style={{
                font: '11.5px var(--font-mono)',
                color: 'var(--fg-2)',
                wordBreak: 'break-all',
                marginBottom: 8,
              }}
            >
              {meta.subscriptionUrl}
            </div>
            <button className="btn sm" style={{ width: '100%' }} onClick={copyUrl}>
              {copied === 'url' ? '已复制 ✓' : '复制订阅 URL'}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
