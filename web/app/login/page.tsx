'use client';

import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { getAdminKey, setAdminKey } from '@/lib/client/auth-storage';
import styles from './login.module.css';

/**
 * P3-30: only follow a `next` that is a same-origin absolute path. A raw
 * `next` (e.g. `//evil.com` or `https://evil.com`) would be an open redirect
 * that a phisher could point the login link at.
 */
function safeNext(raw: string | null): string {
  return raw && /^\/(?!\/)/.test(raw) ? raw : '/';
}

export default function LoginPage() {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // P3-30: already authenticated → skip the form, go straight to the target.
  useEffect(() => {
    if (getAdminKey()) {
      const next = safeNext(new URL(window.location.href).searchParams.get('next'));
      window.location.href = next;
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError('密钥不能为空');
      return;
    }
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
      window.location.href = safeNext(url.searchParams.get('next'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.screen}>
      <div className="theme-mount">
        <ThemeToggle />
      </div>

      <main className={styles.login}>
        <div className={styles.mark}>PM</div>
        <h1 className={styles.title}>ProxyManager</h1>
        <div className={styles.sub}>个人代理配置工作台 · 自部署于 Vercel</div>

        <form className="panel" style={{ padding: 22 }} onSubmit={onSubmit}>
          <div className={`field${error ? ' invalid' : ''}`} style={{ marginBottom: 16 }}>
            <label htmlFor="key">
              管理密钥{' '}
              <span style={{ color: 'var(--faint)', fontWeight: 400 }}>ADMIN_KEY</span>
            </label>
            <input
              id="key"
              className="input mono"
              type="password"
              autoComplete="off"
              autoFocus
              placeholder="••••••••••••••••"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError(null);
              }}
            />
            <div className="err-msg">{error ?? '密钥不能为空'}</div>
          </div>
          <button
            type="submit"
            className="btn primary"
            style={{ width: '100%', height: 38 }}
            disabled={pending}
          >
            {pending ? '验证中…' : '进入控制台'}
          </button>
        </form>

        <div className={styles.footNote}>
          密钥仅存于本浏览器 sessionStorage，关闭标签页即清除。
          <br />
          个人代理订阅与配置管理 · 自部署
        </div>
      </main>
    </div>
  );
}
