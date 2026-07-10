'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '@/components/ui/Toast';

/**
 * 分发抽屉(原型 js/v2.js 的 distribute 模块) —— 单订阅 / 聚合订阅的公开
 * 节点链接集中在这里查看与复制,列表里绝不明文展示令牌。令牌默认掩码,
 * 点「显示」才露出;「复制」始终复制真实链接,无需先暴露。
 *
 * 与原型的差异(现实约束,如实呈现而非假装):
 *   - 令牌是平台级 SUB_TOKEN(与配置文件订阅链接共用),没有按资源重置 ——
 *     抽屉底部的警示句说清楚轮换方式,不放一个做不到的「重置令牌」按钮。
 *   - 格式目前只有 Clash provider YAML(mihomo proxy-provider / 普通订阅
 *     都能直接用),格式 chips 只渲染真实可用的那一个。
 *   - 访问开关即资源本身的「启用」开关:停用 = 链接对外 404(未分发)。
 */

export interface DistributeTarget {
  /** 路径段:single → /source/{pathSeg},collection → /collection/{pathSeg}。 */
  kind: 'source' | 'collection';
  /** 展示名(可中文 / 显示名)—— 仅用于抽屉标题,不进 URL。 */
  name: string;
  /** URL 路径段(订阅 slug / 聚合 slug)—— 稳定英文标识,与展示名解耦。 */
  pathSeg: string;
  /** 头部副标题,如「远程订阅 · 公开分发中」。 */
  typeLabel: string;
  enabled: boolean;
  /** dist-meta 行(键值对,值已格式化)。 */
  meta?: { k: string; v: string }[];
}

// 不带 tk_ 前缀 —— 真实令牌(SUB_TOKEN)没有固定前缀,掩码不该暗示形状。
const MASK = '••••••••';

export function DistributeDrawer({
  target,
  subBase,
  onClose,
  onToggleEnabled,
  pending = false,
}: {
  /** null = 关闭。 */
  target: DistributeTarget | null;
  /** meta.subBase:`{origin}/api/sub/{token}`;未加载到时传 null,抽屉显示占位。 */
  subBase: string | null;
  onClose: () => void;
  /** 翻转资源的启用状态(= 公开访问开关)。 */
  onToggleEnabled?: (next: boolean) => void;
  /** P2-9: 该资源的翻转请求进行中 —— 禁用开关,避免连点造成两次 PATCH 抵消。 */
  pending?: boolean;
}) {
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  // 原型同款入场:先以关闭态挂载,下一帧加 .open 触发滑入过渡。
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!target) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => {
      cancelAnimationFrame(raf);
      setShown(false);
    };
  }, [target]);

  // 每次换目标都回到掩码态 —— 上一个资源点过「显示」不应外溢到下一个。
  useEffect(() => {
    setReveal(false);
  }, [target?.kind, target?.pathSeg]);

  useEffect(() => {
    if (!target) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  const { realUrl, shownUrl } = useMemo(() => {
    if (!target) return { realUrl: '', shownUrl: '' };
    const path = `/${target.kind}/${encodeURIComponent(target.pathSeg)}`;
    if (!subBase) return { realUrl: '', shownUrl: `…/api/sub/${MASK}${path}` };
    const real = `${subBase}${path}`;
    if (reveal) return { realUrl: real, shownUrl: real };
    // subBase 形如 {origin}/api/sub/{token} —— 掩掉最后一段令牌。
    const cut = subBase.lastIndexOf('/');
    return { realUrl: real, shownUrl: `${subBase.slice(0, cut)}/${MASK}${path}` };
  }, [target, subBase, reveal]);

  async function copy() {
    if (!realUrl) return;
    try {
      await navigator.clipboard.writeText(realUrl);
      toast('已复制公开节点链接 · 可直接拿去其它客户端订阅');
    } catch {
      toast('复制失败 · 请点「显示」后手动选取');
    }
  }

  if (!target) return null;

  // Portal 到 body:内容区祖先(.pm-reveal 等)带 transform,会把
  // position:fixed 钉进自己的盒子里 —— 原型也是 append 到 document.body。
  return createPortal(
    <div
      className={`dist-bg${shown ? ' open' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="dist" role="dialog" aria-modal="true" aria-label="分发设置">
        <header className="dist-head">
          <div className="dh-id">
            <span className="dh-ic">{target.kind === 'collection' ? '⊕' : '⇅'}</span>
            <div>
              <b>{target.name}</b>
              <span className="dh-type">{target.typeLabel}</span>
            </div>
          </div>
          <button type="button" className="dist-x" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="dist-access">
          <div>
            <b>公开访问</b>
            <span className="da-sub">
              {target.enabled
                ? '开启中 · 任何持链接者都可订阅这组节点'
                : '已停用 · 此链接当前对外 404'}
            </span>
          </div>
          <button
            type="button"
            className="switch"
            aria-label="公开访问开关"
            aria-pressed={target.enabled}
            disabled={!onToggleEnabled || pending}
            onClick={() => onToggleEnabled?.(!target.enabled)}
          />
        </div>

        <div className={`dist-body${target.enabled ? '' : ' off'}`}>
          {/* P3-41: 去孤儿类 dist-fld(无 CSS 定义,纯 no-op 包裹) */}
          <div>
            <div className="df-cap">
              输出格式<span className="df-h">provider YAML · 只含节点</span>
            </div>
            <div className="dist-fmts">
              <button type="button" className="on">
                Clash / mihomo
              </button>
            </div>
          </div>

          {/* P3-41: 去孤儿类 dist-fld(无 CSS 定义,纯 no-op 包裹) */}
          <div>
            <div className="df-cap">
              公开节点链接
              <span className="df-h">
                {target.kind === 'collection'
                  ? '成员合并去重后下发 · 换成员不影响链接'
                  : '客户端填这一条 · 上游源站永不暴露'}
              </span>
            </div>
            <div className="dist-url">
              <code>{shownUrl}</code>
              <button
                type="button"
                className="urlbtn"
                onClick={() => setReveal((v) => !v)}
                title="显示 / 隐藏令牌"
              >
                {reveal ? '隐藏' : '显示'}
              </button>
            </div>
            <div className="dist-acts">
              <button type="button" className="btn primary sm" onClick={copy} disabled={!realUrl}>
                复制链接
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() => realUrl && window.open(realUrl, '_blank', 'noopener')}
                disabled={!realUrl}
              >
                打开
              </button>
            </div>
            <p className="df-h" style={{ marginTop: 10 }}>
              可直接作 mihomo <code>proxy-providers</code> 的 <code>url:</code>,或当普通订阅导入 ——
              节点已过本源的节点处理。
            </p>
          </div>

          {target.meta && target.meta.length > 0 && (
            <div className="dist-meta">
              {target.meta.map((m) => (
                <span key={m.k}>
                  <i>{m.k}</i>
                  {m.v}
                </span>
              ))}
            </div>
          )}

          <p className="dist-warn">
            <span>⚠</span>
            <span>
              令牌即访问凭证 —— 它是这条链接里唯一的秘钥,与配置文件订阅链接共用(平台级
              SUB_TOKEN)。怀疑泄露就在部署环境更换 SUB_TOKEN,所有分发链接随之轮换、旧链接立即失效。
            </span>
          </p>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
