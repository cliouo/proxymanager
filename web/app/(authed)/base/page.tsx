'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { useUnsavedGuard } from '@/lib/client/useUnsavedGuard';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { CodeEditor } from '@/components/ui/CodeEditor';
import { DeviceOverrideStrip } from './_components/DeviceOverrideStrip';
import { ProfileBindingBar } from './_components/ProfileBindingBar';
import styles from './base.module.css';

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

function validationIssues(errors: unknown): ValidationResult['orphans'] {
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const issue = raw as Record<string, unknown>;
    if (typeof issue.rule_id === 'string' && typeof issue.reason === 'string') {
      return [{ rule_id: issue.rule_id, reason: issue.reason }];
    }
    if (typeof issue.message !== 'string') return [];
    const path = Array.isArray(issue.path)
      ? issue.path.filter((part): part is string | number =>
          ['string', 'number'].includes(typeof part),
        )
      : typeof issue.path === 'string'
        ? [issue.path]
        : [];
    const location = path.length > 0 ? path.join('.') : null;
    const code = typeof issue.code === 'string' ? issue.code : null;
    return [
      {
        rule_id: location ?? code ?? `config:${index + 1}`,
        reason: issue.message,
      },
    ];
  });
}

function errorDetail(err: unknown): { message: string; issues: ValidationResult['orphans'] } {
  if (!(err instanceof ApiError)) return { message: String(err), issues: [] };
  const issues = validationIssues(err.problem.errors);
  return {
    message:
      issues.length > 0
        ? issues.map((issue) => `${issue.rule_id}: ${issue.reason}`).join('；')
        : (err.problem.detail ?? err.message),
    issues,
  };
}

export default function BasePage() {
  const [data, setData] = useState<BaseData | null>(null);
  const [content, setContent] = useState('');
  const [etag, setEtag] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{
    kind: 'info' | 'success' | 'error';
    message: string;
  } | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [busy, setBusy] = useState<'save' | 'validate' | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);

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
      // P1-8: distinguish a SCOPE 404 (the active-profile cookie points at a
      // profile that no longer exists) from a genuine "base uninitialized"
      // 404. The former must NOT show an empty editor (saving would target a
      // missing profile) — tell the user to switch profiles instead.
      if (err instanceof ApiError && err.status === 404) {
        const scopeMissing = (err.problem.detail ?? '').includes('配置文件');
        if (scopeMissing) {
          setData(null);
          setLoadError(
            '当前配置文件不存在(可能已被删除或改名)。请在右上角切换到一个有效的配置文件。',
          );
        } else {
          setData(null);
          setContent('');
          setEtag(null);
          setStatus({ kind: 'info', message: '尚未设置基础配置，请粘贴 base.yaml 内容后保存。' });
        }
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
  useUnsavedGuard(dirty); // P1-6
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
          ? { kind: 'success', message: '结构校验通过；保存时还会校验最终配置' }
          : { kind: 'error', message: `结构校验未通过 — ${res.data.orphans.length} 个问题` },
      );
    } catch (err) {
      const { message, issues } = errorDetail(err);
      setStatus({ kind: 'error', message });
      if (issues.length > 0) {
        setValidation({
          valid: false,
          anchors: [],
          policies: [],
          orphans: issues,
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
      const { message, issues } = errorDetail(err);
      setStatus({ kind: 'error', message });
      if (issues.length > 0) {
        setValidation({
          valid: false,
          anchors: [],
          policies: [],
          orphans: issues,
        });
      }
    } finally {
      setBusy(null);
    }
  }, [content, etag, load]);

  // ⌘S / Ctrl+S 保存 —— 由 CodeEditor 内部的 CodeMirror keymap 触发(Prec.high
  // + preventDefault),页面不再挂自己的 keydown 监听,保证只触发一次;
  // busy / dirty 守卫保持与旧 textarea 监听一致。
  const onEditorSave = useCallback(() => {
    if (busy === null && dirty) onSave();
  }, [busy, dirty, onSave]);

  return (
    <div className={styles.workbench}>
      {/* —— 页头注入共享 topbar(对齐 v2/base.html:标题 / pill / 未保存点 /
          crumb / 校验 / 保存 ⌘S 上提,编辑器内只留 etag·行字节·检查) —— */}
      <PageTopbar>
        <h1>基础配置</h1>
        <ScopePill />
        {dirty && (
          <span className="is-dirty" style={{ display: 'inline-flex' }}>
            <span className="unsaved-dot" title="有未保存修改" />
          </span>
        )}
        <span className="crumb">
          base.yaml
          {loaded ? ` · ${lineCount} 行` : ''}
        </span>
        <div className="grow" />
        <button className="btn" onClick={onValidate} disabled={busy !== null}>
          {busy === 'validate' ? '校验中…' : '校验'}
        </button>
        <button className="btn primary" onClick={onSave} disabled={busy !== null || !dirty}>
          {busy === 'save' ? '保存中…' : '保存'}{' '}
          <span className="kbd" style={{ background: 'rgba(0,0,0,.2)', color: 'var(--accent-on)' }}>
            ⌘S
          </span>
        </button>
      </PageTopbar>

      <div className={`${styles.shell}${dirty ? ' is-dirty' : ''}`}>
        {/* toolbar: etag · 行/字节 · 锚点检查(校验 / 保存已上提 topbar) */}
        <div className={styles.bar}>
          {etag && <span className={styles.meta}>etag · {etag.slice(0, 8)}</span>}
          <span className={styles.meta}>
            {lineCount} 行 · {byteLen.toLocaleString()} 字节
          </span>
          <div style={{ flex: 1 }} />
          <button className={`btn sm ${styles.inspBtn}`} onClick={() => setInspOpen(true)}>
            锚点 / 检查
          </button>
        </div>

        {/* 给普通用户解释本页职责，专业字段保留为补充。 */}
        <div className={styles.hint}>
          这里维护所有设备共用的运行基础，包括端口、DNS、嗅探和 TUN。
          <code>rules:</code> 中只需保留注入位置，具体流量去向请到「分流规则」管理。
          保存前系统会试算完整配置，并指出无法使用的具体位置。
        </div>

        {/* per-profile node source binding */}
        <ProfileBindingBar />

        {/* 设备覆盖的反向标注(有设备且有交集时才出现) */}
        <DeviceOverrideStrip content={content} />

        {/* status strip */}
        {(loadError || status) && (
          <div
            className={`${styles.status} ${
              loadError || status?.kind === 'error'
                ? styles.err
                : status?.kind === 'success'
                  ? styles.ok
                  : styles.info
            }`}
          >
            {loadError ?? status?.message}
          </div>
        )}

        {/* full-bleed editor —— CodeMirror 虚拟化(只渲染可视行),
            几万行 base.yaml 不再生成几万个 gutter DOM 节点 */}
        <div className={styles.editorFill}>
          <CodeEditor
            value={content}
            onChange={setContent}
            onSave={onEditorSave}
            dirty={dirty}
            label={loaded ? 'base.yaml' : '加载中 …'}
            minHeight={0}
          />
        </div>
      </div>

      <Inspector
        data={data}
        validation={validation}
        open={inspOpen}
        onClose={() => setInspOpen(false)}
      />
    </div>
  );
}

function Inspector({
  data,
  validation,
  open,
  onClose,
}: {
  data: BaseData | null;
  validation: ValidationResult | null;
  open: boolean;
  onClose: () => void;
}) {
  const anchors = validation?.anchors.length ? validation.anchors : (data?.anchors ?? []);
  const policies = validation?.policies.length ? validation.policies : (data?.policies ?? []);
  const orphans = validation?.orphans ?? [];

  return (
    <aside className={`${styles.inspector}${open ? ` ${styles.open}` : ''}`}>
      <button className={`btn ghost sm ${styles.inspClose}`} onClick={onClose}>
        关闭
      </button>

      <div className={`${styles.inspH} ${styles.first}`}>
        <span>锚点</span>
        <span className={styles.n}>{anchors.length}</span>
      </div>
      {anchors.length === 0 ? (
        <div className={styles.empty}>未发现锚点</div>
      ) : (
        anchors.map((a) => (
          <div className={styles.anchorLi} key={a} title={a}>
            <span className={styles.nm}>{a}</span>
          </div>
        ))
      )}

      <div className={styles.inspH}>
        <span>策略组</span>
        <span className={styles.n}>{policies.length}</span>
      </div>
      {policies.length === 0 ? (
        <div className={styles.empty}>未发现策略</div>
      ) : (
        <div className={styles.polWrap}>
          {policies.slice(0, 30).map((p) => (
            <span className="tag" key={p}>
              {p}
            </span>
          ))}
          {policies.length > 30 && <span className={styles.empty}>+{policies.length - 30}</span>}
        </div>
      )}

      {orphans.length > 0 && (
        <>
          <div className={styles.inspH}>
            <span style={{ color: 'var(--danger)' }}>配置问题</span>
            <span className={styles.n} style={{ color: 'var(--danger)' }}>
              {orphans.length}
            </span>
          </div>
          {orphans.map((o, i) => (
            <div className={styles.orphan} key={i}>
              <code>{o.rule_id}</code>: {o.reason}
            </div>
          ))}
        </>
      )}

      <div className={styles.inspH}>编辑器</div>
      <div className={styles.kvRow}>
        <span>Tab</span>
        <span className={styles.v}>2 空格</span>
      </div>
      <div className={styles.kvRow}>
        <span>缩进</span>
        <span className={styles.v}>自动</span>
      </div>
      <div className={styles.kvRow}>
        <span>搜索</span>
        <span className={styles.v}>⌘F</span>
      </div>

      <div className={styles.inspH}>提示</div>
      <div className={styles.tip}>
        以 <code>@anchor</code> 注释声明注入位。保存使用 If-Match etag 防止并发覆盖。
      </div>
    </aside>
  );
}
