'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { setAdminKey } from '@/lib/client/auth-storage';

export default function LoginPage() {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/anchors', {
        headers: { Authorization: `Bearer ${key.trim()}` },
      });
      if (res.status === 401) {
        setError('管理密钥无效');
        return;
      }
      if (!res.ok && res.status !== 404) {
        setError(`服务返回 ${res.status}`);
        return;
      }
      setAdminKey(key.trim());
      const url = new URL(window.location.href);
      const next = url.searchParams.get('next') ?? '/';
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-12 bg-[var(--color-bg)]">
      <div className="w-full max-w-[360px] space-y-8">
        <div className="text-center space-y-2">
          <h1
            className="font-serif text-[40px] font-medium leading-[1.1] tracking-[-0.02em] text-[var(--color-ink)]"
            style={{ fontVariationSettings: '"opsz" 144, "SOFT" 30' }}
          >
            ProxyManager
          </h1>
          <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)]">
            代理订阅管家
          </p>
        </div>

        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] px-6 py-6 space-y-4">
          <form className="space-y-4" onSubmit={onSubmit}>
            <div>
              <label className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-muted)] mb-1.5 block">
                管理密钥
              </label>
              <Input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus
                placeholder="ADMIN_KEY"
              />
            </div>
            {error && (
              <p className="text-[12px] text-[var(--color-danger)] bg-[#F4D8D2] border border-[var(--color-danger)]/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending || !key.trim()} className="w-full">
              {pending ? '验证中…' : '登录'}
            </Button>
            <p className="text-[12px] text-[var(--color-muted)] leading-[1.55]">
              密钥仅保存在当前标签页的 session storage 中，关闭标签页会自动登出。
            </p>
          </form>
        </div>
      </div>
    </main>
  );
}
