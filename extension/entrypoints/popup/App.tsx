import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { send, type BackendRule, type SpeedtestForDomain } from '@/lib/messages';
import {
  clearRecentWrites,
  getRecentWrites,
  pushRecentWrite,
  updateRecentWrite,
  type RecentWrite,
} from '@/lib/recent-writes';
import { getSettings, type Settings } from '@/lib/settings';

interface ActiveTab {
  id: number;
  url: string;
  hostname: string;
}

interface ExtraResult {
  id: string;
  result: SpeedtestForDomain;
}

export default function PopupApp() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [domains, setDomains] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<SpeedtestForDomain[] | null>(null);
  const [extraResults, setExtraResults] = useState<ExtraResult[]>([]);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pastedUrl, setPastedUrl] = useState('');
  const [pasteTesting, setPasteTesting] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const [recentWrites, setRecentWrites] = useState<RecentWrite[]>([]);

  // hostname → chosen full URL to probe (overrides default `https://{host}/`).
  const [pickedUrls, setPickedUrls] = useState<Map<string, string>>(new Map());
  // Only one row's URL list expanded at a time to keep the popup compact.
  const [expandedHost, setExpandedHost] = useState<string | null>(null);
  const [hostUrls, setHostUrls] = useState<Map<string, string[]>>(new Map());
  const [loadingHost, setLoadingHost] = useState<string | null>(null);
  const [urlListError, setUrlListError] = useState<string | null>(null);

  // Active tab + initial domain list.
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setSettings(s);

      getRecentWrites().then(setRecentWrites).catch(() => undefined);

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
    setPickedUrls(new Map());
    setHostUrls(new Map());
    setExpandedHost(null);
    setResults(null);
  }

  async function toggleHostUrls(domain: string) {
    if (!tab) return;
    if (expandedHost === domain) {
      setExpandedHost(null);
      return;
    }
    setExpandedHost(domain);
    setUrlListError(null);
    if (hostUrls.has(domain)) return;
    setLoadingHost(domain);
    try {
      const list = (await send({
        type: 'listUrlsForDomain',
        tabId: tab.id,
        domain,
      })) as string[];
      setHostUrls((prev) => new Map(prev).set(domain, list));
    } catch (err) {
      setUrlListError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingHost(null);
    }
  }

  function pickUrl(domain: string, url: string | null) {
    setPickedUrls((prev) => {
      const next = new Map(prev);
      if (url === null) next.delete(domain);
      else next.set(domain, url);
      return next;
    });
    // Selecting a specific URL implies you want it tested.
    if (url !== null) {
      setSelected((prev) => {
        if (prev.has(domain)) return prev;
        const next = new Set(prev);
        next.add(domain);
        return next;
      });
    }
  }

  async function runTest() {
    if (!settings || selected.size === 0) return;
    setTesting(true);
    setResults(null);
    setError(null);
    try {
      const targets = [...selected].map((d) => ({
        label: d,
        url: pickedUrls.get(d) ?? `https://${d}/`,
      }));
      const res = (await send({
        type: 'speedtestBatch',
        targets,
        groups: settings.candidateGroups,
      })) as SpeedtestForDomain[];
      setResults(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }

  async function onPasteTest(e: React.FormEvent) {
    e.preventDefault();
    if (!settings) return;
    const trimmed = pastedUrl.trim();
    if (!trimmed) return;
    setPasteError(null);
    setPasteTesting(true);
    try {
      let label = trimmed;
      try {
        label = new URL(trimmed).hostname || trimmed;
      } catch {
        setPasteError('Not a valid URL.');
        return;
      }
      const res = (await send({
        type: 'speedtestBatch',
        targets: [{ label, url: trimmed }],
        groups: settings.candidateGroups,
      })) as SpeedtestForDomain[];
      const fresh = res[0];
      if (fresh) {
        setExtraResults((prev) => [{ id: crypto.randomUUID(), result: fresh }, ...prev]);
        setPastedUrl('');
      }
    } catch (err) {
      setPasteError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasteTesting(false);
    }
  }

  function removeExtra(id: string) {
    setExtraResults((prev) => prev.filter((r) => r.id !== id));
  }

  const handleWritten = useCallback((entry: RecentWrite) => {
    setRecentWrites((prev) => [entry, ...prev].slice(0, 20));
  }, []);

  async function onClearRecent() {
    await clearRecentWrites();
    setRecentWrites([]);
  }

  const handleUndone = useCallback((id: string, patch: Partial<RecentWrite>) => {
    setRecentWrites((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  }, []);

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
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight leading-none">
            ProxyManager
          </h1>
          <p
            className="text-[11px] text-[var(--color-muted)] truncate font-mono mt-1"
            title={tab?.url}
          >
            {tab?.hostname || tab?.url || '—'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => browser.runtime.openOptionsPage()}
          className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)] shrink-0"
        >
          ⚙ Options
        </button>
      </header>

      {error && (
        <Card className="border-[var(--color-danger)]/40">
          <CardBody className="text-xs text-[var(--color-danger)]">{error}</CardBody>
        </Card>
      )}

      {recentWrites.length > 0 && (
        <RecentWritesCard
          entries={recentWrites}
          autoReload={settings.autoReloadClash}
          onClear={onClearRecent}
          onUndone={handleUndone}
        />
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
        <CardBody className="p-0 max-h-72 overflow-y-auto">
          {domains.length === 0 ? (
            <p className="px-4 py-3 text-xs text-[var(--color-muted)]">
              No domains yet — reload the page and reopen this popup.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]/60">
              {domains.map((d) => {
                const picked = pickedUrls.get(d);
                const expanded = expandedHost === d;
                const urls = hostUrls.get(d);
                const pickedLabel = picked ? probedLabelOf(picked) : null;
                const httpRoot = `http://${d}/`;
                return (
                  <li key={d} className="text-xs">
                    <div className="flex items-center gap-2 px-3 py-2 hover:bg-[var(--color-surface-2)]/40">
                      <input
                        type="checkbox"
                        checked={selected.has(d)}
                        onChange={() => toggle(d)}
                        className="shrink-0"
                      />
                      <code className="font-mono truncate flex-1 min-w-0">{d}</code>
                      {tab?.hostname === d && <Badge tone="accent">main</Badge>}
                      <button
                        type="button"
                        onClick={() => toggleHostUrls(d)}
                        className={`shrink-0 inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-md border whitespace-nowrap transition-colors ${
                          picked
                            ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)] bg-[var(--color-accent)]/10 hover:bg-[var(--color-accent)]/15'
                            : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-fg)]/40'
                        }`}
                        title={picked ? `Will test ${picked}` : 'Pick a specific URL on this host'}
                        aria-expanded={expanded}
                      >
                        <span>URL</span>
                        <span className="text-[9px] leading-none">
                          {expanded ? '▾' : picked ? '●' : '▸'}
                        </span>
                      </button>
                    </div>

                    {picked && !expanded && (
                      <code
                        className="ml-8 mb-1 block font-mono text-[10px] text-[var(--color-accent)] truncate"
                        title={picked}
                      >
                        @ {pickedLabel ?? '/'}
                      </code>
                    )}

                    {expanded && (
                      <div className="ml-8 mr-3 mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-2 space-y-0.5">
                        {loadingHost === d ? (
                          <p className="text-[10px] text-[var(--color-muted)]">Loading…</p>
                        ) : (
                          <>
                            <label className="flex items-center gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-[var(--color-surface-2)]">
                              <input
                                type="radio"
                                name={`u-${d}`}
                                checked={!picked}
                                onChange={() => pickUrl(d, null)}
                              />
                              <code className="font-mono text-[10px] text-[var(--color-muted)]">
                                (root: https://{d}/)
                              </code>
                            </label>
                            <label
                              className="flex items-center gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-[var(--color-surface-2)]"
                              title="Use http:// instead — for hosts that don't serve https"
                            >
                              <input
                                type="radio"
                                name={`u-${d}`}
                                checked={picked === httpRoot}
                                onChange={() => pickUrl(d, httpRoot)}
                              />
                              <code className="font-mono text-[10px] text-[var(--color-warn)]">
                                (root: http://{d}/)
                              </code>
                            </label>
                            {urls && urls.length > 0 ? (
                              urls.map((u) => {
                                let path = u;
                                try {
                                  const parsed = new URL(u);
                                  path = parsed.pathname + parsed.search;
                                } catch {
                                  /* keep full URL */
                                }
                                return (
                                  <label
                                    key={u}
                                    className="flex items-center gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-[var(--color-surface-2)]"
                                    title={u}
                                  >
                                    <input
                                      type="radio"
                                      name={`u-${d}`}
                                      checked={picked === u}
                                      onChange={() => pickUrl(d, u)}
                                    />
                                    <code className="font-mono text-[10px] truncate">{path}</code>
                                  </label>
                                );
                              })
                            ) : (
                              <p className="text-[10px] text-[var(--color-muted)] px-1">
                                No URLs recorded yet for this host.
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {urlListError && (
            <p className="px-3 py-2 text-xs text-[var(--color-danger)]">{urlListError}</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2.5 p-3">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] mr-1">
              Compare across
            </span>
            {settings.candidateGroups.map((g) => (
              <Badge key={g} tone="neutral">
                {g}
              </Badge>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--color-muted)]">
              {selected.size === 0
                ? 'No domains selected'
                : `${selected.size} domain${selected.size > 1 ? 's' : ''} selected`}
            </span>
            <Button
              onClick={runTest}
              disabled={testing || selected.size === 0}
              className="shrink-0"
            >
              {testing ? 'Testing…' : selected.size > 0 ? `Speedtest (${selected.size})` : 'Speedtest'}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test any URL</CardTitle>
        </CardHeader>
        <CardBody className="space-y-1.5">
          <form onSubmit={onPasteTest} className="flex gap-2">
            <Input
              type="url"
              value={pastedUrl}
              onChange={(e) => setPastedUrl(e.target.value)}
              placeholder="https://example.com/path"
              className="flex-1 text-xs min-w-0"
            />
            <Button
              type="submit"
              disabled={pasteTesting || !pastedUrl.trim()}
              className="shrink-0"
            >
              {pasteTesting ? '…' : 'Test'}
            </Button>
          </form>
          <p className="text-[10px] text-[var(--color-muted)] leading-relaxed">
            For URLs not in this tab&apos;s list — or a path you already know times out.
            Hostname becomes the rule value if you write.
          </p>
          {pasteError && <p className="text-xs text-[var(--color-danger)]">{pasteError}</p>}
        </CardBody>
      </Card>

      {(results || extraResults.length > 0) && tab && (
        <div className="space-y-2">
          {extraResults.map(({ id, result }) => (
            <ResultCard
              key={`x-${id}`}
              initial={result}
              settings={settings}
              tabId={tab.id}
              onWritten={handleWritten}
              onRemove={() => removeExtra(id)}
            />
          ))}
          {results?.map((r) => (
            <ResultCard
              key={r.domain}
              initial={r}
              settings={settings}
              tabId={tab.id}
              onWritten={handleWritten}
            />
          ))}
        </div>
      )}
    </main>
  );
}

/**
 * Short label for the URL actually probed, shown beneath a picked row or in
 * the result card header. Returns null when there's nothing notable to show
 * (the default behaviour — `https://host/`).
 */
function probedLabelOf(probedUrl: string): string | null {
  try {
    const u = new URL(probedUrl);
    const isRoot = (u.pathname === '/' || u.pathname === '') && !u.search;
    if (isRoot && u.protocol === 'https:') return null;
    if (isRoot) return `${u.protocol}//`;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

function ResultCard({
  initial,
  settings,
  tabId,
  onWritten,
  onRemove,
}: {
  initial: SpeedtestForDomain;
  settings: Settings;
  tabId: number;
  /** Notified after a successful write so the popup can refresh recent-writes. */
  onWritten?: (entry: RecentWrite) => void;
  /** Present only for manually-pasted URL results; renders a dismiss button. */
  onRemove?: () => void;
}) {
  const [result, setResult] = useState<SpeedtestForDomain>(initial);
  const [ruleType, setRuleType] = useState<Settings['defaultRuleType']>(
    settings.defaultRuleType || 'DOMAIN-SUFFIX',
  );
  // Old storage payloads can leak an empty defaultAnchor; never seed with ''
  // or the input renders as a blank pill with no label, no placeholder.
  const [anchor, setAnchor] = useState(settings.defaultAnchor || 'manual');
  const [chosen, setChosen] = useState<string | null>(result.best?.group ?? null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<WriteOutcome | null>(null);

  const [existingRules, setExistingRules] = useState<BackendRule[] | null>(null);
  const anchorFetchSeq = useRef(0);

  const [showUrls, setShowUrls] = useState(false);
  const [urls, setUrls] = useState<string[] | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [loadingUrls, setLoadingUrls] = useState(false);
  const [retesting, setRetesting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const allFailed = result.entries.every((e) => e.delayMs === null);
  const probedLabel = probedLabelOf(result.probedUrl);

  const trimmedAnchor = anchor.trim();
  useEffect(() => {
    if (!trimmedAnchor) {
      setExistingRules([]);
      return;
    }
    const seq = ++anchorFetchSeq.current;
    setExistingRules(null);
    const timer = window.setTimeout(() => {
      send<BackendRule[]>({ type: 'listRulesByAnchor', anchor: trimmedAnchor })
        .then((rules) => {
          if (seq === anchorFetchSeq.current) setExistingRules(rules);
        })
        .catch(() => {
          if (seq === anchorFetchSeq.current) setExistingRules([]);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [trimmedAnchor]);

  const covering = useMemo(
    () => (existingRules ? findCoveringRule(result.domain, ruleType, existingRules) : null),
    [existingRules, result.domain, ruleType],
  );

  async function toggleExpand() {
    if (showUrls) {
      setShowUrls(false);
      return;
    }
    setShowUrls(true);
    if (urls !== null) return;
    setLoadingUrls(true);
    setUrlError(null);
    try {
      const list = (await send({
        type: 'listUrlsForDomain',
        tabId,
        domain: result.domain,
      })) as string[];
      setUrls(list);
      const firstNonRoot = list.find((u) => {
        try {
          return new URL(u).pathname !== '/';
        } catch {
          return false;
        }
      });
      setSelectedUrl(firstNonRoot ?? list[0] ?? null);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingUrls(false);
    }
  }

  async function retest() {
    if (!selectedUrl) return;
    setRetesting(true);
    setUrlError(null);
    try {
      const res = (await send({
        type: 'speedtestBatch',
        targets: [{ label: result.domain, url: selectedUrl }],
        groups: settings.candidateGroups,
      })) as SpeedtestForDomain[];
      const fresh = res[0];
      if (fresh) {
        setResult(fresh);
        setChosen(fresh.best?.group ?? null);
        setShowUrls(false);
      }
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetesting(false);
    }
  }

  async function write() {
    if (!chosen) return;
    setPending(true);
    setDone(null);
    try {
      const created = await send<{ id: string }>({
        type: 'createRule',
        anchor: trimmedAnchor,
        ruleType,
        value: result.domain,
        policy: chosen,
        note: buildNote(result, chosen),
      });

      let reloaded = false;
      let reloadError: string | null = null;
      if (settings.autoReloadClash) {
        try {
          await send({ type: 'reloadClash' });
          reloaded = true;
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
      }

      const entry: RecentWrite = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        anchor: trimmedAnchor,
        ruleType,
        value: result.domain,
        policy: chosen,
        ruleId: created?.id,
        reloaded,
      };
      await pushRecentWrite(entry).catch(() => undefined);
      onWritten?.(entry);

      setDone({ kind: 'ok', reloaded, reloadError });
    } catch (err) {
      setDone({ kind: 'err', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>
            <code className="font-mono text-xs">{result.domain}</code>
          </CardTitle>
          {probedLabel && (
            <p
              className="mt-0.5 text-[10px] font-mono text-[var(--color-muted)] truncate max-w-[260px]"
              title={result.probedUrl}
            >
              tested @ {probedLabel}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {result.best ? (
            <Badge tone="accent">
              best: {result.best.group} · {result.best.delayMs}ms
            </Badge>
          ) : (
            allFailed && <Badge tone="danger">all timed out</Badge>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="text-[var(--color-muted)] hover:text-[var(--color-danger)] text-sm leading-none px-1"
              title="Remove this card"
              aria-label="Remove"
            >
              ×
            </button>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <ul className="grid grid-cols-2 gap-1.5 text-xs">
          {result.entries.map((e) => {
            const isBest = result.best?.group === e.group;
            const isChosen = chosen === e.group;
            const isDead = e.delayMs === null;
            return (
              <li key={e.group}>
                <button
                  type="button"
                  onClick={() => setChosen(e.group)}
                  className={`w-full flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 transition-colors ${
                    isChosen
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-accent)]/40'
                  }`}
                >
                  <span className="truncate font-medium">{e.group}</span>
                  <span
                    className={`tabular-nums whitespace-nowrap ${
                      isDead
                        ? 'text-[var(--color-danger)]'
                        : isBest
                          ? 'text-[var(--color-accent)] font-semibold'
                          : 'text-[var(--color-muted)]'
                    }`}
                  >
                    {isDead ? '×' : `${e.delayMs}ms`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <button
          type="button"
          onClick={toggleExpand}
          className="text-[11px] text-[var(--color-muted)] hover:text-[var(--color-fg)] text-left transition-colors"
        >
          {showUrls ? '▾ Hide URLs' : '▸ Test a different URL'}
        </button>

        {showUrls && (
          <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)]/40 p-2">
            {loadingUrls ? (
              <p className="text-xs text-[var(--color-muted)]">Loading recorded URLs…</p>
            ) : urls && urls.length > 0 ? (
              <>
                <p className="text-[10px] text-[var(--color-muted)]">
                  Pick a real resource and retest. Helps when the root path doesn't
                  respond.
                </p>
                <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                  {urls.map((u) => {
                    let path = u;
                    try {
                      const parsed = new URL(u);
                      path = parsed.pathname + parsed.search;
                    } catch {
                      /* fall back to full URL */
                    }
                    return (
                      <li key={u}>
                        <label
                          className="flex items-center gap-2 cursor-pointer text-xs hover:bg-[var(--color-surface-2)] rounded px-1.5 py-1"
                          title={u}
                        >
                          <input
                            type="radio"
                            name={`url-${result.domain}`}
                            checked={selectedUrl === u}
                            onChange={() => setSelectedUrl(u)}
                          />
                          <code className="font-mono truncate">{path}</code>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowUrls(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={retest}
                    disabled={!selectedUrl || retesting}
                  >
                    {retesting ? 'Retesting…' : 'Retest with this URL'}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-[var(--color-muted)]">
                No recorded URLs for this domain yet. Reload the page so the extension
                can observe its requests, then reopen this popup.
              </p>
            )}
            {urlError && (
              <p className="text-xs text-[var(--color-danger)]">{urlError}</p>
            )}
          </div>
        )}

        <div className="space-y-2 pt-2 border-t border-[var(--color-border)]/60">
          {covering && (
            <p
              className={`text-[10px] leading-snug rounded-md border px-2 py-1 ${
                covering.policy === chosen
                  ? 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 text-[var(--color-warn)]'
                  : 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
              }`}
              title={`Existing ${covering.type} ${covering.value} → ${covering.policy}`}
            >
              {covering.policy === chosen ? 'Redundant: ' : 'Refines: '}
              <code className="font-mono">
                {covering.type} {covering.value}
              </code>{' '}
              already routes to <strong>{covering.policy}</strong>.
            </p>
          )}
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-0.5 shrink-0">
              <span className="text-[9px] uppercase tracking-wide text-[var(--color-muted)] font-semibold">
                Type
              </span>
              <Select
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as Settings['defaultRuleType'])}
                className="h-8 text-[11px] w-[9rem]"
              >
                <option value="DOMAIN-SUFFIX">DOMAIN-SUFFIX</option>
                <option value="DOMAIN">DOMAIN</option>
              </Select>
            </label>
            <label className="flex flex-col gap-0.5 flex-1 min-w-0">
              <span className="text-[9px] uppercase tracking-wide text-[var(--color-muted)] font-semibold">
                Anchor
              </span>
              <Input
                value={anchor}
                onChange={(e) => setAnchor(e.target.value)}
                className="h-8 text-[11px]"
                placeholder="e.g. manual"
              />
            </label>
          </div>
          <Button
            onClick={write}
            disabled={pending || !chosen || !anchor.trim()}
            className="w-full"
          >
            {pending ? 'Saving…' : chosen ? `Write rule → ${chosen}` : 'Pick a group first'}
          </Button>
        </div>
        {done?.kind === 'ok' && (
          <p
            className={`text-xs ${
              done.reloaded
                ? 'text-[var(--color-accent)]'
                : done.reloadError
                  ? 'text-[var(--color-warn)]'
                  : 'text-[var(--color-accent)]'
            }`}
          >
            {done.reloaded
              ? 'Saved + reloaded. Rule is live.'
              : done.reloadError
                ? `Saved, but reload failed: ${done.reloadError}`
                : 'Saved. Reload Clash for the new rule to take effect.'}
          </p>
        )}
        {done?.kind === 'err' && (
          <p className="text-xs text-[var(--color-danger)]">{done.message}</p>
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

type WriteOutcome =
  | { kind: 'ok'; reloaded: boolean; reloadError: string | null }
  | { kind: 'err'; message: string };

/**
 * Find an existing rule (under the same anchor) that already routes the given
 * target. DOMAIN-SUFFIX rules cover their own value plus any sub-domain, so a
 * `DOMAIN-SUFFIX youtube.com` shadows any later `DOMAIN-SUFFIX m.youtube.com`
 * or `DOMAIN youtube.com` write under the same anchor.
 */
function findCoveringRule(
  value: string,
  type: 'DOMAIN' | 'DOMAIN-SUFFIX',
  existing: BackendRule[],
): BackendRule | null {
  for (const r of existing) {
    if (r.type === type && r.value === value) return r;
    if (r.type === 'DOMAIN-SUFFIX') {
      if (r.value === value) return r;
      if (value.endsWith(`.${r.value}`)) return r;
    }
  }
  return null;
}

function RecentWritesCard({
  entries,
  autoReload,
  onClear,
  onUndone,
}: {
  entries: RecentWrite[];
  autoReload: boolean;
  onClear: () => void;
  onUndone: (id: string, patch: Partial<RecentWrite>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const latest = entries[0];

  async function runUndo(entry: RecentWrite) {
    if (!entry.ruleId || entry.undone) return;
    setPending((prev) => new Set(prev).add(entry.id));
    setErrors((prev) => {
      if (!prev.has(entry.id)) return prev;
      const next = new Map(prev);
      next.delete(entry.id);
      return next;
    });
    try {
      await send({ type: 'deleteRule', ruleId: entry.ruleId });

      let reloaded = false;
      let reloadError: string | undefined;
      if (autoReload) {
        try {
          await send({ type: 'reloadClash' });
          reloaded = true;
        } catch (err) {
          reloadError = err instanceof Error ? err.message : String(err);
        }
      }

      const patch: Partial<RecentWrite> = {
        undone: { ts: Date.now(), reloaded, error: reloadError },
      };
      await updateRecentWrite(entry.id, patch).catch(() => undefined);
      onUndone(entry.id, patch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setErrors((prev) => new Map(prev).set(entry.id, message));
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left min-w-0 hover:text-[var(--color-fg)]"
        >
          <span className="text-[10px] leading-none">{open ? '▾' : '▸'}</span>
          <CardTitle>
            Recent writes{' '}
            <span className="text-[var(--color-muted)] font-normal">({entries.length})</span>
          </CardTitle>
        </button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </CardHeader>
      {!open && latest && (
        <CardBody className="py-2">
          <RecentWriteRow
            entry={latest}
            pending={pending.has(latest.id)}
            error={errors.get(latest.id) ?? null}
            onUndo={() => runUndo(latest)}
          />
        </CardBody>
      )}
      {open && (
        <CardBody className="p-0 max-h-64 overflow-y-auto">
          <ul className="divide-y divide-[var(--color-border)]/60">
            {entries.map((w) => (
              <li key={w.id} className="px-3 py-2">
                <RecentWriteRow
                  entry={w}
                  pending={pending.has(w.id)}
                  error={errors.get(w.id) ?? null}
                  onUndo={() => runUndo(w)}
                />
              </li>
            ))}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}

function RecentWriteRow({
  entry,
  pending,
  error,
  onUndo,
}: {
  entry: RecentWrite;
  pending: boolean;
  error: string | null;
  onUndo: () => void;
}) {
  const undone = !!entry.undone;
  const canUndo = !!entry.ruleId && !undone;
  return (
    <div className="space-y-1">
      <div className="text-[11px] flex items-center gap-2 min-w-0">
        <span
          className={`shrink-0 inline-block w-1.5 h-1.5 rounded-full ${
            undone
              ? 'bg-[var(--color-muted)]'
              : entry.reloaded
                ? 'bg-[var(--color-accent)]'
                : 'bg-[var(--color-warn)]'
          }`}
          title={
            undone
              ? 'Undone'
              : entry.reloaded
                ? 'Auto-reloaded'
                : 'Not auto-reloaded'
          }
        />
        <code
          className={`font-mono truncate flex-1 min-w-0 ${
            undone ? 'line-through text-[var(--color-muted)]' : ''
          }`}
          title={`${entry.ruleType} ${entry.value} (anchor: ${entry.anchor})`}
        >
          {entry.value}
        </code>
        <span className="text-[var(--color-muted)] shrink-0">→</span>
        <Badge tone={undone ? 'neutral' : 'accent'}>{entry.policy}</Badge>
        <span className="text-[var(--color-muted)] shrink-0 tabular-nums">
          {formatRelativeTs(entry.ts)}
        </span>
        {undone ? (
          <span className="shrink-0 text-[10px] text-[var(--color-muted)] italic">
            undone
          </span>
        ) : canUndo ? (
          <button
            type="button"
            onClick={onUndo}
            disabled={pending}
            className="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-danger)] hover:border-[var(--color-danger)]/60 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Delete this rule from the backend"
          >
            {pending ? '…' : 'Undo'}
          </button>
        ) : (
          <span
            className="shrink-0 text-[10px] text-[var(--color-muted)]/60"
            title="Rule id not captured at write time — can't undo this entry"
          >
            —
          </span>
        )}
      </div>
      {error && (
        <p className="text-[10px] text-[var(--color-danger)] pl-3 truncate" title={error}>
          undo failed: {error}
        </p>
      )}
      {entry.undone?.error && !error && (
        <p
          className="text-[10px] text-[var(--color-warn)] pl-3 truncate"
          title={entry.undone.error}
        >
          rule deleted, reload failed: {entry.undone.error}
        </p>
      )}
    </div>
  );
}

function formatRelativeTs(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return new Date(ts).toLocaleDateString();
}
