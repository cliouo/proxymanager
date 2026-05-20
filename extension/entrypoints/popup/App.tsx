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
              onRemove={() => removeExtra(id)}
            />
          ))}
          {results?.map((r) => (
            <ResultCard key={r.domain} initial={r} settings={settings} tabId={tab.id} />
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
  onRemove,
}: {
  initial: SpeedtestForDomain;
  settings: Settings;
  tabId: number;
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
  const [done, setDone] = useState<'ok' | string | null>(null);

  const [showUrls, setShowUrls] = useState(false);
  const [urls, setUrls] = useState<string[] | null>(null);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [loadingUrls, setLoadingUrls] = useState(false);
  const [retesting, setRetesting] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  const allFailed = result.entries.every((e) => e.delayMs === null);
  const probedLabel = probedLabelOf(result.probedUrl);

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
