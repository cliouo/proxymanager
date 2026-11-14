'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { ApiError, clearAdminKey, getAdminKey, request, setAdminKey } from '@/ui/data/api';
import { clearQueries } from '@/ui/data/query';
import { Button, Input } from '@/ui/primitives';
import { Wordmark } from '@/ui/viz/logo';
import { RouteArt } from '@/ui/viz/route-art';

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) return '/';
  return raw;
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const expired = params.get('expired') === '1';
  const [key, setKey] = useState('');
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(expired ? '登录已失效，请重新输入密钥。' : null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (getAdminKey() && !expired) router.replace(next);
    inputRef.current?.focus();
  }, [expired, next, router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = key.trim();
    if (!value) {
      setError('请输入管理密钥');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/setup/status', {
        headers: { Authorization: `Bearer ${value}` },
        cache: 'no-store',
      });
      if (response.status === 401) throw new ApiError(401, '密钥不正确', undefined, [], null);
      if (response.status === 429) throw new ApiError(429, '尝试次数过多', '请 5 分钟后再试。', [], null);
      if (response.status === 500) {
        const body = (await response.json().catch(() => null)) as { detail?: string } | null;
        throw new ApiError(500, '服务器配置异常', body?.detail, [], null);
      }
      if (!response.ok) throw new ApiError(response.status, `登录失败（${response.status}）`, undefined, [], null);
      clearQueries();
      setAdminKey(value);
      await request('/setup/status').catch(() => undefined);
      router.replace(next);
    } catch (err) {
      clearAdminKey();
      if (err instanceof ApiError) setError(err.detail ? `${err.title}：${err.detail}` : err.title);
      else setError('无法连接到服务器');
      setBusy(false);
      inputRef.current?.select();
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full max-w-[360px] flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">欢迎回来</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          输入部署时设置的 <code className="rounded bg-surface-2 px-1 font-mono text-[12px] text-ink">ADMIN_KEY</code> 进入控制台。
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="admin-key" className="text-xs font-medium text-ink-2">
          管理密钥
        </label>
        <Input
          id="admin-key"
          ref={inputRef}
          inputSize="lg"
          type={visible ? 'text' : 'password'}
          autoComplete="current-password"
          required
          value={key}
          invalid={!!error}
          mono={visible}
          placeholder="••••••••••••"
          onChange={(event) => {
            setKey(event.target.value);
            if (error) setError(null);
          }}
          leading={<KeyRound size={15} />}
          trailing={
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? '隐藏密钥' : '显示密钥'}
              className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              {visible ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          }
        />
        <div className="min-h-5 text-xs" aria-live="polite">
          {error && <span className="text-bad">{error}</span>}
        </div>
      </div>
      <Button type="submit" variant="primary" size="lg" loading={busy} trailingIcon={ArrowRight} className="w-full">
        进入控制台
      </Button>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-3">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        密钥只保存在这台浏览器的本地存储中，用于请求管理接口；退出登录后即清除。
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh bg-canvas lg:grid-cols-[1.05fr_1fr]">
      <title>登录 · ProxyManager</title>
      <div className="relative hidden overflow-hidden border-r border-line bg-panel lg:block">
        <div className="absolute inset-0 dot-grid opacity-60" />
        <RouteArt className="absolute inset-0" />
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-panel via-panel/90 to-transparent p-10 pt-24">
          <p className="font-display text-[44px] italic leading-[1.05] tracking-tight text-ink">
            Every packet,
            <br />
            on the right line.
          </p>
          <p className="mt-4 max-w-md text-sm leading-relaxed text-ink-2">
            把订阅源、节点、策略组和规则结构化地管起来。每一次保存都先预演最终配置，坏配置根本落不了盘。
          </p>
          <div className="mt-6 flex flex-wrap gap-2 text-xs text-ink-3">
            {['订阅聚合', '节点处理流程', '可视化分流', '多设备差异', 'AI 助手'].map((tag, i) => (
              <span key={tag} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-2.5 py-1">
                <span className="size-1.5 rounded-full" style={{ background: `var(--l-${i + 1})` }} />
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Wordmark />
        <div className="flex flex-1 items-center justify-center py-12">
          <Suspense fallback={null}>
            <LoginForm />
          </Suspense>
        </div>
        <p className="text-center text-[11px] text-ink-4">ProxyManager · 自部署的 Clash / Mihomo 配置管理</p>
      </div>
    </div>
  );
}
