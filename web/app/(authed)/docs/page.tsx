'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { PageTopbar } from '@/components/PageChrome';
import {
  curlFor,
  groupByTag,
  propRows,
  resolveRef,
  typeLabel,
  type OpEntry,
  type OpenApiSpec,
  type PropRow,
} from './_lib/openapi';
import s from './docs.module.css';

/**
 * API 文档 — 应用内 OpenAPI 参考(Mintlify 式三栏:端点导航 / 说明 / cURL 示例)。
 *
 * 之前用 Scalar CDN 脚本整页接管 body,与 Next 客户端路由互相打架
 * (软导航来回会留下半个 Scalar 的 DOM)。改为:页面留在 (authed) 壳内,
 * 拉真实 /api/v1/openapi.json 自渲染 —— 主题随 v2 token 翻转,无外部依赖。
 * 示例代码全部由 spec 派生(默认值/枚举/类型占位符),不编造数据。
 */
export default function DocsPage() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch('/api/v1/openapi.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: OpenApiSpec) => setSpec(j))
      .catch((e) => setError(String(e)));
  }, []);

  const groups = useMemo(() => (spec ? groupByTag(spec) : []), [spec]);
  const opCount = useMemo(() => groups.reduce((n, g) => n + g.ops.length, 0), [groups]);

  // —— scrollspy:高亮左栏当前可见的端点 ——
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!spec || !mainRef.current) return;
    const sections = mainRef.current.querySelectorAll('section[id]');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setActiveAnchor(e.target.id);
            return;
          }
        }
      },
      { rootMargin: '-56px 0px -70% 0px' },
    );
    sections.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [spec]);

  return (
    <>
      <PageTopbar contentMaxWidth={1320}>
        <h1>API 文档</h1>
        {spec && (
          <span className="crumb">
            {opCount} 个操作 · OpenAPI {spec.openapi}
          </span>
        )}
        <div className="grow" />
        <a className="btn sm" href="/api/v1/openapi.json" download="openapi.json">
          ⇣ openapi.json
        </a>
      </PageTopbar>

      {error && (
        <div
          className="pill err"
          style={{ height: 'auto', padding: '8px 12px', marginBottom: 16, display: 'flex' }}
        >
          规范加载失败:{error}
        </div>
      )}

      {!spec && !error && <p className={s.loading}>载入 API 规范…</p>}

      {spec && (
        <div className={s.grid}>
          {/* ── 左栏:端点导航 ── */}
          <nav className={s.rail} aria-label="API 端点">
            <a className={`${s.railItem}${activeAnchor === 'api-intro' ? ` ${s.on}` : ''}`} href="#api-intro">
              <span className={s.railLabel}>介绍与鉴权</span>
            </a>
            {groups.map(({ tag, ops }) => (
              <div key={tag} className={s.railGroup}>
                <div className={s.railHead}>{tag}</div>
                {ops.map((e) => (
                  <a
                    key={e.anchor}
                    className={`${s.railItem}${activeAnchor === e.anchor ? ` ${s.on}` : ''}`}
                    href={`#${e.anchor}`}
                  >
                    <span className={`${s.m} ${s[`m_${e.method}`]}`}>{METHOD_ABBR[e.method]}</span>
                    <span className={s.railLabel}>{e.op.summary ?? e.path}</span>
                  </a>
                ))}
              </div>
            ))}
          </nav>

          {/* ── 主栏 ── */}
          <div className={s.main} ref={mainRef}>
            <Intro spec={spec} origin={origin} />
            {groups.map(({ tag, ops }) => (
              <div key={tag}>
                <div className={s.tagHead} id={`tag-${tag}`}>
                  <b>{tag}</b>
                  <span>{ops.length} 个操作</span>
                </div>
                {ops.map((e) => (
                  <OperationCard key={e.anchor} spec={spec} entry={e} origin={origin} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

const METHOD_ABBR: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PAT',
  delete: 'DEL',
};

/* ─── 介绍 + 鉴权 ─────────────────────────────────────────────────────── */

function Intro({ spec, origin }: { spec: OpenApiSpec; origin: string }) {
  return (
    <section className="panel" id="api-intro" style={{ marginBottom: 22 }}>
      <div className="panel-head">
        <h2>{spec.info.title}</h2>
        <span className="pill acc plain">v{spec.info.version}</span>
      </div>
      <div className="panel-body">
        {spec.info.description && <p className={s.introDesc}>{spec.info.description}</p>}
        <div className={s.kvRow}>
          <span className={s.k}>服务器</span>
          <code className={s.v}>{origin || '/'}</code>
        </div>
        <div className={s.kvRow}>
          <span className={s.k}>鉴权</span>
          <span className={s.v}>
            Bearer token(<code>ADMIN_KEY</code>)。带 <code>公开</code> 标记的端点除外。
          </span>
        </div>
        <div className="codebox" style={{ marginTop: 12 }}>
          <pre>{`Authorization: Bearer $ADMIN_KEY`}</pre>
        </div>
      </div>
    </section>
  );
}

/* ─── 单个操作卡 ──────────────────────────────────────────────────────── */

function OperationCard({
  spec,
  entry,
  origin,
}: {
  spec: OpenApiSpec;
  entry: OpEntry;
  origin: string;
}) {
  const { op, method, path } = entry;
  const params = (op.parameters ?? []).filter((p) => p.in === 'path' || p.in === 'query');
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  const bodyRows = useMemo(() => propRows(spec, bodySchema), [spec, bodySchema]);
  const responses = Object.entries(op.responses ?? {});
  const curl = useMemo(() => curlFor(spec, entry, origin), [spec, entry, origin]);

  return (
    <section className={`panel ${s.opCard}`} id={entry.anchor}>
      <div className="panel-head">
        <h2>{op.summary ?? path}</h2>
        {entry.isPublic && (
          <span className="pill ok plain" title="无需鉴权">
            公开
          </span>
        )}
        <div className="grow" />
        <a className={s.anchorLink} href={`#${entry.anchor}`} aria-label="锚点链接">
          #
        </a>
      </div>
      <div className={`panel-body ${s.opGrid}`}>
        {/* 左:说明 */}
        <div className={s.opDoc}>
          <div className={s.endpoint}>
            <span className={`${s.m} ${s.mBig} ${s[`m_${method}`]}`}>{method.toUpperCase()}</span>
            <code className={s.path}>{path}</code>
          </div>
          {op.description && <p className={s.opDesc}>{op.description}</p>}

          {params.length > 0 && (
            <>
              <div className={s.secHead}>参数</div>
              {params.map((p) => (
                <PropLine
                  key={`${p.in}-${p.name}`}
                  row={{
                    name: p.name,
                    depth: 0,
                    type: `${typeLabel(spec, p.schema) || 'string'} · ${p.in}`,
                    required: !!p.required,
                    description: p.description,
                  }}
                />
              ))}
            </>
          )}

          {bodyRows.length > 0 && (
            <>
              <div className={s.secHead}>请求体 · application/json</div>
              {bodyRows.map((r, i) => (
                <PropLine key={`${r.depth}-${r.name}-${i}`} row={r} />
              ))}
            </>
          )}

          {responses.length > 0 && (
            <>
              <div className={s.secHead}>响应</div>
              {responses.map(([status, r]) => (
                <ResponseLine key={status} spec={spec} status={status} resp={r} />
              ))}
            </>
          )}
        </div>

        {/* 右:示例 */}
        <div className={s.opCode}>
          <div className={s.codeShell}>
            <div className={s.codeBar}>
              <span>cURL</span>
              <CopyMini text={curl} />
            </div>
            <div className="codebox" style={{ border: 0, borderRadius: 0 }}>
              <pre>{curl}</pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ─── 属性行 / 响应行 ─────────────────────────────────────────────────── */

function PropLine({ row }: { row: PropRow }) {
  return (
    <div className={s.prop} style={{ paddingLeft: row.depth * 18 }}>
      <div className={s.propHead}>
        <code className={s.propName}>{row.name}</code>
        <span className={s.propType}>{row.type}</span>
        {row.required && <span className={s.req}>必填</span>}
        {row.deflt !== undefined && <span className={s.deflt}>默认 {row.deflt}</span>}
      </div>
      {row.enums && (
        <div className={s.enums}>
          {row.enums.map((v) => (
            <code key={v}>{v}</code>
          ))}
        </div>
      )}
      {row.description && <div className={s.propDesc}>{row.description}</div>}
    </div>
  );
}

function ResponseLine({
  spec,
  status,
  resp,
}: {
  spec: OpenApiSpec;
  status: string;
  resp: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}) {
  const schema = resp.content?.['application/json']?.schema;
  const { refName } = resolveRef(spec, schema);
  const label = refName ?? (schema ? typeLabel(spec, schema) : '');
  const ok = status.startsWith('2');
  return (
    <div className={s.resp}>
      <span className={`pill plain ${ok ? 'ok' : 'err'}`}>{status}</span>
      <span className={s.respDesc}>{resp.description}</span>
      {label && <code className={s.respType}>{label}</code>}
    </div>
  );
}

function CopyMini({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={s.copyBtn}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? '已复制 ✓' : '复制'}
    </button>
  );
}
