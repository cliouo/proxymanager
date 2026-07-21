'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/client/api';
import { PageTopbar } from '@/components/PageChrome';
import { ScopePill } from '@/components/Topbar';
import { useToast } from '@/components/ui/Toast';
import styles from './tailscale.module.css';

/* ---- API shapes (mirror lib/scenarios/tailscale/scenario.ts) ---- */

interface TsNode {
  name: string;
  hostname?: string;
  controlUrl?: string;
  stateDir?: string;
  udp?: boolean;
  acceptRoutes?: boolean;
  ephemeral?: boolean;
  exitNode?: string;
  hasAuthKey: boolean;
}
interface TsGroup {
  id: string;
  name: string;
  type: string;
  proxies?: string[];
  managedShape: boolean;
}
interface TsRule {
  id: string;
  anchor: string;
  type: string;
  value: string;
  policy: string;
  enabled?: boolean;
  note?: string;
}
interface Summary {
  initialized: boolean;
  nodes: TsNode[];
  groups: TsGroup[];
  rules: TsRule[];
  anchors: string[];
}

async function runOp(op: string, payload: unknown): Promise<unknown> {
  const res = await api<{ data: unknown }>('/api/v1/ops', {
    method: 'POST',
    body: { scenario: 'tailscale', op, payload },
  });
  return res.data;
}

export default function TailscalePage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const showError = useCallback(
    (msg: string | null) => {
      setError(msg);
      if (msg) toast(msg, { variant: 'error' });
    },
    [toast],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api<{ data: Summary }>('/api/v1/scenarios/tailscale');
      setSummary(res.data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading && !summary) {
    return <p className={styles.empty}>正在检测 Tailscale 接入状态…</p>;
  }
  if (!summary) {
    return <div className={styles.errBox}>{error ?? '无数据'}</div>;
  }

  const state =
    summary.nodes.length === 0 ? '未接入' : summary.nodes.length === 1 ? '已接入' : '多节点';

  return (
    <>
      <PageTopbar>
        <h1>Tailscale</h1>
        <ScopePill />
        <span className="crumb">{state}</span>
        <div className="grow" />
      </PageTopbar>

      <p className={styles.intro}>
        Mihomo 内核可以内嵌一个 Tailscale 节点（<code className="mono">type: tailscale</code>
        出站），代理开着的同时直接访问你的 tailnet（<code className="mono">100.x.x.x</code>
        ），绕开手机单 VPN 限制。本页一键生成三件<b>普通配置产物</b>：base 里的 tailscale
        节点、一个 select 策略组、一条把整个 CGNAT 段指向它的 IP-CIDR
        规则——生成后归属节点 / 策略组 / 规则模块正常管理。
      </p>

      {error && <div className={styles.errBox}>{error}</div>}

      {!summary.initialized ? (
        <div className={styles.errBox}>当前配置文件还没有 base,请先到 /base 初始化。</div>
      ) : summary.nodes.length === 0 ? (
        <WizardCard anchors={summary.anchors} onDone={reload} onError={showError} />
      ) : summary.nodes.length === 1 ? (
        <StatusView summary={summary} onChanged={reload} onError={showError} />
      ) : (
        <MultiNodeView nodes={summary.nodes} />
      )}
    </>
  );
}

/* ---------------- wizard (未接入) ---------------- */

function WizardCard({
  anchors,
  onDone,
  onError,
}: {
  anchors: string[];
  onDone: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [hostname, setHostname] = useState('');
  const [authKey, setAuthKey] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [controlUrl, setControlUrl] = useState('');
  const [stateDir, setStateDir] = useState('');
  const [exitNode, setExitNode] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [anchor, setAnchor] = useState(anchors[0] ?? '');
  const [extraCidrs, setExtraCidrs] = useState('');
  const [pending, setPending] = useState(false);
  const toast = useToast();

  return (
    <>
      <div className={styles.secNote}>
        <b>先读这个：auth-key 会随配置分发。</b>
        key 明文写进 base,并通过本配置文件的订阅链接下发——拿到链接的人就能把设备加进你的
        tailnet。建议在 Tailscale 控制台用 <b>Reusable + tag</b> 的 key（tagged 设备的 node key
        永不过期,tag 需先在 ACL 的 <code className="mono">tagOwners</code>{' '}
        里声明）,并用 ACL 收紧该 tag 的权限;疑似泄露立即 revoke。
      </div>

      <form
        className={styles.formPanel}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!hostname.trim()) return;
          setPending(true);
          try {
            const cidrs = extraCidrs
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean);
            await runOp('enable', {
              hostname: hostname.trim(),
              ...(authKey.trim() ? { authKey: authKey.trim() } : {}),
              ...(controlUrl.trim() ? { controlUrl: controlUrl.trim() } : {}),
              ...(stateDir.trim() ? { stateDir: stateDir.trim() } : {}),
              ...(exitNode.trim() ? { exitNode: exitNode.trim() } : {}),
              ...(nodeName.trim() ? { nodeName: nodeName.trim() } : {}),
              ...(groupName.trim() ? { groupName: groupName.trim() } : {}),
              ...(anchor ? { anchor } : {}),
              ...(cidrs.length > 0 ? { extraCidrs: cidrs } : {}),
            });
            toast('已接入。首次访问 tailscale 节点会超时——tsnet 正在登录并拉取网络映射,稍等重试即可。');
            await onDone();
          } catch (err) {
            onError(err instanceof ApiError ? err.message : String(err));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className={styles.formGrid}>
          <div className={`field ${styles.fieldTight}`}>
            <label>设备名 hostname</label>
            <input
              className="input mono"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="例如 mate70"
              required
            />
          </div>
          <div className={`field ${styles.fieldTight}`}>
            <label>auth-key（强烈建议填写）</label>
            <input
              className="input mono"
              type="password"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              placeholder="tskey-auth-…（留空 = 交互登录,不适合无头设备）"
            />
          </div>
          <div className={styles.formActions}>
            <button className="btn primary" type="submit" disabled={pending || !hostname.trim()}>
              {pending ? '…' : '一键接入'}
            </button>
            <button className="btn ghost" type="button" onClick={() => setAdvanced((v) => !v)}>
              {advanced ? '收起高级选项' : '高级选项'}
            </button>
          </div>
        </div>

        {advanced && (
          <div className={styles.advZone}>
            <div className={styles.formGrid3}>
              <div className={`field ${styles.fieldTight}`}>
                <label>control-url（headscale 才填）</label>
                <input
                  className="input mono"
                  value={controlUrl}
                  onChange={(e) => setControlUrl(e.target.value)}
                  placeholder="留空 = 官方 SaaS"
                />
              </div>
              <div className={`field ${styles.fieldTight}`}>
                <label>state-dir</label>
                <input
                  className="input mono"
                  value={stateDir}
                  onChange={(e) => setStateDir(e.target.value)}
                  placeholder={hostname.trim() ? `./ts-${hostname.trim()}` : './ts-<设备名>'}
                />
              </div>
              <div className={`field ${styles.fieldTight}`}>
                <label>exit-node（默认留空）</label>
                <input
                  className="input mono"
                  value={exitNode}
                  onChange={(e) => setExitNode(e.target.value)}
                  placeholder="海外 exit node 不能当翻墙用"
                />
              </div>
              <div className={`field ${styles.fieldTight}`}>
                <label>节点名</label>
                <input
                  className="input mono"
                  value={nodeName}
                  onChange={(e) => setNodeName(e.target.value)}
                  placeholder={hostname.trim() ? `ts-${hostname.trim()}` : '自动命名'}
                />
              </div>
              <div className={`field ${styles.fieldTight}`}>
                <label>策略组名</label>
                <input
                  className="input mono"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Tailscale"
                />
              </div>
              <div className={`field ${styles.fieldTight}`}>
                <label>规则锚点</label>
                <select className="input mono" value={anchor} onChange={(e) => setAnchor(e.target.value)}>
                  {anchors.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div className={`field ${styles.fieldTight} ${styles.spanAll}`}>
                <label>额外网段（subnet router 场景,空格/逗号分隔）</label>
                <input
                  className="input mono"
                  value={extraCidrs}
                  onChange={(e) => setExtraCidrs(e.target.value)}
                  placeholder="例如 192.168.50.0/24 —— 需配合节点 accept-routes,默认已开"
                />
              </div>
            </div>
          </div>
        )}
      </form>

      <p className={styles.hint}>
        默认生成:<code className="mono">udp: true</code>（tailnet 里的 DNS/QUIC 依赖它）、
        <code className="mono">accept-routes: true</code>、规则{' '}
        <code className="mono">IP-CIDR,100.64.0.0/10,Tailscale,no-resolve</code>。
      </p>
    </>
  );
}

/* ---------------- status (已接入) ---------------- */

function StatusView({
  summary,
  onChanged,
  onError,
}: {
  summary: Summary;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const node = summary.nodes[0];
  const [newKey, setNewKey] = useState('');
  const [keyPending, setKeyPending] = useState(false);
  const [teardownPending, setTeardownPending] = useState(false);
  const toast = useToast();

  const group = summary.groups[0];
  const incomplete = !group || summary.rules.length === 0;

  return (
    <>
      <section className={styles.card}>
        <div className={styles.sectionHead}>
          <span className="eyebrow">节点</span>
          <span className={`${styles.badge} ${node.hasAuthKey ? styles.badgeOk : styles.badgeWarn}`}>
            {node.hasAuthKey ? 'auth-key 已配置' : 'auth-key 未配置'}
          </span>
          <div className="grow" style={{ flex: 1 }} />
          <Link className="btn sm ghost" href="/base">
            去 /base 编辑
          </Link>
        </div>
        <div className={styles.kvGrid}>
          <Kv k="节点名" v={node.name} />
          <Kv k="hostname" v={node.hostname ?? '—'} />
          <Kv k="state-dir" v={node.stateDir ?? './tailscale（默认）'} />
          <Kv k="control-url" v={node.controlUrl ?? '官方 SaaS'} />
          <Kv k="udp" v={node.udp === undefined ? 'false（默认）' : String(node.udp)} />
          <Kv
            k="accept-routes"
            v={node.acceptRoutes === undefined ? 'false（默认）' : String(node.acceptRoutes)}
          />
          <Kv k="exit-node" v={node.exitNode ?? '未设置'} />
          <Kv k="auth-key" v={node.hasAuthKey ? '●●●●●●（不回显）' : '未配置'} />
        </div>
        <div className={styles.inlineForm}>
          <input
            className="input mono"
            type="password"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="换新 auth-key（重装 / 清数据后节点 state 丢失时用）"
          />
          <button
            className="btn sm"
            disabled={keyPending || !newKey.trim()}
            onClick={async () => {
              setKeyPending(true);
              try {
                await runOp('update-auth-key', { nodeName: node.name, authKey: newKey.trim() });
                setNewKey('');
                toast('auth-key 已更新（此操作不可撤销:审计快照不保存凭据）。');
                await onChanged();
              } catch (err) {
                onError(err instanceof ApiError ? err.message : String(err));
              } finally {
                setKeyPending(false);
              }
            }}
          >
            {keyPending ? '…' : '更新'}
          </button>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.sectionHead}>
          <span className="eyebrow">策略组</span>
          <span className={styles.count}>{summary.groups.length}</span>
          <div className="grow" style={{ flex: 1 }} />
          <Link className="btn sm ghost" href="/proxy-groups">
            去策略组模块
          </Link>
        </div>
        {summary.groups.length === 0 ? (
          <p className={styles.empty}>没有策略组引用这个节点。</p>
        ) : (
          summary.groups.map((g) => (
            <div key={g.id} className={styles.row}>
              <span className="mono">{g.name}</span>
              <span className={styles.dim}>
                {g.type} · {(g.proxies ?? []).join(', ')}
              </span>
              {!g.managedShape && (
                <span className={`${styles.badge} ${styles.badgeWarn}`}>
                  已被手动改动,一键拆除将拒绝
                </span>
              )}
            </div>
          ))
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.sectionHead}>
          <span className="eyebrow">规则</span>
          <span className={styles.count}>{summary.rules.length}</span>
          <div className="grow" style={{ flex: 1 }} />
          <Link className="btn sm ghost" href="/scenarios/rule-anchor-append">
            去规则模块
          </Link>
        </div>
        {summary.rules.length === 0 ? (
          <p className={styles.empty}>没有规则指向 Tailscale 组——流量不会进 tailnet。</p>
        ) : (
          summary.rules.map((r) => (
            <div key={r.id} className={styles.row}>
              <span className="mono">
                {r.type},{r.value} → {r.policy}
              </span>
              <span className={styles.dim}>@{r.anchor}</span>
              {r.enabled === false && (
                <span className={`${styles.badge} ${styles.badgeWarn}`}>已停用</span>
              )}
            </div>
          ))
        )}
      </section>

      {incomplete && (
        <div className={styles.secNote}>
          检测到接入不完整（缺{!group ? '策略组' : ''}
          {!group && summary.rules.length === 0 ? '和' : ''}
          {summary.rules.length === 0 ? '规则' : ''}）。
          <button
            className="btn sm"
            style={{ marginLeft: 10 }}
            onClick={async () => {
              try {
                // enable 是 reconcile:节点已存在时只补缺失的组/规则,hostname 不会被用到。
                await runOp('enable', {
                  hostname: node.hostname ?? 'device',
                  nodeName: node.name,
                });
                toast('已补全缺失的产物。');
                await onChanged();
              } catch (err) {
                onError(err instanceof ApiError ? err.message : String(err));
              }
            }}
          >
            一键补全
          </button>
        </div>
      )}

      <p className={styles.hint}>
        首次访问 tailscale 节点超时是正常的——tsnet 懒加载,要先登录并拉取网络映射,稍等重试。
        用户态协议栈性能低于官方客户端,重流量场景（拷大文件）建议临时切官方客户端。
      </p>

      <div className={styles.dangerZone}>
        <button
          className="btn sm danger"
          disabled={teardownPending}
          onClick={async () => {
            if (
              !confirm(
                `确定拆除 Tailscale 接入？将删除节点「${node.name}」、策略组和相关规则。\n注意:撤销此操作只能恢复结构,auth-key 需重新填写。`,
              )
            ) {
              return;
            }
            setTeardownPending(true);
            try {
              await runOp('disable', { nodeName: node.name });
              toast('已拆除。可在操作历史中撤销（auth-key 需重填）。');
              await onChanged();
            } catch (err) {
              onError(err instanceof ApiError ? err.message : String(err));
            } finally {
              setTeardownPending(false);
            }
          }}
        >
          {teardownPending ? '…' : '一键拆除'}
        </button>
        <span className={styles.dim}>逆序删除规则 → 策略组 → 节点;有外部引用时会拒绝。</span>
      </div>
    </>
  );
}

function Kv({ k, v }: { k: string; v: string }) {
  return (
    <div className={styles.kv}>
      <span className={styles.kvK}>{k}</span>
      <span className={`${styles.kvV} mono`}>{v}</span>
    </div>
  );
}

/* ---------------- degraded (多节点) ---------------- */

function MultiNodeView({ nodes }: { nodes: TsNode[] }) {
  return (
    <>
      <div className={styles.secNote}>
        检测到 {nodes.length} 个 tailscale 节点。本页的一键管理只支持单节点形态,多节点请直接到{' '}
        <Link href="/base">/base</Link> 手动维护。
      </div>
      <section className={styles.card}>
        {nodes.map((n) => (
          <div key={n.name} className={styles.row}>
            <span className="mono">{n.name}</span>
            <span className={styles.dim}>
              hostname {n.hostname ?? '—'} · {n.hasAuthKey ? 'auth-key 已配置' : '无 auth-key'}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}
