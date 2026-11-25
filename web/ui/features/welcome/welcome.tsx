'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CircleCheck,
  FileCode2,
  Layers,
  ListTree,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { DataView } from '@/ui/agent';
import { api, ApiError, errorMessage, request } from '@/ui/data/api';
import { keys, useSetupStatus } from '@/ui/data/hooks';
import { invalidate, setQueryData } from '@/ui/data/query';
import type { Profile, SetupApiStatus, SetupBootstrapApiResponse } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { Badge, Button, Skeleton, notify } from '@/ui/primitives';
import { BootScreen } from '@/ui/shell/gates';
import { groupTypeMeta } from '@/ui/viz/lines';
import { Wordmark } from '@/ui/viz/logo';
import { RouteArt } from '@/ui/viz/route-art';

/** Plain-language versions of the setup reason codes (server messages are English). */
const DIAGNOSTIC_COPY: Record<string, string> = {
  config_version_invalid: '配置版本记录损坏。',
  storage_type_invalid: '有记录的存储类型不符合预期。',
  profile_schema_invalid: '有配置文件记录无法安全解析。',
  multiple_default_profiles: '有不止一个配置文件叫 default。',
  default_profile_missing: '已有配置文件，但找不到唯一的 default。',
  base_record_incomplete: '基础配置只存在一半（内容或元数据缺失）。',
  base_record_invalid: '基础配置记录无法安全解析。',
  proxy_group_schema_invalid: '有策略组记录无法安全解析。',
  proxy_groups_storage_type_invalid: '策略组记录的存储类型不符合预期。',
  rule_schema_invalid: '有规则记录无法安全解析。',
  rules_storage_type_invalid: '规则记录的存储类型不符合预期。',
  partial_resources_present: '已经存在部分配置内容，初始化不会覆盖它们。',
  profile_source_not_unbound: '未完成的 default 已经绑定了节点来源。',
  provenance_record_invalid: '初始化来源记录损坏。',
  orphaned_setup_provenance: '有初始化记录，但没有对应的完整配置文件。',
  base_missing: 'default 配置文件在，但基础配置、策略组和规则都是空的，可以安全补全。',
  already_configured: 'default 已经有完整的基础配置。',
};

const COMPONENT_LABEL: Record<string, string> = {
  profile: '配置文件',
  base: '基础配置',
  'proxy-groups': '策略组',
  rules: '规则',
  storage: '存储',
  provenance: '初始化记录',
};

interface WorkspaceBootstrap {
  status: SetupApiStatus;
  profiles: Profile[];
}

export function WelcomePage() {
  const router = useRouter();
  const status = useSetupStatus();
  const [result, setResult] = useState<SetupBootstrapApiResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = status.data?.state === 'configured' && !result;

  useEffect(() => {
    if (configured) router.replace('/');
  }, [configured, router]);

  const bootstrap = async (current: SetupApiStatus) => {
    setBusy(true);
    try {
      const done = await api.post<SetupBootstrapApiResponse>('/setup/bootstrap', {
        expected_revision: current.revision,
        starter_version: current.starter_version,
      });
      setResult(done);
      invalidate('workspace-bootstrap', keys.profiles, keys.setup);
      // Prime the shell gate with the configured state so "进入" doesn't bounce back here.
      const fresh = await request<{ data: WorkspaceBootstrap }>('/bootstrap').catch(() => null);
      if (fresh) {
        setQueryData('workspace-bootstrap', fresh.data);
        setQueryData(keys.profiles, fresh.data.profiles);
        setQueryData(keys.setup, fresh.data.status);
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 412)) {
        notify.warn('状态刚刚变化了', '已重新检查，请确认后再试。');
        void status.refetch();
      } else {
        notify.error(error, '初始化失败');
      }
    } finally {
      setBusy(false);
    }
  };

  if (configured) return <BootScreen label="正在进入" />;

  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1fr_1.05fr]">
      <title>欢迎 · ProxyManager</title>
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Wordmark />
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[460px]">
            {result ? (
              <Success result={result} onGo={(href) => router.push(href)} />
            ) : status.error && !status.data ? (
              <div className="flex flex-col items-start gap-3">
                <TriangleAlert size={20} className="text-bad" />
                <h1 className="text-lg font-semibold text-ink">无法读取初始化状态</h1>
                <p className="text-sm text-ink-2">{errorMessage(status.error)}</p>
                <Button icon={RefreshCw} loading={status.isValidating} onClick={() => void status.refetch()}>
                  重试
                </Button>
              </div>
            ) : !status.data ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-4 w-72" />
                <Skeleton className="mt-4 h-56 rounded-xl" />
              </div>
            ) : (
              <SetupView status={status.data} busy={busy} onBootstrap={() => void bootstrap(status.data!)} onRecheck={() => void status.refetch()} rechecking={status.isValidating} />
            )}
          </div>
        </div>
        <p className="text-center text-[11px] text-ink-4">ProxyManager · 自部署的 Clash / Mihomo 配置管理</p>
      </div>
      <div className="relative hidden overflow-hidden border-l border-line bg-panel lg:block">
        <div className="absolute inset-0 dot-grid opacity-60" />
        <RouteArt className="absolute inset-0" />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-panel via-panel/90 to-transparent p-10 pt-24">
          <p className="font-display text-[44px] italic leading-[1.05] tracking-tight text-ink">
            First stop,
            <br />
            a working config.
          </p>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-2">
            先铺一条最简单、一定能用的线路，再慢慢接上订阅源、策略组和规则。每一步保存前都会预演最终配置。
          </p>
        </div>
      </div>
    </div>
  );
}

function SetupView({
  status,
  busy,
  onBootstrap,
  onRecheck,
  rechecking,
}: {
  status: SetupApiStatus;
  busy: boolean;
  onBootstrap: () => void;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const s = status.starter;
  const diagnostics = status.diagnostics.filter((d) => d.code !== 'already_configured');
  const heading =
    status.state === 'empty' ? '欢迎，先铺好第一条线路' : status.state === 'recoverable' ? '上次初始化没有完成' : '需要先手动修复';
  const intro =
    status.state === 'empty'
      ? '工作区还是空的。初始化会创建一份最小、可以直接使用的配置文件，之后都能随时修改。'
      : status.state === 'recoverable'
        ? '检查到一份不完整的 default 配置文件，可以安全地把缺的部分补上，已有内容不会被覆盖。'
        : '存储里有无法安全识别的数据。为了不覆盖它们，初始化已停止。';

  const starter = [
    { icon: Layers, title: <>配置文件 <span className="font-mono">{s.profile_name}</span></>, detail: '暂不绑定节点来源，稍后再添加订阅源' },
    {
      icon: RadioTower,
      title: `${s.proxy_groups.length} 个策略组`,
      detail: s.proxy_groups.map((g) => `${g.name}（${groupTypeMeta(g.type).label}）`).join('、'),
    },
    { icon: ListTree, title: '1 条兜底规则', detail: <span className="font-mono">{s.final_rule}</span> },
    {
      icon: FileCode2,
      title: '精简的基础配置',
      detail: `不开启 DNS / TUN / 嗅探，端口由客户端管理，mode: ${s.mode}`,
    },
  ];

  return (
    <div className="flex animate-rise flex-col gap-6">
      <DataView
        label="工作区初始化状态"
        summary={`${status.state}${diagnostics.length ? ` · ${diagnostics.length} 项诊断` : ''}`}
        items={[
          { value: 'state', label: `状态: ${status.state} · 可初始化: ${status.can_bootstrap ? '是' : '否'}` },
          ...diagnostics.map((d) => ({
            value: d.code,
            label: `${COMPONENT_LABEL[d.component] ?? d.component} · ${DIAGNOSTIC_COPY[d.code] ?? d.message}`,
          })),
        ]}
      >
        <div>
          {status.state !== 'empty' && (
            <Badge tone={status.state === 'blocked' ? 'bad' : 'warn'} icon={status.state === 'blocked' ? ShieldAlert : Wrench} className="mb-3">
              {status.state === 'blocked' ? '已阻止' : '可以补全'}
            </Badge>
          )}
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">{heading}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{intro}</p>
        </div>

        {diagnostics.length > 0 && (
          <ul className="mt-4 flex flex-col gap-2">
            {diagnostics.map((d) => (
              <li
                key={d.code}
                className={cn(
                  'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
                  d.repairable ? 'border-warn/25 bg-warn-soft/70' : 'border-bad/20 bg-bad-soft/70',
                )}
              >
                {d.repairable ? <Wrench size={14} className="mt-0.5 shrink-0 text-warn" /> : <ShieldAlert size={14} className="mt-0.5 shrink-0 text-bad" />}
                <div className="min-w-0">
                  <div className="text-ink">{DIAGNOSTIC_COPY[d.code] ?? d.message}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-ink-3">
                    {COMPONENT_LABEL[d.component] ?? d.component} · {d.code} · {d.repairable ? '可自动补全' : '需手动处理'}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataView>

      {status.can_bootstrap ? (
        <>
          <div className="rounded-xl border border-line bg-surface shadow-xs">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-xs font-medium text-ink-2">
              <Sparkles size={13} className="text-accent" />
              将会创建
            </div>
            <ul className="divide-y divide-line">
              {starter.map((item, index) => (
                <li key={index} className="flex items-start gap-3 px-4 py-3">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-2">
                    <item.icon size={14} strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink">{item.title}</span>
                    <span className="block text-xs leading-relaxed text-ink-3">{item.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              trailingIcon={ArrowRight}
              data-agent-confirm={
                status.state === 'recoverable'
                  ? '补全 default 配置文件的初始化内容'
                  : '初始化工作区并创建默认配置文件 default'
              }
              onClick={onBootstrap}
              className="w-full"
            >
              {status.state === 'recoverable' ? '补全初始化' : '初始化'}
            </Button>
            <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-3">
              <ShieldCheck size={14} className="mt-0.5 shrink-0" />
              只会新建上面列出的内容，不会改动已有数据。写入前会先预演最终配置。
            </p>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-sm leading-relaxed text-ink-2 shadow-xs">
          <p>
            请检查 Redis 里的配置数据：修复或删除上面提到的记录，或从备份恢复。处理完后点「重新检查」，状态正常就能继续。
          </p>
          <Button icon={RefreshCw} loading={rechecking} onClick={onRecheck} className="self-start">
            重新检查
          </Button>
        </div>
      )}
    </div>
  );
}

function Success({ result, onGo }: { result: SetupBootstrapApiResponse; onGo: (href: string) => void }) {
  return (
    <div className="flex animate-rise flex-col gap-6">
      <span className="flex size-12 animate-pop items-center justify-center rounded-2xl border border-ok/25 bg-ok-soft text-ok">
        <CircleCheck size={22} />
      </span>
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">线路已经铺好</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          {result.created ? '已创建' : '已补全'}配置文件 <span className="font-mono text-ink">{result.profile.name}</span>：
          {result.resources.proxy_group_ids.length} 个策略组、{result.resources.rule_ids.length} 条兜底规则，最终配置可以正常渲染。现在它还没有节点，下一步接上订阅源。
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="primary" size="lg" icon={RadioTower} onClick={() => onGo('/sources?new=1')} className="flex-1">
          添加第一个订阅源
        </Button>
        <Button size="lg" trailingIcon={ArrowRight} onClick={() => onGo('/')} className="flex-1">
          进入总览
        </Button>
      </div>
    </div>
  );
}
