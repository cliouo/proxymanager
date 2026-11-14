'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { ExternalLink, Eye, EyeOff, LogOut, Monitor, Moon, RefreshCw, Sun, TriangleAlert } from 'lucide-react';
import { api, ApiError, clearAdminKey, errorMessage, request } from '@/ui/data/api';
import { keys, useAssistantConfig, useMeta } from '@/ui/data/hooks';
import { clearQueries, setQueryData, useQuery } from '@/ui/data/query';
import type { AssistantConfig, AssistantConfigUpdate } from '@/ui/data/types';
import { cn } from '@/ui/lib/cn';
import { formatDuration, relativeTime } from '@/ui/lib/format';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  Field,
  Input,
  Kbd,
  SegmentedControl,
  Skeleton,
  StatusDot,
  Switch,
  notify,
} from '@/ui/primitives';
import { modKey, useHotkey } from '@/ui/shell/hotkeys';
import { Page, PageHeader, SaveBar } from '@/ui/shell/page';
import { useActiveProfile } from '@/ui/shell/scope';
import { Wordmark } from '@/ui/viz/logo';

/* ─── layout ─────────────────────────────────────────────────────────── */

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="grid scroll-mt-6 gap-x-10 gap-y-3 border-t border-line pt-7 md:grid-cols-[200px_minmax(0,1fr)]">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-ink-3">{description}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-ink-3">{hint}</div>}
      </div>
      <div className="min-w-0 shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const router = useRouter();

  // `/settings#assistant` — the page renders after the auth/setup gates, so scroll once mounted.
  useEffect(() => {
    const scroll = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' });
    };
    scroll();
    window.addEventListener('hashchange', scroll);
    return () => window.removeEventListener('hashchange', scroll);
  }, []);

  const logout = () => {
    clearAdminKey();
    clearQueries();
    router.replace('/login');
  };

  return (
    <Page width="narrow">
      <PageHeader title="设置" description="外观、AI 助手和连接信息。这些设置对所有配置文件生效。" />
      <div className="flex flex-col gap-10">
        <Section id="appearance" title="外观" description="只影响这台浏览器。">
          <Card className="divide-y divide-line">
            <ThemeRow />
          </Card>
        </Section>
        <Section
          id="assistant"
          title="AI 助手"
          description="用自然语言查看和修改配置。兼容 OpenAI 接口的模型都可以，默认是 DeepSeek。"
        >
          <AssistantSettings />
        </Section>
        <Section id="connection" title="连接信息" description="接入脚本、客户端或排查问题时需要的地址。">
          <ConnectionInfo />
        </Section>
        <Section id="shortcuts" title="快捷键" description="在输入框外按下即可。">
          <Shortcuts />
        </Section>
        <Section id="about" title="关于">
          <About />
        </Section>
        <Section id="session" title="登录" description="管理密钥只保存在这台浏览器里。">
          <Card>
            <Row label="退出登录" hint="清除本机保存的管理密钥和缓存数据，回到登录页。">
              <Button variant="danger-ghost" icon={LogOut} onClick={logout}>
                退出登录
              </Button>
            </Row>
          </Card>
        </Section>
      </div>
    </Page>
  );
}

/* ─── appearance ─────────────────────────────────────────────────────── */

function ThemeRow() {
  const { theme, setTheme } = useTheme();
  return (
    <Row label="主题" hint="跟随系统时，会随系统的浅色 / 深色模式自动切换。">
      <SegmentedControl
        value={(theme as 'light' | 'dark' | 'system' | undefined) ?? 'system'}
        onChange={setTheme}
        options={[
          { value: 'light', label: '浅色', icon: Sun },
          { value: 'dark', label: '深色', icon: Moon },
          { value: 'system', label: '跟随系统', icon: Monitor },
        ]}
      />
    </Row>
  );
}

/* ─── AI assistant ───────────────────────────────────────────────────── */

interface AssistantDraft {
  baseUrl: string;
  model: string;
  apiKey: string;
  thinking: 'enabled' | 'disabled';
  reasoningEffort: 'low' | 'medium' | 'high';
  maxTokens: string;
}

const ASSISTANT_DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  thinking: 'enabled' as const,
  reasoningEffort: 'high' as const,
  maxTokens: 8192,
};

function draftFrom(config: AssistantConfig | null): AssistantDraft {
  const source = config ?? ASSISTANT_DEFAULTS;
  return {
    baseUrl: source.baseUrl,
    model: source.model,
    apiKey: '',
    thinking: source.thinking,
    reasoningEffort: source.reasoningEffort,
    maxTokens: String(source.maxTokens),
  };
}

function AssistantSettings() {
  const query = useAssistantConfig();
  const config = query.data ?? null;
  const configured = !!config;
  const [draft, setDraft] = useState<AssistantDraft | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const stored = draftFrom(config);
  const form = draft ?? stored;
  const set = <K extends keyof AssistantDraft>(key: K, value: AssistantDraft[K]) =>
    setDraft((current) => ({ ...(current ?? stored), [key]: value }));

  const tokens = Number(form.maxTokens);
  const errors = {
    baseUrl: /^https?:\/\/\S+$/.test(form.baseUrl.trim()) ? null : '需要以 http:// 或 https:// 开头',
    model: form.model.trim() ? null : '请填写模型名',
    apiKey: !configured && !form.apiKey.trim() ? '首次配置需要填写 API Key' : null,
    maxTokens: Number.isInteger(tokens) && tokens >= 1 && tokens <= 65536 ? null : '1 – 65536 之间的整数',
  };
  const invalid = Object.values(errors).some(Boolean);
  const dirty =
    draft !== null &&
    (form.apiKey.trim() !== '' ||
      form.baseUrl.trim() !== stored.baseUrl ||
      form.model.trim() !== stored.model ||
      form.thinking !== stored.thinking ||
      form.reasoningEffort !== stored.reasoningEffort ||
      form.maxTokens.trim() !== stored.maxTokens ||
      !configured);

  const save = async () => {
    if (!dirty || invalid || saving) return;
    setSaving(true);
    try {
      const body: AssistantConfigUpdate = {
        baseUrl: form.baseUrl.trim().replace(/\/+$/, ''),
        model: form.model.trim(),
        thinking: form.thinking,
        reasoningEffort: form.reasoningEffort,
        maxTokens: tokens,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      const saved = await api.put<AssistantConfig>('/assistant/config', body);
      setQueryData(keys.assistantConfig, saved);
      setDraft(null);
      setRevealKey(false);
      notify.success(configured ? 'AI 助手设置已保存' : 'AI 助手已就绪', configured ? undefined : `按 ${modKey()} J 随时打开。`);
    } catch (error) {
      notify.error(error, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  useHotkey('mod+s', () => void save(), { enabled: dirty, allowInInput: true });

  if (query.isLoading) {
    return (
      <Card className="flex flex-col gap-4 p-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8 w-2/3" />
      </Card>
    );
  }
  if (query.error) {
    return (
      <Card className="flex items-center gap-3 px-4 py-3.5">
        <TriangleAlert size={16} className="shrink-0 text-bad" />
        <div className="min-w-0 flex-1 text-sm text-ink">
          读取 AI 助手设置失败
          <p className="text-xs text-ink-3">{errorMessage(query.error)}</p>
        </div>
        <Button size="sm" icon={RefreshCw} onClick={() => void query.refetch()}>
          重试
        </Button>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-xs">
          <StatusDot tone={configured ? 'ok' : 'idle'} />
          {configured ? (
            <span className="text-ink-2">
              已配置{config?.updated_at ? ` · ${relativeTime(config.updated_at)}更新` : ''}
            </span>
          ) : (
            <span className="text-ink-2">尚未配置 · 填好 API Key 并保存后即可使用</span>
          )}
        </div>
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <Field label="接口地址" error={draft ? errors.baseUrl : undefined} hint="OpenAI 兼容的 Base URL，不含 /chat/completions。">
            {(id) => (
              <Input id={id} mono value={form.baseUrl} invalid={!!draft && !!errors.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
            )}
          </Field>
          <Field label="模型" error={draft ? errors.model : undefined}>
            {(id) => <Input id={id} mono value={form.model} invalid={!!draft && !!errors.model} onChange={(e) => set('model', e.target.value)} />}
          </Field>
          <Field
            className="sm:col-span-2"
            label={
              <>
                API Key
                {configured && <Badge tone="ok">已保存</Badge>}
              </>
            }
            error={draft ? errors.apiKey : undefined}
            hint="密钥保存在服务器上。使用助手时，浏览器会取回它并直接调用模型接口。"
          >
            {(id) => (
              <Input
                id={id}
                mono
                type={revealKey ? 'text' : 'password'}
                autoComplete="off"
                value={form.apiKey}
                placeholder={configured ? '已保存 · 留空则保持不变' : 'sk-…'}
                onChange={(e) => set('apiKey', e.target.value)}
                trailing={
                  <button
                    type="button"
                    aria-label={revealKey ? '隐藏' : '显示'}
                    onClick={() => setRevealKey((v) => !v)}
                    className="flex size-6 items-center justify-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink"
                  >
                    {revealKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                }
              />
            )}
          </Field>
        </div>
        <div className="divide-y divide-line border-t border-line">
          <Row label="深度思考" hint="让模型先推理再回答，更准确但更慢。">
            <Switch
              label="深度思考"
              checked={form.thinking === 'enabled'}
              onCheckedChange={(on) => set('thinking', on ? 'enabled' : 'disabled')}
            />
          </Row>
          <Row label="思考强度" hint="开启深度思考时生效。">
            <SegmentedControl
              size="sm"
              value={form.reasoningEffort}
              onChange={(value) => set('reasoningEffort', value)}
              options={[
                { value: 'low', label: '低' },
                { value: 'medium', label: '中' },
                { value: 'high', label: '高' },
              ]}
            />
          </Row>
          <Row label="单次回复上限" hint={draft && errors.maxTokens ? <span className="text-bad">{errors.maxTokens}</span> : '每轮回复最多生成的 token 数。'}>
            <Input
              aria-label="单次回复上限"
              inputMode="numeric"
              className="w-28 text-right"
              mono
              value={form.maxTokens}
              invalid={!!draft && !!errors.maxTokens}
              onChange={(e) => set('maxTokens', e.target.value.replace(/[^\d]/g, ''))}
            />
          </Row>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-4 py-2.5">
          {draft && (
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)} disabled={saving}>
              放弃修改
            </Button>
          )}
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty || invalid} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </Card>
      <SaveBar visible={dirty} saving={saving} onSave={() => void save()} onDiscard={() => setDraft(null)} message="AI 助手设置有未保存的修改" />
    </>
  );
}

/* ─── connection ─────────────────────────────────────────────────────── */

interface Health {
  status: 'ok' | 'degraded';
  checks: { redis: { ok: boolean; error?: string } };
  uptime_seconds: number;
  timestamp: string;
  build_id: string | null;
}

async function fetchHealth(): Promise<Health> {
  try {
    return await request<Health>('/health');
  } catch (error) {
    // 503 still carries the full health document.
    if (error instanceof ApiError && error.raw && typeof error.raw === 'object' && 'checks' in error.raw) {
      return error.raw as Health;
    }
    throw error;
  }
}

export function useHealth() {
  return useQuery<Health>('settings:health', fetchHealth, { staleTime: 10_000 });
}

function ConnectionInfo() {
  const profile = useActiveProfile();
  const meta = useMeta(profile?.id ?? null);
  const health = useHealth();
  const [reveal, setReveal] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const apiBase = `${origin}/api/v1`;
  const subBase = meta.data?.subBase;
  const token = subBase?.split('/api/sub/')[1] ?? '';
  const masked = subBase && token ? subBase.replace(token, '•'.repeat(Math.min(12, Math.max(6, token.length)))) : subBase;
  const redisOk = health.data?.checks.redis.ok;

  return (
    <Card className="divide-y divide-line">
      <Row label="管理接口" hint="所有请求都带 Authorization: Bearer <管理密钥>。">
        <span className="flex items-center gap-1">
          <code className="truncate font-mono text-xs text-ink-2">{apiBase}</code>
          <CopyButton text={apiBase} label="复制接口地址" size="sm" />
        </span>
      </Row>
      <Row label="OpenAPI 文档" hint="完整的接口描述，公开可读，不含任何数据。">
        <Button asChild size="sm" trailingIcon={ExternalLink}>
          <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
            openapi.json
          </a>
        </Button>
      </Row>
      <Row
        label="订阅链接前缀"
        hint={
          <>
            加上 <span className="font-mono">/配置文件标识</span> 就是该配置文件的订阅链接。中间一段是服务器的 SUB_TOKEN，泄露后请更换。
          </>
        }
      >
        {meta.isLoading ? (
          <Skeleton className="h-5 w-56" />
        ) : meta.error || !subBase ? (
          <span className="text-xs text-bad">{meta.error ? errorMessage(meta.error) : '不可用'}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <code className="min-w-0 truncate font-mono text-xs text-ink-2">{reveal ? subBase : masked}</code>
            <button
              type="button"
              aria-label={reveal ? '隐藏令牌' : '显示令牌'}
              onClick={() => setReveal((v) => !v)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            <CopyButton text={subBase} label="复制前缀" size="sm" />
          </span>
        )}
      </Row>
      <Row
        label="服务状态"
        hint={
          health.data
            ? `已运行 ${formatDuration(health.data.uptime_seconds * 1000)}${health.data.build_id ? ` · 构建 ${health.data.build_id}` : ''}`
            : '检查服务和 Redis 是否正常'
        }
      >
        <span className="flex items-center gap-3">
          {health.isLoading ? (
            <Skeleton className="h-5 w-32" />
          ) : health.error && !health.data ? (
            <span className="text-xs text-bad">{errorMessage(health.error)}</span>
          ) : (
            <>
              <span className="flex items-center gap-1.5 text-xs text-ink-2">
                <StatusDot tone={health.data?.status === 'ok' ? 'ok' : 'warn'} />
                {health.data?.status === 'ok' ? '服务正常' : '服务降级'}
              </span>
              <span className="flex items-center gap-1.5 text-xs text-ink-2">
                <StatusDot tone={redisOk ? 'ok' : 'bad'} />
                Redis {redisOk ? '已连接' : '不可用'}
              </span>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={RefreshCw}
            aria-label="重新检查"
            loading={health.isValidating}
            onClick={() => void health.refetch()}
          />
        </span>
      </Row>
    </Card>
  );
}

/* ─── shortcuts ──────────────────────────────────────────────────────── */

function Shortcuts() {
  const [mod, setMod] = useState('⌘');
  useEffect(() => setMod(modKey()), []);
  const groups: Array<{ title: string; items: Array<{ keys: string[]; label: string }> }> = [
    {
      title: '全局',
      items: [
        { keys: [mod, 'K'], label: '命令面板' },
        { keys: [mod, 'J'], label: 'AI 助手' },
        { keys: [mod, '\\'], label: '收起 / 展开侧边栏' },
        { keys: [mod, 'S'], label: '保存当前修改' },
        { keys: ['Esc'], label: '关闭弹窗或面板' },
      ],
    },
    {
      title: '跳转（先按 G 再按字母）',
      items: [
        { keys: ['G', 'O'], label: '总览' },
        { keys: ['G', 'G'], label: '策略组' },
        { keys: ['G', 'R'], label: '规则' },
        { keys: ['G', 'D'], label: '设备' },
        { keys: ['G', 'B'], label: '基础配置' },
        { keys: ['G', 'S'], label: '节点来源' },
        { keys: ['G', 'H'], label: '操作历史' },
      ],
    },
  ];
  return (
    <Card className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
      {groups.map((group) => (
        <div key={group.title} className="px-4 py-3.5">
          <div className="mb-2 text-[11px] font-medium text-ink-3">{group.title}</div>
          <ul className="flex flex-col gap-2">
            {group.items.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
                {item.label}
                <span className="flex items-center gap-1">
                  {item.keys.map((key, index) => (
                    <Kbd key={index} className={cn(key.length > 1 && key !== 'Esc' && 'px-1')}>
                      {key}
                    </Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

/* ─── about ──────────────────────────────────────────────────────────── */

function About() {
  const health = useHealth();
  return (
    <Card className="flex flex-col gap-3 p-4">
      <Wordmark />
      <p className="text-xs leading-relaxed text-ink-2">
        自部署的 Clash / Mihomo 订阅与配置管理。每次保存都会先预演最终配置，坏配置不会落盘。
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <Badge mono>{health.data?.build_id ? `build ${health.data.build_id}` : '本地构建'}</Badge>
        <span>数据保存在服务器的 Redis 中</span>
      </div>
    </Card>
  );
}
