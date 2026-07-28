'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/client/api';
import { clearAdminKey } from '@/lib/client/auth-storage';
import {
  encodeSetupDraft,
  restoreSetupDraft,
  SETUP_DRAFT_KEY,
  setupCanRun,
  setupNeedsRepair,
  STARTER_SUMMARY,
  type SetupDraftStep,
} from '@/lib/client/setup';
import { useSetup } from '@/components/setup/SetupContext';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import type { SetupApiStatus, SetupBootstrapApiResponse, SetupDiagnostic } from '@/schemas/setup';
import styles from '@/app/(authed)/setup/setup.module.css';

const DIAGNOSTIC_COPY: Record<string, { title: string; detail: string }> = {
  default_profile_missing: {
    title: '缺少 default 配置文件',
    detail: '已有其他配置，系统不会自动创建一个并列的 default。',
  },
  starter_profile_id_conflict: {
    title: 'starter 标识已被占用',
    detail: '现有配置与 starter 标识冲突，需要先人工检查。',
  },
  base_missing: {
    title: '缺少基础配置',
    detail: 'default 尚无可渲染的 base 配置。',
  },
  base_record_incomplete: {
    title: '基础配置记录不完整',
    detail: '只存在部分 base 记录，自动初始化不会覆盖它。',
  },
  proxy_groups_missing: {
    title: '缺少代理策略',
    detail: '当前还没有托管策略组。',
  },
  rules_missing: {
    title: '缺少分流规则',
    detail: '当前还没有托管规则。',
  },
};

export function SetupWizard() {
  const { status, loading, error, initializing, refresh, bootstrap } = useSetup();
  const [step, setStep] = useState<SetupDraftStep>('welcome');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [completion, setCompletion] = useState<SetupBootstrapApiResponse | null>(null);
  const [uncertainConfigured, setUncertainConfigured] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const submitLock = useRef(false);

  const submitting = initializing || confirming;

  useEffect(() => {
    if (!status || status.state === 'configured' || draftLoaded) return;
    const restored = restoreSetupDraft(sessionStorage.getItem(SETUP_DRAFT_KEY), status);
    setStep(restored.step);
    setDraftLoaded(true);
  }, [draftLoaded, status]);

  useEffect(() => {
    if (!status) return;
    if (status.state === 'configured') {
      sessionStorage.removeItem(SETUP_DRAFT_KEY);
      return;
    }
    if (!draftLoaded) return;
    sessionStorage.setItem(SETUP_DRAFT_KEY, encodeSetupDraft(step, status));
  }, [draftLoaded, status, step]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step, completion, uncertainConfigured, status?.state, error]);

  function continueToReview() {
    setActionError(null);
    setStep('review');
  }

  async function initialize() {
    if (!status || !setupCanRun(status) || submitting || submitLock.current) return;
    submitLock.current = true;
    setActionError(null);
    const request = {
      expected_revision: status.revision,
      starter_version: status.starter_version,
    } as const;
    try {
      const result = await bootstrap(request);
      setCompletion(result);
      document.cookie = `pm.active_profile=${encodeURIComponent(result.profile.name)}; path=/; max-age=31536000; SameSite=Lax`;
      sessionStorage.removeItem(SETUP_DRAFT_KEY);
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      setConfirming(true);
      const checked = await refresh();
      setConfirming(false);
      if (checked?.state === 'configured') {
        setUncertainConfigured(true);
        sessionStorage.removeItem(SETUP_DRAFT_KEY);
        return;
      }
      if (apiError?.status === 412) {
        setActionError(
          checked
            ? `实例版本已更新为 ${checked.revision}。请核对当前状态后重试。`
            : '实例版本已经变化，但状态刷新失败。请重新检查。',
        );
      } else if (apiError?.status === 409) {
        setActionError('实例状态已经变化，已重新检查。请确认当前状态后再继续。');
      } else if (apiError?.status === 422) {
        setActionError(`请求未通过字段或最终配置校验，尚未写入。${apiError.message}`);
      } else if (apiError?.status === 503) {
        setActionError('验证服务暂时不可用，尚未确认写入结果。请稍后重试。');
      } else if (apiError) {
        setActionError(`初始化请求未完成，尚未确认写入。${apiError.message}`);
      } else {
        setActionError(
          '连接在初始化期间中断，已经重新检查实例状态。当前没有确认完成，请保留本页并重试。',
        );
      }
    } finally {
      submitLock.current = false;
    }
  }

  function signOut() {
    clearAdminKey();
    window.location.href = '/login';
  }

  if (loading && !status) {
    return <SetupLoading />;
  }

  if (error && !status) {
    return (
      <SetupScaffold current={1} title="检查">
        <div className={styles.content} role="alert">
          <div className={styles.eyebrow}>状态检查失败</div>
          <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
            无法读取实例状态
          </h1>
          <p className={styles.lede}>尚未执行任何写入。保留当前页面，重新检查后再继续。</p>
          <div className={styles.error}>{error}</div>
        </div>
        <div className={styles.actions}>
          <button type="button" className="btn primary" onClick={() => void refresh()}>
            重新检查
          </button>
          <button type="button" className="btn" onClick={signOut}>
            退出登录
          </button>
        </div>
      </SetupScaffold>
    );
  }

  if (!status) return <SetupLoading />;

  if (completion) {
    return <SetupComplete receipt={completion} headingRef={headingRef} />;
  }

  if (uncertainConfigured) {
    return <UncertainConfigured headingRef={headingRef} />;
  }

  if (status.state === 'configured') {
    return <AlreadyConfigured status={status} headingRef={headingRef} />;
  }

  if (status.state === 'blocked') {
    return (
      <BlockedSetup
        status={status}
        headingRef={headingRef}
        onRetry={refresh}
        refreshError={error}
      />
    );
  }

  if (step === 'review') {
    return (
      <SetupScaffold current={2} title="确认 starter">
        <div className={styles.content} aria-busy={submitting || undefined}>
          <div className={styles.eyebrow}>安全默认 · {blueprintLabel(status)}</div>
          <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
            确认将要创建的 starter
          </h1>
          <p className={styles.lede}>
            后端会先验证完整候选，再以一次原子提交写入。页面不会发送任意 YAML，也不会创建订阅源。
          </p>
          <StarterSummary />
          {error && (
            <div className={styles.error} role="alert">
              <strong>状态复核失败</strong>
              {error}
            </div>
          )}
          {actionError && (
            <div className={styles.error} role="alert">
              <strong>初始化没有确认完成</strong>
              {actionError}
            </div>
          )}
          <p className={`${styles.callout} ${setupNeedsRepair(status) ? styles.calloutWarn : ''}`}>
            {setupNeedsRepair(status)
              ? '检测到可安全恢复的 default：只有 profile 存在，base、策略组与规则均为空。本次只补齐缺少内容。'
              : '检测到全新实例。本次会创建 default、基础配置、2 个代理策略和 1 条 MATCH 兜底规则。'}
          </p>
          <div className="sr-only" aria-live="polite">
            {confirming
              ? '正在确认初始化结果'
              : initializing
                ? '正在初始化，请稍候'
                : (actionError ?? '')}
          </div>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className="btn"
            disabled={submitting}
            onClick={() => {
              setActionError(null);
              setStep('welcome');
            }}
          >
            返回
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={submitting}
            aria-busy={submitting}
            onClick={() => void initialize()}
          >
            {confirming
              ? '正在确认结果'
              : initializing
                ? '正在初始化'
                : setupNeedsRepair(status)
                  ? '安全补齐 starter'
                  : '创建 starter'}
          </button>
          <span className={styles.actionHint}>
            不写入监听端口，也不会开启 DNS、TUN 或局域网访问
          </span>
        </div>
      </SetupScaffold>
    );
  }

  return (
    <SetupScaffold current={1} title="检查">
      <div className={styles.content}>
        <div className={styles.eyebrow}>首次部署 · {blueprintLabel(status)}</div>
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          先建立一份能安全渲染的最小配置
        </h1>
        <p className={styles.lede}>
          ProxyManager
          已读取真实存储状态。向导只创建路由与策略所需的最小骨架，监听端口由代理客户端管理。
        </p>
        <div className={styles.statusList} aria-label="实例检查结果">
          <StatusRow
            label="Redis 与配置版本"
            detail={`已读取稳定快照，版本 ${status.revision}`}
            tone="ok"
          />
          <StatusRow
            label="default 配置文件"
            detail={
              status.inventory.default_profile_id
                ? '已存在，可安全补齐'
                : '尚不存在，将由 starter 创建'
            }
            tone="ok"
          />
          <StatusRow
            label="监听端口"
            detail="交由代理客户端管理，starter 不写入 port、socks-port 或 mixed-port"
            tone="ok"
          />
          <StatusRow label="写入边界" detail="不覆盖现有配置，不创建订阅源" tone="ok" />
        </div>
        {setupNeedsRepair(status) && (
          <p className={`${styles.callout} ${styles.calloutWarn}`}>
            上次初始化可能在写入前中断。检测到的部分状态满足受控恢复条件，可以继续补齐。
          </p>
        )}
        {error && (
          <div className={styles.error} role="alert">
            <strong>最近一次状态检查失败</strong>
            {error}
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <button type="button" className="btn primary" onClick={continueToReview}>
          查看安全默认
        </button>
        <span className={styles.actionHint}>下一步只做确认，不会立即写入</span>
      </div>
    </SetupScaffold>
  );
}

export function StarterSummary() {
  const s = STARTER_SUMMARY;
  return (
    <div className={styles.summary} data-testid="starter-summary">
      <section className={styles.summarySection}>
        <h2>基础运行参数</h2>
        <dl className={styles.keyValues}>
          <KeyValue label="配置文件" value={s.profileName} />
          <KeyValue label="监听端口" value="由代理客户端管理，starter 不写入" />
          <KeyValue label="运行模式" value={s.mode} />
          <KeyValue label="allow-lan" value={s.allowLan ? 'true，开启' : 'false，关闭'} />
          <KeyValue label="log-level" value={s.logLevel} />
        </dl>
      </section>
      <section className={styles.summarySection}>
        <h2>代理策略与兜底</h2>
        <dl className={styles.keyValues}>
          <KeyValue
            label={`${s.autoGroup.name} · ${s.autoGroup.type}`}
            value={`自动纳入订阅节点，空节点回落 ${s.autoGroup.fallback}`}
          />
          <KeyValue
            label={`${s.defaultGroup.name} · ${s.defaultGroup.type}`}
            value={s.defaultGroup.members.join(' → ')}
          />
          <KeyValue label="最终规则" value={s.finalRule} />
        </dl>
      </section>
      <section className={styles.summarySection}>
        <h2>默认不启用</h2>
        <dl className={styles.keyValues}>
          <KeyValue label="高级模块" value={s.disabledByDefault.join('、')} />
          <KeyValue label="节点来源" value="none，初始化后再绑定" />
        </dl>
      </section>
    </div>
  );
}

function AlreadyConfigured({
  status,
  headingRef,
}: {
  status: SetupApiStatus;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <SetupScaffold current={3} title="已配置">
      <div className={styles.content}>
        <div className={styles.eyebrow}>现有配置已保留</div>
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          实例已经完成基础配置
        </h1>
        <p className={styles.lede}>
          首次设置不会覆盖现有 base，也不会补写 starter 策略或规则。你可以直接返回工作台。
        </p>
        <Inventory status={status} />
      </div>
      <div className={styles.actions}>
        <Link className="btn primary" href="/" onClick={hardNavigate}>
          返回概览
        </Link>
        <Link className="btn" href="/config" onClick={hardNavigate}>
          查看配置预览
        </Link>
      </div>
    </SetupScaffold>
  );
}

function SetupComplete({
  receipt,
  headingRef,
}: {
  receipt: SetupBootstrapApiResponse;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <SetupScaffold current={3} title="完成">
      <div className={styles.content} aria-live="polite">
        <div className={styles.successMark} aria-hidden="true">
          ✓
        </div>
        <div className={styles.eyebrow}>原子初始化已确认</div>
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          {receipt.provenance.created ? 'starter 已创建' : 'starter 已安全补齐'}
        </h1>
        <p className={styles.lede}>
          成功响应确认配置可以渲染，节点来源尚未绑定，配置分发入口已经可用。
        </p>
        <div className={styles.statusList} aria-label="本次初始化资源">
          <StatusRow
            label="default profile"
            detail={`id ${receipt.provenance.profile_id.slice(0, 8)}`}
            tone="ok"
          />
          <StatusRow
            label="starter"
            detail={`${receipt.provenance.starter_version} · 监听端口由客户端管理`}
            tone="ok"
          />
          <StatusRow
            label="提交版本"
            detail={String(receipt.provenance.completed_revision)}
            tone="ok"
          />
          <StatusRow label="base etag" detail={receipt.resources.base_etag} tone="ok" />
          <StatusRow label="build id" detail={receipt.resources.build_id} tone="ok" />
          <StatusRow
            label="托管资源"
            detail={`${receipt.resources.proxy_group_ids.length} 个策略组，${receipt.resources.rule_ids.length} 条规则`}
            tone="ok"
          />
          <StatusRow
            label="readiness"
            detail={
              receipt.readiness.config_renderable &&
              receipt.readiness.distribution_available &&
              receipt.readiness.source === 'unbound'
                ? '可渲染 · 可分发 · 节点未绑定'
                : '请检查响应状态'
            }
            tone="ok"
          />
        </div>
      </div>
      <div className={styles.actions}>
        <Link className="btn primary" href="/subscriptions" onClick={hardNavigate}>
          添加节点订阅
        </Link>
        <Link className="btn" href="/" onClick={hardNavigate}>
          先看概览
        </Link>
        <Link className="btn ghost" href="/config" onClick={hardNavigate}>
          查看配置预览
        </Link>
      </div>
    </SetupScaffold>
  );
}

function UncertainConfigured({
  headingRef,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <SetupScaffold current={3} title="已配置">
      <div className={styles.content} role="status" aria-live="polite">
        <div className={styles.eyebrow}>初始化结果需要确认</div>
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          实例已配置
        </h1>
        <p className={styles.lede}>
          初始化请求期间连接中断，重新检查只能确认实例现在已有配置，不能证明本标签页的 starter
          请求获胜。页面不会据此宣称 starter 或 DIRECT 兜底已经创建。
        </p>
        <p className={`${styles.callout} ${styles.calloutWarn}`}>
          现有配置已保留。请先查看配置预览，再决定下一步。
        </p>
      </div>
      <div className={styles.actions}>
        <Link className="btn primary" href="/config" onClick={hardNavigate}>
          检查配置预览
        </Link>
        <Link className="btn" href="/" onClick={hardNavigate}>
          返回概览
        </Link>
      </div>
    </SetupScaffold>
  );
}

function BlockedSetup({
  status,
  headingRef,
  onRetry,
  refreshError,
}: {
  status: SetupApiStatus;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onRetry: () => Promise<SetupApiStatus | null>;
  refreshError: string | null;
}) {
  return (
    <SetupScaffold current={1} title="需要检查">
      <div className={styles.content} role="alert">
        <div className={styles.eyebrow}>检测到已有部分数据</div>
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          自动初始化已暂停
        </h1>
        <p className={styles.lede}>
          继续操作可能覆盖用户已有内容，因此向导不会猜测如何修复。请先检查以下状态。
        </p>
        <DiagnosticList diagnostics={status.diagnostics} />
        {refreshError && (
          <div className={styles.error} role="alert">
            <strong>重新检测失败</strong>
            {refreshError}
          </div>
        )}
        <p className={`${styles.callout} ${styles.calloutWarn}`}>
          当前没有执行任何写入。修复现有数据后，可以在此重新检测。
        </p>
      </div>
      <div className={styles.actions}>
        <button type="button" className="btn primary" onClick={() => void onRetry()}>
          重新检测
        </button>
        <button type="button" className="btn" onClick={() => history.back()}>
          返回上一页
        </button>
      </div>
    </SetupScaffold>
  );
}

function DiagnosticList({ diagnostics }: { diagnostics: SetupDiagnostic[] }) {
  return (
    <ul className={styles.diagnostics}>
      {diagnostics.map((item) => {
        const copy = DIAGNOSTIC_COPY[item.code];
        return (
          <li className={styles.diagnostic} key={`${item.component}:${item.code}`}>
            <strong>{copy?.title ?? item.code}</strong>
            <span>{copy?.detail ?? item.message}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Inventory({ status }: { status: SetupApiStatus }) {
  const profileId = status.inventory.default_profile_id;
  return (
    <div className={styles.statusList} aria-label="当前配置资源">
      <StatusRow
        label="default profile"
        detail={profileId ? `id ${profileId.slice(0, 8)}` : '已配置'}
        tone="ok"
      />
      <StatusRow
        label="基础配置"
        detail={status.inventory.has_base ? '存在' : '需要检查'}
        tone={status.inventory.has_base ? 'ok' : 'warn'}
      />
      <StatusRow
        label="托管资源"
        detail={`${status.inventory.proxy_groups_total} 个策略组，${status.inventory.rules_total} 条规则`}
        tone="ok"
      />
      <StatusRow
        label="节点来源"
        detail={status.inventory.source_type ?? '未确认'}
        tone={status.inventory.source_type === 'none' ? 'warn' : 'ok'}
      />
    </div>
  );
}

function StatusRow({
  label,
  detail,
  tone,
}: {
  label: string;
  detail: string;
  tone: 'ok' | 'warn' | 'idle';
}) {
  return (
    <div className={styles.statusRow}>
      <strong>{label}</strong>
      <span className={`pill ${tone}`}>{detail}</span>
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.keyValue}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SetupLoading() {
  return (
    <SetupScaffold current={1} title="检查">
      <div className={`${styles.content} ${styles.skeleton}`} role="status" aria-live="polite">
        <div className={styles.eyebrow}>正在检查真实存储状态</div>
        <span className={`pm-skeleton ${styles.skeletonLine}`} style={{ width: '58%' }} />
        <span className={`pm-skeleton ${styles.skeletonLine}`} style={{ width: '82%' }} />
        <span className={`pm-skeleton ${styles.skeletonBlock}`} />
        <span className="sr-only">正在读取 setup status</span>
      </div>
    </SetupScaffold>
  );
}

function SetupScaffold({
  current,
  title,
  children,
}: {
  current: 1 | 2 | 3;
  title: string;
  children: React.ReactNode;
}) {
  const labels = ['检查实例', '确认 starter', '完成'];
  return (
    <div className={styles.page}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className={styles.frame}>
        <header className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            PM
          </span>
          <div className={styles.brandCopy}>
            <strong>ProxyManager</strong>
            <span>首次部署</span>
          </div>
          <div className={styles.theme}>
            <ThemeToggle />
          </div>
        </header>
        <ol className={styles.steps} aria-label="首次设置步骤">
          {labels.map((label, index) => {
            const n = (index + 1) as 1 | 2 | 3;
            return (
              <li
                key={label}
                className={`${styles.step} ${
                  n === current ? styles.stepCurrent : n < current ? styles.stepDone : ''
                }`}
                aria-current={n === current ? 'step' : undefined}
              >
                <span className={styles.stepNumber}>{n < current ? '✓' : n}</span>
                <span className={styles.stepLabel}>{label}</span>
              </li>
            );
          })}
        </ol>
        <div className={styles.mobileStep} aria-hidden="true">
          <span>步骤 {current} / 3</span>
          <strong>{title}</strong>
        </div>
        <main id="main-content" className={styles.main} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function blueprintLabel(status: SetupApiStatus): string {
  return status.starter_version;
}

function hardNavigate(event: React.MouseEvent<HTMLAnchorElement>) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.location.assign(event.currentTarget.href);
}
