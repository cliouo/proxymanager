'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/Card';
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
        setError('Invalid admin key.');
        return;
      }
      if (!res.ok && res.status !== 404) {
        setError(`Server returned ${res.status}.`);
        return;
      }
      setAdminKey(key.trim());
      const url = new URL(window.location.href);
      const next = url.searchParams.get('next') ?? '/';
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>ProxyManager</CardTitle>
        </CardHeader>
        <CardBody>
          <form className="space-y-3" onSubmit={onSubmit}>
            <label className="text-xs text-[var(--color-muted)] block">Admin key</label>
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
              placeholder="ADMIN_KEY"
            />
            {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
            <Button type="submit" disabled={pending || !key.trim()} className="w-full">
              {pending ? 'Verifying…' : 'Sign in'}
            </Button>
            <p className="text-xs text-[var(--color-muted)]">
              The key is stored in this tab&apos;s session storage. Closing the tab signs you out.
            </p>
          </form>
        </CardBody>
      </Card>
    </main>
  );
}
