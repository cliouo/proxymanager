'use client';

import { useModalSurface } from '@/lib/client/useModalSurface';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { copyText } from '@/lib/client/clipboard';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { useProfiles } from '@/components/profile/ProfileContext';
import { CodeView } from '@/components/ui/CodeView';
import { TEMPLATE_NOT_DISTRIBUTABLE, isTemplateProfile } from '@/lib/profiles/kind';
import styles from './config.module.css';

interface PreviewData {
  content: string;
  build_id: string;
  anchors_applied: Array<{ anchor: string; ruleCount: number }>;
  unmatched_anchors: string[];
}

interface Meta {
  subscriptionUrl: string;
  subBase: string;
  buildId: string | null;
  hasBase: boolean;
}

type Tab = 'yaml' | 'summary';

export default function ConfigPage() {
  const { activeProfile } = useProfiles();
  const activeName = activeProfile?.name ?? 'default';
  const isTemplate = isTemplateProfile(activeProfile);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState<'config' | 'url' | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>('yaml');
  const [inspOpen, setInspOpen] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  useModalSurface(modalRef, inspOpen, () => setInspOpen(false), '(max-width: 900px)');
  const [urlRevealed, setUrlRevealed] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++generation.current;
      setRefreshing(true);
      if (!opts?.silent) setLoadError(null);
      try {
        const [previewRes, metaRes] = await Promise.all([
          api<{ data: PreviewData }>(`/api/v1/preview/${encodeURIComponent(activeName)}`),
          api<{ data: Meta }>('/api/v1/meta').catch(() => null),
        ]);
        if (seq !== generation.current) return;
        setPreview(previewRes.data);
        setGeneratedAt(new Date().toLocaleString());
        setMeta(metaRes?.data ?? null);
        setLoadError(null);
      } catch (err) {
        if (seq !== generation.current) return;
        if (err instanceof ApiError && err.status === 404) {
          setLoadError('尚未设置基础配置。先填写端口、DNS 等基础内容，才能生成完整配置。');
        } else {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (seq === generation.current) { setLoaded(true); setRefreshing(false); }
      }
    },
    [activeName],
  );

  useEffect(() => {
    setPreview(null); setMeta(null); setLoaded(false); setGeneratedAt(null);
    void load();
    const activeGeneration = generation;
    return () => { activeGeneration.current++; };
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
    await load();
  }, [load]);

  const content = preview?.content ?? '';
  const ready = loaded && !refreshing && !loadError && !!content;
  const stale = !!preview && (!!loadError || refreshing);
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
  // Subscription URL for the ACTIVE profile. meta.subscriptionUrl now follows
  // the active profile too, but derive from subBase + activeName so it stays
  // correct even before meta finishes loading.
  const subUrl = meta?.subBase
    ? `${meta.subBase}/${encodeURIComponent(activeName)}`
    : (meta?.subscriptionUrl ?? '');
  const shownSubUrl = urlRevealed ? subUrl : subUrl.replace(/(\/api\/sub\/)[^/]+/, '$1••••••••');
  const needsBase = loadError?.startsWith('尚未设置基础配置') ?? false;

  async function copyConfig() {
    if (!ready) return;
    // P3-31: don't flash "已复制" when the clipboard write actually failed.
    if (!(await copyText(content))) { setCopyError('无法复制，请下载 YAML 或手动选择内容复制。'); return; }
    setCopyError(null);
    setCopied('config');
    setTimeout(() => setCopied(null), 1500);
  }

  async function copyUrl() {
    if (!ready || isTemplate || !subUrl) return;
    if (!(await copyText(subUrl))) { setCopyError('无法复制订阅地址，请重试。'); return; }
    setCopyError(null);
    setCopied('url');
    setTimeout(() => setCopied(null), 1500);
  }

  function download(lastSuccessful = false) {
    if (!content || (!lastSuccessful && !ready)) return;
    const blob = new Blob([content], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeName}${lastSuccessful ? `-last-success-${preview?.build_id.slice(0, 8)}` : ''}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={styles.workbench}>
      <PageTopbar>
        <h1>配置预览</h1>
        <ScopePill />
        {isTemplate && <span className="pill acc plain">{TEMPLATE_NOT_DISTRIBUTABLE}</span>}
        <div className="grow" />
      </PageTopbar>

      <div className={styles.view}>
        <section className={styles.readiness} aria-live="polite">
          <div
            className={`${styles.readinessIcon}${
              loadError ? ` ${styles.isWarning}` : loaded ? ` ${styles.isReady}` : ''
            }`}
          >
            {!loaded ? '…' : loadError ? '!' : '✓'}
          </div>
          <div className={styles.readinessCopy}>
            <h2>
              {refreshing
                ? '正在生成配置'
                : loadError
                  ? preview ? '上次成功版本，最新检查失败' : '配置暂不可用'
                  : isTemplate
                    ? '模版预览已就绪'
                    : '配置已就绪'}
            </h2>
            <p>
              {!loaded
                ? '正在组合基础配置、节点与分流规则。'
                : loadError
                  ? loadError
                  : isTemplate
                    ? `已生成 ${lineCount.toLocaleString()} 行 YAML，可检查和下载，但模版不生成订阅地址。`
                    : `已生成 ${lineCount.toLocaleString()} 行 YAML，包含 ${totalRules.toLocaleString()} 条注入规则。`}
            </p>
          </div>
          {preview && (
            <div className={styles.readinessMeta}>
              <span className="num">build {preview.build_id.slice(0, 8)}</span>
              <span>{byteLen.toLocaleString()} 字节</span>
            </div>
          )}
          <div className={styles.actions}>
            <button
              className="btn ghost"
              onClick={refresh}
              disabled={refreshing}
              aria-busy={refreshing || undefined}
            >
              {refreshing ? '检查中…' : '重新检查'}
            </button>
            <button className="btn" onClick={() => download()} disabled={!ready}>
              下载 YAML
            </button>
            {!isTemplate && (
              <button className="btn primary" onClick={copyUrl} disabled={!ready || !subUrl}>
                {copied === 'url' ? '地址已复制' : '复制订阅地址'}
              </button>
            )}
          </div>
        </section>

        {stale && <div role="status" className="panel" style={{ padding: 12 }}>
          当前显示上次成功版本 · {activeName} · {generatedAt} · build {preview?.build_id.slice(0, 8)}
          <button className="btn sm" onClick={() => download(true)}>导出上次成功版本</button>
        </div>}
        {copyError && <p role="alert">{copyError}</p>}
        <div className={styles.bar}>
          <div className="tabs" role="tablist" aria-label="配置预览视图">
            <button
              className={`tab${tab === 'yaml' ? ' on' : ''}`}
              onClick={() => setTab('yaml')}
              role="tab"
              aria-selected={tab === 'yaml'}
            >
              YAML 配置
            </button>
            <button
              className={`tab${tab === 'summary' ? ' on' : ''}`}
              onClick={() => setTab('summary')}
              role="tab"
              aria-selected={tab === 'summary'}
            >
              生成摘要
            </button>
          </div>
          <div className={styles.barGrow} />
          <span className={styles.note}>只读预览，修改请前往对应配置页面</span>
          {tab === 'yaml' && (
            <button className="btn sm" onClick={copyConfig} disabled={!ready}>
              {copied === 'config' ? 'YAML 已复制' : '复制 YAML'}
            </button>
          )}
          <button className={`btn sm ${styles.inspBtn}`} onClick={() => setInspOpen(true)}>
            检查详情
          </button>
        </div>

        {tab === 'yaml' ? (
          <div className={`codebox ${styles.code}`}>
            {!loaded ? (
              <div className={styles.loadingState}>正在组合最终配置…</div>
            ) : loadError && !preview ? (
              <div className={styles.emptyState}>
                <span className={styles.emptyMark}>!</span>
                <div>
                  <h3>{needsBase ? '先完成基础配置' : '无法生成配置'}</h3>
                  <p>{loadError}</p>
                </div>
                {needsBase && (
                  <Link className="btn primary" href="/base">
                    打开基础配置
                  </Link>
                )}
              </div>
            ) : (
              <CodeView value={content} className={styles.cmFill} />
            )}
          </div>
        ) : (
          <div className={styles.summary}>
            <section className={styles.summaryCard}>
              <div className={styles.summaryHead}>
                <div>
                  <h2>{stale ? '上次成功生成结果' : '本次生成结果'}</h2>
                  <p>
                    {isTemplate
                      ? '这些数据用于检查模版内容，不代表存在可分发的订阅地址。'
                      : '这些数据用于排查问题，不影响订阅地址。'}
                  </p>
                </div>
                {!loadError &&
                  loaded &&
                  (isTemplate ? (
                    <span className="pill acc">{TEMPLATE_NOT_DISTRIBUTABLE}</span>
                  ) : (
                    <span className="pill ok">可以使用</span>
                  ))}
              </div>
              <div className={styles.sumRow}>
                <span>YAML 大小</span>
                <span className="num">
                  {lineCount.toLocaleString()} 行 · {byteLen.toLocaleString()} 字节
                </span>
              </div>
              {preview?.build_id && (
                <div className={styles.sumRow}>
                  <span>构建标识</span>
                  <span className="num">{preview.build_id}</span>
                </div>
              )}
              <div className={styles.sumRow}>
                <span>已注入规则</span>
                <span className="num">
                  {totalRules.toLocaleString()} 条，分布在 {anchors.length} 个位置
                </span>
              </div>
              <div className={styles.sumRow}>
                <span>需要注意</span>
                <span className="num">{unmatched.length} 个未匹配锚点</span>
              </div>
              <div className={styles.sumRow}>
                <span>基础配置</span>
                <span className="num">{meta?.hasBase === false ? '未完成' : '已就绪'}</span>
              </div>
            </section>
          </div>
        )}
      </div>

      <button
        type="button"
        data-modal-backdrop className={`${styles.inspectorScrim}${inspOpen ? ` ${styles.open}` : ''}`}
        onClick={() => setInspOpen(false)}
        aria-label="关闭检查详情"
      />
      <aside ref={modalRef}
        className={`${styles.inspector}${inspOpen ? ` ${styles.open}` : ''}`}
        aria-label="配置检查详情"
      >
        <header className={styles.inspectorHead}>
          <div>
            <span>检查结果</span>
            <h2>生成详情</h2>
          </div>
          <button className={`btn ghost sm ${styles.inspClose}`} onClick={() => setInspOpen(false)}>
            关闭
          </button>
        </header>

        <div className={`${styles.checkSummary}${unmatched.length > 0 ? ` ${styles.warn}` : ''}`}>
          <span>{unmatched.length > 0 ? '!' : '✓'}</span>
          <div>
            <b>
              {unmatched.length > 0 ? `${unmatched.length} 个位置需要注意` : '所有注入位置均已匹配'}
            </b>
            <small>本次共注入 {totalRules.toLocaleString()} 条分流规则</small>
          </div>
        </div>

        <section className={styles.inspectorSection}>
          <div className={styles.sectionHead}>
            <h3>规则注入</h3>
            <span>{anchors.length} 个位置</span>
          </div>
          {anchors.length === 0 ? (
            <p className={styles.muted}>未注入任何规则。</p>
          ) : (
            <div className={styles.injectionList}>
              {anchors.map((anchor) => (
                <div className={styles.inj} key={anchor.anchor}>
                  <span>{anchor.anchor}</span>
                  <span className={styles.injN}>+{anchor.ruleCount}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {unmatched.length > 0 && (
          <section className={styles.inspectorSection}>
            <div className={styles.sectionHead}>
              <h3>需要注意</h3>
              <span>{unmatched.length} 项</span>
            </div>
            <div className={styles.warningList}>
              {unmatched.map((anchor) => (
                <div key={anchor}>锚点 {anchor} 没有找到对应标记</div>
              ))}
            </div>
          </section>
        )}

        {subUrl && !isTemplate && (
          <section className={styles.inspectorSection}>
            <div className={styles.sectionHead}>
              <h3>订阅地址</h3>
              <span>令牌默认隐藏</span>
            </div>
            <div className={styles.subscriptionUrl}>
              <code>{shownSubUrl}</code>
              <button type="button" onClick={() => setUrlRevealed((value) => !value)}>
                {urlRevealed ? '隐藏' : '显示'}
              </button>
            </div>
            <button className={`btn primary ${styles.copyUrl}`} onClick={copyUrl} disabled={!ready || !subUrl}>
              {copied === 'url' ? '地址已复制' : '复制订阅地址'}
            </button>
            <p className={styles.credentialHint}>持有此地址即可拉取配置，请按访问凭证保管。</p>
          </section>
        )}
      </aside>
    </div>
  );
}
