import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Input,
  Select,
} from '@/components/ui';
import { send, type SpeedtestForDomain } from '@/lib/messages';
import { getSettings, type Settings } from '@/lib/settings';

interface ActiveTab {
  id: number;
  url: string;
  hostname: string;
}

export default function PopupApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<SpeedtestForDomain[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active tab + initial domain list.
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setSettings(s);

      const [t] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!t?.id || !t.url) return;
      let hostname = '';
      try {
        hostname = new URL(t.url).hostname;
      } catch {
        /* ignore */
      }
      setTab({ id: t.id, url: t.url, hostname });

      const list = (await send({ type: 'listDomains', tabId: t.id })) as string[];
      setDomains(list);
      if (hostname && list.includes(hostname)) {
        setSelected(new Set([hostname]));
      }
    })().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const configured = useMemo(
    () =>
      !!settings?.backendUrl &&
      !!settings.adminKey &&
      !!settings.clashUrl &&
      settings.candidateGroups.length > 0,
    [settings],
  );

  const toggle = useCallback((domain: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  }, []);

  async function refreshDomains() {
    if (!tab) return;
    const list = (await send({ type: 'listDomains', tabId: tab.id })) as string[];
    setDomains(list);
  }

  async function clearDomains() {
    if (!tab) return;
    await send({ type: 'clearDomains', tabId: tab.id });
    setDomains([]);
    setSelected(new Set());
    setResults(null);
  }

  async function runTest() {
    if (!settings || selected.size === 0) return;
    setTesting(true);
    setResults(null);
    setError(null);
    try {
      const res = (await send({
        type: 'speedtest',
        domains: [...selected],
        groups: settings.candidateGroups,
      })) as SpeedtestForDomain[];
      setResults(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  if (!settings) {
    return (
      <main className="p-4 text-xs text-[var(--color-muted)]">Loading settings…</main>
    );
  }

  if (!configured) {
    return (
      <main className="p-4 space-y-3">
        <h1 className="text-sm font-semibold">ProxyManager</h1>
        <p className="text-xs text-[var(--color-muted)]">
          Set the backend URL, admin key, Clash controller URL and at least one candidate
          proxy-group before using.
        </p>
        <Button onClick={() => browser.runtime.openOptionsPage()}>Open options</Button>
      </main>
    );
  }

  return (
    <main className="p-3 space-y-3">
      <header className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-xs text-[var(--color-muted)] truncate">
            {tab ? tab.hostname || tab.url : 'No tab'}
          </div>
          <h1 className="text-sm font-semibold">ProxyManager</h1>
        </div>
        <button
          type="button"
          onClick={() => browser.runtime.openOptionsPage()}
          className="text-xs text-[var(--color-muted)] hover:text-[var(--color-fg)]"
        >
          Options
        </button>
      </header>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-xs text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Domains <span className="text-[var(--color-muted)] font-normal">({domains.length})</span>
          </CardTitle>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={refreshDomains}>
              Refresh
            </Button>
            <Button size="sm" variant="ghost" onClick={clearDomains}>
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardBody className="p-0 max-h-44 overflow-y-auto">
          {domains.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[var(--color-muted)]">
              No domains yet — reload the page and reopen this popup.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]/60">
              {domains.map((d) => (
                <li key={d}>
                  <label className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-[var(--color-surface-2)]/40">
                    <input
                      type="checkbox"
                      checked={selected.has(d)}
                      onChange={() => toggle(d)}
                    />
                    <code className="font-mono truncate">{d}</code>
                    {tab?.hostname === d && <Badge tone="accent">main</Badge>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--color-muted)]">
          Compare {settings.candidateGroups.length} group(s):{' '}
          {settings.candidateGroups.join(' · ')}
        </p>
        <Button onClick={runTest} disabled={testing || selected.size === 0}>
          {testing ? 'Testing…' : `Speedtest ${selected.size || ''}`}
        </Button>
      </div>

      {results && (
        <div className="space-y-2">
          {results.map((r) => (
            <ResultCard key={r.domain} result={r} settings={settings} />
          ))}
        </div>
      )}
    </main>
  );
}

function ResultCard({
  result,
  settings,
}: {
  result: SpeedtestForDomain;
  settings: Settings;
}) {
  const [ruleType, setRuleType] = useState<Settings['defaultRuleType']>(settings.defaultRuleType);
  const [anchor, setAnchor] = useState(settings.defaultAnchor);
  const [chosen, setChosen] = useState<string | null>(result.best?.group ?? null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<'ok' | string | null>(null);

  async function write() {
    if (!chosen) return;
    setPending(true);
    setDone(null);
    try {
      await send({
        type: 'createRule',
        anchor,
        ruleType,
        value: result.domain,
        policy: chosen,
        note: buildNote(result, chosen),
      });
      setDone('ok');
    } catch (err) {
      setDone(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <code className="font-mono text-xs">{result.domain}</code>
        </CardTitle>
        {result.best && (
          <Badge tone="accent">
            best: {result.best.group} · {result.best.delayMs}ms
          </Badge>
        )}
      </CardHeader>
      <CardBody className="space-y-2">
        <ul className="grid grid-cols-2 gap-1 text-xs">
          {result.entries.map((e) => {
            const isBest = result.best?.group === e.group;
            const isChosen = chosen === e.group;
            return (
              <li key={e.group}>
                <button
                  type="button"
                  onClick={() => setChosen(e.group)}
                  className={`w-full flex items-center justify-between gap-2 rounded-md border px-2 py-1 transition-colors ${
                    isChosen
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-accent)]/40'
                  }`}
                >
                  <span className="truncate">{e.group}</span>
                  <span
                    className={
                      e.delayMs === null
                        ? 'text-[var(--color-danger)]'
                        : isBest
                          ? 'text-[var(--color-accent)] font-semibold'
                          : 'text-[var(--color-muted)]'
                    }
                  >
                    {e.delayMs === null ? '×' : `${e.delayMs}ms`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center gap-2 pt-1">
          <Select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as Settings['defaultRuleType'])}
            className="h-7 text-xs"
          >
            <option value="DOMAIN-SUFFIX">DOMAIN-SUFFIX</option>
            <option value="DOMAIN">DOMAIN</option>
          </Select>
          <Input
            value={anchor}
            onChange={(e) => setAnchor(e.target.value)}
            className="h-7 text-xs flex-1"
            placeholder="anchor"
          />
          <Button size="sm" onClick={write} disabled={pending || !chosen}>
            {pending ? '…' : `Write → ${chosen ?? '?'}`}
          </Button>
        </div>
        {done === 'ok' && (
          <p className="text-xs text-[var(--color-accent)]">
            Saved. Reload Clash for the new rule to take effect.
          </p>
        )}
        {done && done !== 'ok' && (
          <p className="text-xs text-[var(--color-danger)]">{done}</p>
        )}
      </CardBody>
    </Card>
  );
}

function buildNote(result: SpeedtestForDomain, chosen: string): string {
  const summary = result.entries
    .map((e) => `${e.group}=${e.delayMs ?? 'x'}`)
    .join(', ');
  return `speedtest @ ${new Date().toISOString().slice(0, 16)}Z → ${chosen} (${summary})`;
}
