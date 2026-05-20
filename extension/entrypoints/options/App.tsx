import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui';
import { send } from '@/lib/messages';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '@/lib/settings';

type ProbeStatus = { kind: 'idle' } | { kind: 'ok'; message: string } | { kind: 'err'; message: string };

export default function OptionsApp() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<ProbeStatus>({ kind: 'idle' });
  const [backendStatus, setBackendStatus] = useState<ProbeStatus>({ kind: 'idle' });
  const [clashStatus, setClashStatus] = useState<ProbeStatus>({ kind: 'idle' });
  const [policies, setPolicies] = useState<string[]>([]);
  const [loadingPolicies, setLoadingPolicies] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
    });
  }, []);

  const patch = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  async function onSave() {
    setSaving(true);
    try {
      await saveSettings(settings);
      setSaveStatus({ kind: 'ok', message: 'Saved.' });
    } catch (err) {
      setSaveStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
      setTimeout(() => setSaveStatus({ kind: 'idle' }), 2000);
    }
  }

  async function onPingBackend() {
    setBackendStatus({ kind: 'idle' });
    try {
      await saveSettings(settings);
      await send('pingBackend' as never).catch(() => null);
      const data = (await send({ type: 'pingBackend' })) as { status?: string };
      setBackendStatus({ kind: 'ok', message: `Backend OK${data.status ? ` (${data.status})` : ''}` });
    } catch (err) {
      setBackendStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onPingClash() {
    setClashStatus({ kind: 'idle' });
    try {
      await saveSettings(settings);
      await send({ type: 'pingClash' });
      setClashStatus({ kind: 'ok', message: 'Clash controller OK.' });
    } catch (err) {
      setClashStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function onLoadPolicies() {
    setLoadingPolicies(true);
    try {
      await saveSettings(settings);
      const list = (await send({ type: 'getPolicies' })) as string[];
      setPolicies(list);
    } catch (err) {
      setBackendStatus({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingPolicies(false);
    }
  }

  function toggleGroup(group: string) {
    setSettings((prev) => {
      const set = new Set(prev.candidateGroups);
      if (set.has(group)) set.delete(group);
      else set.add(group);
      return { ...prev, candidateGroups: [...set] };
    });
  }

  if (!loaded) {
    return <div className="p-6 text-[var(--color-muted)]">Loading…</div>;
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">ProxyManager Options</h1>
          <p className="text-xs text-[var(--color-muted)]">
            Where to write rules and where to speedtest from.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </header>

      {saveStatus.kind !== 'idle' && (
        <Card
          className={
            saveStatus.kind === 'err'
              ? 'border-[var(--color-danger)]/40'
              : 'border-[var(--color-accent)]/40'
          }
        >
          <CardBody
            className={`text-sm ${
              saveStatus.kind === 'err'
                ? 'text-[var(--color-danger)]'
                : 'text-[var(--color-accent)]'
            }`}
          >
            {saveStatus.message}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Backend (ProxyManager)</CardTitle>
          <Button size="sm" variant="secondary" onClick={onPingBackend}>
            Test
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          <div>
            <Label>Backend URL</Label>
            <Input
              value={settings.backendUrl}
              onChange={(e) => patch('backendUrl', e.target.value)}
              placeholder="https://proxymanager.vercel.app"
            />
          </div>
          <div>
            <Label>Admin key (Bearer)</Label>
            <Input
              type="password"
              value={settings.adminKey}
              onChange={(e) => patch('adminKey', e.target.value)}
              placeholder="ADMIN_KEY value"
            />
          </div>
          {backendStatus.kind !== 'idle' && (
            <p
              className={`text-xs ${
                backendStatus.kind === 'err'
                  ? 'text-[var(--color-danger)]'
                  : 'text-[var(--color-accent)]'
              }`}
            >
              {backendStatus.message}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Clash controller</CardTitle>
          <Button size="sm" variant="secondary" onClick={onPingClash}>
            Test
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          <div>
            <Label>External controller URL</Label>
            <Input
              value={settings.clashUrl}
              onChange={(e) => patch('clashUrl', e.target.value)}
              placeholder="http://localhost:9090"
            />
          </div>
          <div>
            <Label>Secret (optional)</Label>
            <Input
              type="password"
              value={settings.clashSecret}
              onChange={(e) => patch('clashSecret', e.target.value)}
              placeholder="leave blank if not configured"
            />
          </div>
          {clashStatus.kind !== 'idle' && (
            <p
              className={`text-xs ${
                clashStatus.kind === 'err'
                  ? 'text-[var(--color-danger)]'
                  : 'text-[var(--color-accent)]'
              }`}
            >
              {clashStatus.message}
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Candidate proxy-groups for speedtest</CardTitle>
          <Button size="sm" variant="secondary" onClick={onLoadPolicies} disabled={loadingPolicies}>
            {loadingPolicies ? 'Loading…' : 'Load from backend'}
          </Button>
        </CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs text-[var(--color-muted)]">
            Each speedtest run compares latency for these groups. Pick the regional groups
            you care about — typically 3–6 (e.g. 香港, 日本, 美国, 新加坡).
          </p>
          {settings.candidateGroups.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {settings.candidateGroups.map((g) => (
                <Badge key={g} tone="accent">
                  {g}
                </Badge>
              ))}
            </div>
          )}
          {policies.length > 0 ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs">
              {policies.map((p) => {
                const checked = settings.candidateGroups.includes(p);
                return (
                  <label
                    key={p}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1 cursor-pointer ${
                      checked
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                        : 'border-[var(--color-border)] bg-[var(--color-surface-2)]'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleGroup(p)}
                    />
                    {p}
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">
              No policies loaded yet — click &quot;Load from backend&quot; after entering the URL + key.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rule write defaults</CardTitle>
        </CardHeader>
        <CardBody className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label>Default anchor</Label>
            <Input
              value={settings.defaultAnchor}
              onChange={(e) => patch('defaultAnchor', e.target.value)}
              placeholder="manual"
            />
          </div>
          <div>
            <Label>Default rule type</Label>
            <Select
              value={settings.defaultRuleType}
              onChange={(e) => patch('defaultRuleType', e.target.value as Settings['defaultRuleType'])}
            >
              <option value="DOMAIN-SUFFIX">DOMAIN-SUFFIX</option>
              <option value="DOMAIN">DOMAIN</option>
            </Select>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Speedtest</CardTitle>
        </CardHeader>
        <CardBody>
          <Label>Per-probe timeout (ms)</Label>
          <Input
            type="number"
            value={settings.speedtestTimeoutMs}
            onChange={(e) =>
              patch('speedtestTimeoutMs', Math.max(500, Number(e.target.value) || 5000))
            }
            className="max-w-xs"
          />
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            How long each (domain × group) latency probe waits before giving up. 5000ms is
            usually fine; raise it if your candidate groups include geographically distant
            regions on slow links.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>After write</CardTitle>
        </CardHeader>
        <CardBody>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoReloadClash}
              onChange={(e) => patch('autoReloadClash', e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Auto-reload Clash after a successful rule write
              <span className="block text-xs text-[var(--color-muted)] mt-0.5">
                Calls <code className="font-mono">PUT /configs?force=true</code> so the new
                rule takes effect without a separate action. Reload failures are surfaced
                inline but don&apos;t mark the write as failed.
              </span>
            </span>
          </label>
        </CardBody>
      </Card>
    </main>
  );
}
