'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import type { ProxyGroup, ProxyGroupKind, ProxyGroupTemplate, ProxyGroupType } from '@/schemas';
import {
  COMMON_SECTIONS,
  HEALTH_TYPES,
  KIND_SEG_LABELS,
  membershipMode,
  toPayload,
  TYPE_LABELS,
  yamlPreview,
  type FormState,
  type SubscriptionLite,
} from '../_lib/model';
import { singleSubPreview, type NodesBySub } from '../_lib/useAvailableMembers';
import { MemberComposer } from './MemberComposer';
import styles from '../proxyGroups.module.css';

/** Reverse/forward reference summary for the editing group's current name. */
export interface RefSummary {
  rules: number;
  refIn: string[];
  refOut: string[];
}

const TYPE_HINT: Record<ProxyGroupType, string> = {
  select: '手动切换,面板里点选',
  'url-test': '客户端测延迟选最快',
  fallback: '按顺序取第一个可用',
  'load-balance': '按策略分摊连接',
};

interface GroupEditorProps {
  form: FormState;
  setForm: (next: FormState) => void;
  templates: ProxyGroupTemplate[];
  subs: SubscriptionLite[];
  groups: ProxyGroup[];
  nodeNames: string[];
  nodesBySub: NodesBySub;
  previewError: string | null;
  isCreate: boolean;
  originalName: string;
  refSummary: RefSummary | null;
  busy: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  /** 详情页的危险区面板,渲染在左列末尾(对齐原型,新建模式不传)。 */
  dangerZone?: ReactNode;
  /** 右列追加面板(详情页的元信息)。 */
  asideExtra?: ReactNode;
}

export function GroupEditor({
  form,
  setForm,
  templates,
  subs,
  groups,
  nodeNames,
  nodesBySub,
  previewError,
  isCreate,
  originalName,
  refSummary,
  busy,
  onSubmit,
  onCancel,
  dangerZone,
  asideExtra,
}: GroupEditorProps) {
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm({ ...form, [k]: v });
  const mode = membershipMode(form.kind);
  const isHealth = HEALTH_TYPES.has(form.type);

  // ── bound-kind previews ───────────────────────────────────────────
  const boundSub = subs.find((s) => s.id === form.bound_subscription_id) ?? null;
  const subNodes = useMemo(
    () => (mode === 'bound-sub' ? singleSubPreview(nodesBySub, boundSub?.name) : []),
    [mode, nodesBySub, boundSub],
  );
  const tpl = form.template_id ? (templates.find((t) => t.id === form.template_id) ?? null) : null;

  // ── effective rendered fields for the YAML preview ────────────────
  const effective = useMemo(() => {
    const p = toPayload(form) as Record<string, unknown>;
    if (mode === 'bound-sub' && boundSub) {
      // 渲染时成员 = 该订阅源处理后的全部节点(去前缀后按真实节点名直接列出)。
      p.proxies = subNodes;
    }
    return p;
  }, [form, mode, boundSub, subNodes]);

  const referenced =
    !!refSummary &&
    (refSummary.rules > 0 || refSummary.refIn.length > 0 || refSummary.refOut.length > 0);

  return (
    <div className={styles.detailGrid}>
      {/* ── 左列：编辑区 ── */}
      <div className="col">
        {/* 基本信息 */}
        <section className="panel">
          <div className="panel-head">
            <h2>基本信息</h2>
          </div>
          <div className="panel-body">
            <div className={styles.formGrid}>
              <div className="field span2" style={{ gridColumn: '1 / -1' }}>
                <label>名称</label>
                <input
                  className="input mono"
                  value={form.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="策略组名称"
                />
                {!isCreate && referenced && (
                  <div className="hint">
                    重命名会自动级联:{refSummary!.rules} 条规则的出口、
                    {refSummary!.refIn.length} 个组的成员引用将同步更新。
                  </div>
                )}
              </div>
              <div className="field">
                <label>
                  分区 section{' '}
                  <span style={{ color: 'var(--faint)', fontWeight: 400 }}>仅用于列表组织</span>
                </label>
                <input
                  className="input"
                  value={form.section}
                  onChange={(e) => set('section', e.target.value)}
                  placeholder="如 规则集 / 系统 / 地区"
                  list="proxy-group-sections"
                />
                <datalist id="proxy-group-sections">
                  {COMMON_SECTIONS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label>渲染顺序 rank</label>
                <input
                  className="input mono"
                  type="number"
                  step={10}
                  value={form.rank}
                  onChange={(e) => set('rank', e.target.value)}
                  placeholder={isCreate ? '留空 = 排到最后' : undefined}
                />
                <div className="hint">proxy-groups 块内按 rank 升序渲染,步长 10</div>
              </div>
              <div className="field">
                <label>组模板</label>
                <select
                  className="input"
                  value={form.template_id}
                  onChange={(e) => set('template_id', e.target.value)}
                >
                  <option value="">不使用模板</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <div className="hint">模板只补全缺省字段;组上显式设置的值始终优先</div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>备注</label>
                <input
                  className="input"
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  placeholder="给未来的自己留一句…"
                />
              </div>
            </div>
          </div>
        </section>

        {/* 类型与参数 */}
        <section className="panel">
          <div className="panel-head">
            <h2>类型</h2>
            <span className="sub">客户端如何在成员间做选择</span>
          </div>
          <div className="panel-body">
            <div className={styles.typePick}>
              {(Object.keys(TYPE_LABELS) as ProxyGroupType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`${styles.tp}${form.type === t ? ' ' + styles.on : ''}`}
                  onClick={() => set('type', t)}
                >
                  <b>{t}</b>
                  <span>{TYPE_HINT[t]}</span>
                </button>
              ))}
            </div>

            {form.type === 'select' && (
              <div className={styles.lensNote} style={{ marginTop: 14, marginBottom: 0 }}>
                <span className="ic">ⓘ</span>
                select 无额外参数。成员的可用性与延迟由客户端运行时测定 —
                本工作台只组装配置,不做测速。
              </div>
            )}

            {isHealth && (
              <>
                <div className={styles.formGrid} style={{ marginTop: 14 }}>
                  <div className="field span2" style={{ gridColumn: '1 / -1' }}>
                    <label>
                      url{' '}
                      <span style={{ color: 'var(--faint)', fontWeight: 400 }}>健康检查地址</span>
                    </label>
                    <input
                      className="input mono"
                      value={form.url}
                      onChange={(e) => set('url', e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>interval / 秒</label>
                    <input
                      className="input mono"
                      value={form.interval}
                      onChange={(e) => set('interval', e.target.value)}
                    />
                  </div>
                  {form.type === 'url-test' && (
                    <div className="field">
                      <label>
                        tolerance / ms{' '}
                        <span style={{ color: 'var(--faint)', fontWeight: 400 }}>仅 url-test</span>
                      </label>
                      <input
                        className="input mono"
                        value={form.tolerance}
                        onChange={(e) => set('tolerance', e.target.value)}
                      />
                    </div>
                  )}
                  <div className="field">
                    <label>lazy</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 34 }}>
                      <button
                        type="button"
                        className="switch"
                        aria-pressed={form.lazy}
                        onClick={() => set('lazy', !form.lazy)}
                      />
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>选中才探测</span>
                    </div>
                  </div>
                  <div className="field">
                    <label>expected-status</label>
                    <input
                      className="input mono"
                      value={form['expected-status']}
                      onChange={(e) => set('expected-status', e.target.value)}
                      placeholder="200 或 200-299"
                    />
                  </div>
                  <div className="field">
                    <label>timeout / ms</label>
                    <input
                      className="input mono"
                      value={form.timeout}
                      onChange={(e) => set('timeout', e.target.value)}
                      placeholder="5000"
                    />
                  </div>
                  <div className="field">
                    <label>max-failed-times</label>
                    <input
                      className="input mono"
                      value={form['max-failed-times']}
                      onChange={(e) => set('max-failed-times', e.target.value)}
                    />
                  </div>
                </div>
                <div className={styles.lensNote} style={{ margin: '2px 0 0' }}>
                  <span className="ic">ⓘ</span>
                  这些是写给客户端的静态参数,由客户端运行时执行健康检查;保存后仅改变渲染出的 YAML。
                </div>
              </>
            )}

            {form.type === 'load-balance' && (
              <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
                <label>strategy</label>
                <div className="seg">
                  {['consistent-hashing', 'round-robin', 'sticky-sessions'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={`opt${form.strategy === s ? ' on' : ''}`}
                      onClick={() => set('strategy', form.strategy === s ? '' : s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* 成员来源 */}
        <section className="panel">
          <div className="panel-head">
            <h2>成员来源</h2>
            <div className="grow" />
            <div className="seg">
              {(Object.keys(KIND_SEG_LABELS) as ProxyGroupKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`opt${form.kind === k ? ' on' : ''}`}
                  onClick={() => set('kind', k)}
                >
                  {KIND_SEG_LABELS[k]}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-body">
            <div className={styles.lensNote}>
              <span className="ic">ⓘ</span>
              这只是编辑视角,不锁定字段 —
              切换视角不会丢失已有数据,所有原生字段始终可在「高级」里直接编辑。
            </div>

            {mode === 'composer' && (
              <MemberComposer
                selfName={form.name}
                proxies={form.proxies}
                filter={form.filter}
                excludeFilter={form['exclude-filter']}
                includeAllProxies={form['include-all-proxies']}
                autoActive={
                  form['include-all-proxies'] ||
                  form['include-all-providers'] ||
                  form['include-all']
                }
                onProxies={(next) => set('proxies', next)}
                onFilter={(v) => set('filter', v)}
                onExcludeFilter={(v) => set('exclude-filter', v)}
                onIncludeAllProxies={(v) => set('include-all-proxies', v)}
                onRegionFill={(filter, nameSuggestion) =>
                  setForm({ ...form, filter, name: form.name || nameSuggestion })
                }
                nodeNames={nodeNames}
                nodesBySub={nodesBySub}
                subs={subs}
                groups={groups}
                previewError={previewError}
                showAuto={form.kind !== 'manual'}
                showManual={form.kind !== 'all'}
                emphasizeAuto={form.kind === 'filter' || form.kind === 'all'}
              />
            )}

            {mode === 'bound-sub' && (
              <>
                <div className="field">
                  <label>绑定订阅源</label>
                  <select
                    className="input"
                    value={form.bound_subscription_id}
                    onChange={(e) => set('bound_subscription_id', e.target.value)}
                  >
                    <option value="">(请选择)</option>
                    {subs.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.display_name ? `${s.display_name} · ${s.name}` : s.name}
                      </option>
                    ))}
                  </select>
                </div>
                {boundSub && (
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>
                      渲染时成员{' '}
                      <span className={styles.lockTip}>🔒 由绑定接管 = 该源处理后的全部节点</span>
                    </label>
                    <ReadonlyMemberPreview nodes={subNodes} previewError={previewError} />
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* 高级 */}
        <Panel title="高级" subtitle="少用,但要用时不该去翻文档">
          <div className={styles.formGrid}>
            <div className="field">
              <label>use(provider 名,一行一项)</label>
              <textarea
                className="input mono"
                rows={2}
                value={form.use}
                onChange={(e) => set('use', e.target.value)}
              />
            </div>
            <div className="field">
              <label>exclude-type（| 分隔 AdapterType）</label>
              <input
                className="input mono"
                value={form['exclude-type']}
                onChange={(e) => set('exclude-type', e.target.value)}
                placeholder="如 Direct|Reject"
              />
            </div>
            <div className="field">
              <label>
                empty-fallback{' '}
                <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
                  动态成员为空时的具体出口
                </span>
              </label>
              <input
                className="input mono"
                value={form['empty-fallback']}
                onChange={(e) => set('empty-fallback', e.target.value)}
                placeholder="REJECT"
              />
            </div>
            <div className="field">
              <label>
                dialer-proxy{' '}
                <span style={{ color: 'var(--faint)', fontWeight: 400 }}>链式上游</span>
              </label>
              <input
                className="input mono"
                value={form['dialer-proxy']}
                onChange={(e) => set('dialer-proxy', e.target.value)}
              />
            </div>
            <div className="field">
              <label>
                routing-mark{' '}
                <span style={{ color: 'var(--faint)', fontWeight: 400 }}>Linux SO_MARK</span>
              </label>
              <input
                className="input mono"
                value={form['routing-mark']}
                onChange={(e) => set('routing-mark', e.target.value)}
              />
            </div>
            <div className="field span2" style={{ gridColumn: '1 / -1' }}>
              <label>
                icon{' '}
                <span style={{ color: 'var(--faint)', fontWeight: 400 }}>
                  URL,部分客户端面板显示
                </span>
              </label>
              <input
                className="input mono"
                value={form.icon}
                onChange={(e) => set('icon', e.target.value)}
                placeholder="https://…/proxy.svg"
              />
            </div>
            <div className="field span2" style={{ gridColumn: '1 / -1', marginBottom: 0 }}>
              <label>开关</label>
              <div className={styles.checkRow}>
                <SwitchRow
                  label="include-all-providers"
                  on={form['include-all-providers']}
                  onToggle={(v) => set('include-all-providers', v)}
                />
                <SwitchRow
                  label="include-all"
                  on={form['include-all']}
                  onToggle={(v) => set('include-all', v)}
                />
                <SwitchRow
                  label="disable-udp"
                  on={form['disable-udp']}
                  onToggle={(v) => set('disable-udp', v)}
                />
                <SwitchRow label="hidden" on={form.hidden} onToggle={(v) => set('hidden', v)} />
              </div>
            </div>
          </div>
        </Panel>

        {/* 创建条(详情页的保存在 topbar,对齐原型) */}
        {isCreate && (
          <div className={styles.wizFoot}>
            <div className={styles.wizSum}>
              预设不锁定任何字段 —— 创建后进详情页可继续调整类型、成员视角与全部原生参数。
            </div>
            <button className="btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <button className="btn primary" onClick={onSubmit} disabled={busy}>
              {busy ? '创建中…' : '创建'}
            </button>
          </div>
        )}

        {dangerZone}
      </div>

      {/* ── 右列：引用关系 + 渲染预览 + 元信息 ── */}
      <div className="col">
        {!isCreate && (
          <section className="panel">
            <div className="panel-head">
              <h2>引用关系</h2>
              <span className="sub">谁在用这个组</span>
            </div>
            <div className="panel-body" style={{ padding: 14 }}>
              {!referenced && (
                <div className="hint" style={{ lineHeight: 1.6 }}>
                  暂无引用 —— 没有规则或组指向「{originalName}」,可安全删除。
                </div>
              )}
              {refSummary!.rules > 0 && (
                <>
                  <div className={styles.refHead}>规则 · {refSummary!.rules} 条</div>
                  <div className={styles.refList}>
                    <Link className={styles.refRow} href="/rules">
                      <span className={styles.k}>policy</span>
                      <span className={styles.v}>{refSummary!.rules} 条规则的出口指向本组</span>
                      <span className={styles.arr}>→</span>
                    </Link>
                  </div>
                </>
              )}
              {refSummary!.refIn.length > 0 && (
                <>
                  <div className={styles.refHead}>被组嵌套 · {refSummary!.refIn.length}</div>
                  <div className={styles.refList}>
                    {refSummary!.refIn.map((n) => (
                      <GroupRefRow key={n} k="proxies[]" name={n} groups={groups} />
                    ))}
                  </div>
                </>
              )}
              {refSummary!.refOut.length > 0 && (
                <>
                  <div className={styles.refHead}>本组引用 · {refSummary!.refOut.length}</div>
                  <div className={styles.refList}>
                    {refSummary!.refOut.map((n) => (
                      <GroupRefRow key={n} k="成员" name={n} groups={groups} />
                    ))}
                  </div>
                </>
              )}
              {referenced && (
                <div className="hint" style={{ marginTop: 14, lineHeight: 1.6 }}>
                  重命名会自动级联到以上全部引用;存在引用时删除被阻止。
                </div>
              )}
            </div>
          </section>
        )}

        <section className="panel">
          <div className="panel-head">
            <h2>渲染预览</h2>
            <span className="sub">写入最终配置的样子</span>
            <div className="grow" />
            <CopyButton text={yamlPreview(effective)} />
          </div>
          <div
            className="codebox"
            style={{ borderRadius: '0 0 var(--r-lg) var(--r-lg)', borderWidth: '1px 0 0' }}
          >
            <pre>{yamlPreview(effective)}</pre>
          </div>
          {tpl && (
            <div
              className="panel-body"
              style={{ padding: '12px 14px', borderTop: '1px solid var(--border)' }}
            >
              <div className="hint">另继承共享模板「{tpl.name}」中本组未显式设置的字段。</div>
            </div>
          )}
        </section>

        {asideExtra}
      </div>
    </div>
  );
}

/* ─── helpers ────────────────────────────────────────────────────────── */

/** 引用关系里的一行:能解析成已知组就链到其详情页,否则展示纯文本(节点/内建)。 */
function GroupRefRow({ k, name, groups }: { k: string; name: string; groups: ProxyGroup[] }) {
  const target = groups.find((g) => g.name === name);
  if (!target) {
    return (
      <div className={styles.refRow}>
        <span className={styles.k}>{k}</span>
        <span className={styles.v}>{name}</span>
      </div>
    );
  }
  return (
    <Link className={styles.refRow} href={`/proxy-groups/${target.id}`}>
      <span className={styles.k}>{k}</span>
      <span className={styles.v}>{name}</span>
      <span className={styles.arr}>→</span>
    </Link>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost sm"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? '已复制 ✓' : '复制'}
    </button>
  );
}

function ReadonlyMemberPreview({
  nodes,
  previewError,
}: {
  nodes: string[];
  previewError: string | null;
}) {
  const [open, setOpen] = useState(false);
  if (previewError) {
    return (
      <div className="hint" style={{ marginTop: 8, color: 'var(--warn)' }}>
        节点列表暂不可用,无法预览命中数。
      </div>
    );
  }
  return (
    <div className={styles.rePreview}>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => setOpen((v) => !v)}
        style={{ paddingLeft: 0 }}
      >
        当前命中 <b style={{ color: 'var(--accent)' }}>{nodes.length}</b> 个节点{' '}
        {open ? '收起 ▴' : '展开 ▾'}
      </button>
      {open && (
        <div className={styles.nodeBox}>
          {nodes.length === 0 ? (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>无节点</span>
          ) : (
            nodes.map((n) => (
              <span key={n} className="mem in" style={{ cursor: 'default' }}>
                {n}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SwitchRow({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
}) {
  return (
    <span className={styles.check}>
      <button type="button" className="switch" aria-pressed={on} onClick={() => onToggle(!on)} />
      {label}
    </span>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {subtitle && <span className="sub">{subtitle}</span>}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}
