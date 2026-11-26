import { render, screen, waitFor } from '@testing-library/react';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runAgentAct } from '@/ui/agent';
import { clearQueries } from '@/ui/data/query';
import type { Source } from '@/ui/features/sources/model';
import { AddSourceDialog } from '@/ui/features/sources/create-dialogs';
import { NodesPanel } from '@/ui/features/sources/shared';
import { SourceSettings } from '@/ui/features/sources/source-settings';
import { SourcesIndex } from '@/ui/features/sources/sources-index';
import { FeedbackHost } from '@/ui/primitives';
import { AppToaster, appToaster } from '@/ui/primitives/feedback';

const routerMock = {
  push: vi.fn(),
  replace: vi.fn(),
  prefetch: vi.fn(),
};

let searchParamsString = '';

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/sources',
  useSearchParams: () => new URLSearchParams(searchParamsString),
  useParams: () => ({ id: 'sub-1' }),
}));

let allowConfirm = false;
const agent = createAgent({
  allow: (step) => !step.confirm || allowConfirm,
});

const SAMPLE_SOURCE: Source = {
  id: 'sub-1',
  name: 'nebula',
  display_name: 'Nebula 机场',
  kind: 'remote',
  enabled: true,
  url: 'https://example.com/sub?token=abc',
  ttl_ms: 1800_000,
  fetch_failure_policy: 'use-stale-cache',
  refresh_mode: 'server-auto',
  tags: ['airport'],
  operators: [],
  updated_at: 100,
  fetch_health: {
    state: 'fresh',
    definition_fingerprint: 'fp-1',
    attempted_at: Math.floor(Date.now() / 1000) - 60,
    observed_at: Math.floor(Date.now() / 1000) - 60,
    fresh_at: Math.floor(Date.now() / 1000) - 60,
    proxy_count: 3,
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  clearQueries();
  allowConfirm = false;
  searchParamsString = '';
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
  routerMock.prefetch.mockReset();
});

afterEach(() => {
  appToaster.dismiss();
  vi.restoreAllMocks();
});

describe('Sources pilot pages agent-readiness', () => {
  test('SourcesIndex exposes named controls, DataView summary, and gates write actions', async () => {
    let currentSource = { ...SAMPLE_SOURCE };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/subscriptions/sub-1') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        currentSource = { ...currentSource, ...body };
        return jsonResponse({ data: currentSource });
      }
      if (url.includes('/subscriptions') && method === 'GET') {
        return jsonResponse({ data: [currentSource] });
      }
      if (url.includes('/collections') && method === 'GET') {
        return jsonResponse({ data: [] });
      }
      if (url.includes('/meta')) {
        return jsonResponse({ data: { subBase: 'https://pm.example.com/sub/tok' } });
      }
      return jsonResponse({ data: {} });
    });

    render(
      <>
        <SourcesIndex />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    expect(await screen.findByText('Nebula 机场')).toBeTruthy();

    const components = agent
      .snapshot()
      .filter((entry) => !entry.offPage && entry.component !== 'more');

    for (const entry of components) {
      expect(entry.label, `${entry.component} ${entry.ref} has no name`).toBeTruthy();
    }

    const listEntry = components.find((e) => e.label === '订阅源列表');
    expect(listEntry).toBeTruthy();
    expect(listEntry?.summary).toBe('共 1 个订阅源');
    expect(listEntry?.items?.[0]?.label).toContain('Nebula 机场');

    allowConfirm = false;
    const deniedToggle = await runAgentAct(
      { steps: [{ ref: '停用「Nebula 机场」', action: 'setChecked', args: [false] }] },
      { agent },
    );
    expect(deniedToggle.ok).toBe(false);

    allowConfirm = true;
    const approvedToggle = await runAgentAct(
      { steps: [{ ref: '停用「Nebula 机场」', action: 'setChecked', args: [false] }] },
      { agent },
    );
    expect(approvedToggle.ok, approvedToggle.error?.message).toBe(true);

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(
        ([u, init]) => String(u).includes('/subscriptions/sub-1') && init?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect((patchCall?.[1]?.headers as Record<string, string>)['X-Source']).toBe('ai_chat');
    });
  });

  test('AddSourceDialog lets agent fill form, open Collapsible advanced settings, and gates submit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/subscriptions') && init?.method === 'POST') {
        return jsonResponse({ data: { ...SAMPLE_SOURCE, id: 'sub-new', name: 'atlas', display_name: 'Atlas' } });
      }
      return jsonResponse({ data: {} });
    });

    const onOpenChange = vi.fn();
    render(
      <>
        <AddSourceDialog open onOpenChange={onOpenChange} sources={[SAMPLE_SOURCE]} />
        <AppToaster />
      </>,
    );

    const fillRes = await runAgentAct(
      {
        steps: [
          { ref: '订阅链接', action: 'setValue', args: ['https://atlas.example.com/sub'] },
          { ref: '显示名称', action: 'setValue', args: ['Atlas'] },
          { ref: '标识', action: 'setValue', args: ['atlas'] },
          { ref: '缓存时长', action: 'setValue', args: ['60'] },
        ],
      },
      { agent },
    );
    expect(fillRes.ok, fillRes.error?.message).toBe(true);

    allowConfirm = false;
    const deniedSubmit = await runAgentAct(
      { steps: [{ ref: '确认添加', action: 'press' }] },
      { agent },
    );
    expect(deniedSubmit.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    allowConfirm = true;
    const approvedSubmit = await runAgentAct(
      { steps: [{ ref: '确认添加', action: 'press' }] },
      { agent },
    );
    expect(approvedSubmit.ok, approvedSubmit.error?.message).toBe(true);

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([u, init]) => String(u).endsWith('/api/v1/subscriptions') && init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(String(postCall?.[1]?.body));
      expect(body).toMatchObject({
        kind: 'remote',
        name: 'atlas',
        display_name: 'Atlas',
        url: 'https://atlas.example.com/sub',
        ttl_ms: 60 * 60_000,
      });
      expect((postCall?.[1]?.headers as Record<string, string>)['X-Source']).toBe('ai_chat');
    });
  });

  test('NodesPanel exposes nodes via DataView query and supports region/search filtering', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/preview')) {
        return jsonResponse({
          data: {
            before: { count: 3, names: ['🇭🇰 香港 01', '🇯🇵 东京 01', '🇯🇵 大阪 02'], truncated: false },
            after: { count: 3, names: ['🇭🇰 香港 01', '🇯🇵 东京 01', '🇯🇵 大阪 02'], truncated: false },
            issues: [],
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    render(
      <NodesPanel
        target={{ kind: 'subscription', id: 'sub-1' }}
        operators={[]}
        version={100}
        enabled
      />,
    );

    expect(await screen.findByText('东京 01')).toBeTruthy();

    const queried = await agent.query({ within: '节点列表', text: '东京' });
    expect(Array.isArray(queried)).toBe(true);
    if (!Array.isArray(queried)) throw new Error(queried.error);
    expect(queried[0]?.items?.map((i) => i.label)).toEqual(['🇯🇵 东京 01']);

    const filterRes = await agent.act({
      steps: [{ ref: '搜索节点名称', action: 'setValue', args: ['大阪'] }],
    });
    expect(filterRes.ok, filterRes.error?.message).toBe(true);

    const afterFilter = agent.snapshot().find((e) => !e.offPage && e.label === '节点列表');
    expect(afterFilter?.summary).toBe('筛选后 1 / 3 个节点');
    expect(afterFilter?.items?.map((i) => i.label)).toEqual(['🇯🇵 大阪 02']);
  });

  test('SourceSettings gates SaveBar save and deleteSource confirmAction', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/subscriptions/sub-1/usage')) {
        return jsonResponse({ data: { profiles: [], collections: [] } });
      }
      if (url.includes('/subscriptions/sub-1') && method === 'PATCH') {
        return jsonResponse({ data: { ...SAMPLE_SOURCE, display_name: 'Nebula Pro' } });
      }
      if (url.includes('/subscriptions/sub-1') && method === 'DELETE') {
        return jsonResponse({ data: { warnings: [] } });
      }
      if (url.includes('/subscriptions') && method === 'GET') {
        return jsonResponse({ data: [SAMPLE_SOURCE] });
      }
      return jsonResponse({ data: {} });
    });

    render(
      <>
        <SourceSettings source={SAMPLE_SOURCE} active />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    const editRes = await runAgentAct(
      { steps: [{ ref: '显示名称', action: 'setValue', args: ['Nebula Pro'] }] },
      { agent },
    );
    expect(editRes.ok, editRes.error?.message).toBe(true);
    expect(await screen.findByText('有未保存的修改')).toBeTruthy();

    allowConfirm = false;
    const deniedSave = await runAgentAct(
      { steps: [{ ref: '保存', action: 'press' }] },
      { agent },
    );
    expect(deniedSave.ok).toBe(false);

    allowConfirm = true;
    const approvedSave = await runAgentAct(
      { steps: [{ ref: '保存', action: 'press' }] },
      { agent },
    );
    expect(approvedSave.ok, approvedSave.error?.message).toBe(true);

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(
        ([u, init]) => String(u).includes('/subscriptions/sub-1') && init?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ display_name: 'Nebula Pro' });
    });

    const openDelete = await runAgentAct(
      { steps: [{ ref: '删除订阅源', action: 'press' }] },
      { agent },
    );
    expect(openDelete.ok, openDelete.error?.message).toBe(true);
    expect(await screen.findByText('删除「Nebula 机场」？')).toBeTruthy();

    allowConfirm = false;
    const deniedDelete = await runAgentAct(
      { steps: [{ ref: '删除「Nebula 机场」？', action: 'press', args: ['确认永久删除'] }] },
      { agent },
    );
    expect(deniedDelete.ok).toBe(false);

    const reopenDelete = await runAgentAct(
      { steps: [{ ref: '删除订阅源', action: 'press' }] },
      { agent },
    );
    expect(reopenDelete.ok, reopenDelete.error?.message).toBe(true);
    expect(await screen.findByText('删除「Nebula 机场」？')).toBeTruthy();

    allowConfirm = true;
    const approvedDelete = await runAgentAct(
      { steps: [{ ref: '删除「Nebula 机场」？', action: 'press', args: ['确认永久删除'] }] },
      { agent },
    );
    expect(approvedDelete.ok, approvedDelete.error?.message).toBe(true);

    await waitFor(() => {
      const delCall = fetchSpy.mock.calls.find(
        ([u, init]) => String(u).includes('/subscriptions/sub-1') && init?.method === 'DELETE',
      );
      expect(delCall).toBeTruthy();
      expect((delCall?.[1]?.headers as Record<string, string>)['X-Source']).toBe('ai_chat');
    });
  });

  test('server-manual sources are excluded from bulk refresh, toggleable in settings, and skip post-create refresh', async () => {
    const manualOnlySource: Source = {
      ...SAMPLE_SOURCE,
      id: 'sub-mitce',
      name: 'mitce',
      display_name: 'Mitce',
      refresh_mode: 'server-manual',
      fetch_health: null,
      manual_snapshot: {
        updated_at: Math.floor(Date.now() / 1000) - 120,
        proxy_count: 12,
        origin: 'server',
        source_changed: false,
      },
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.includes('/subscriptions/sub-1/refresh') && method === 'POST') {
        return jsonResponse({ data: SAMPLE_SOURCE, meta: { proxyCount: 3 } });
      }
      if (url.includes('/subscriptions/sub-1') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({ data: { ...SAMPLE_SOURCE, ...body } });
      }
      if (url.endsWith('/api/v1/subscriptions') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({ data: { ...manualOnlySource, ...body, id: 'sub-created', manual_snapshot: null } });
      }
      if (url.includes('/subscriptions') && method === 'GET') {
        return jsonResponse({ data: [SAMPLE_SOURCE, manualOnlySource] });
      }
      if (url.includes('/collections') && method === 'GET') {
        return jsonResponse({ data: [] });
      }
      if (url.includes('/meta')) {
        return jsonResponse({ data: { subBase: 'https://pm.example.com/sub/tok' } });
      }
      return jsonResponse({ data: {} });
    });

    const { unmount } = render(
      <>
        <SourcesIndex />
        <FeedbackHost />
        <AppToaster />
      </>,
    );

    expect(await screen.findByText('Mitce')).toBeTruthy();
    expect(screen.getAllByText('仅手动刷新').length).toBeGreaterThan(0);

    allowConfirm = true;
    const bulkRefresh = await runAgentAct({ steps: [{ ref: '全部刷新', action: 'press' }] }, { agent });
    expect(bulkRefresh.ok, bulkRefresh.error?.message).toBe(true);

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(([u, init]) => String(u).includes('/subscriptions/sub-1/refresh') && init?.method === 'POST'),
      ).toBe(true);
    });
    expect(
      fetchSpy.mock.calls.some(([u, init]) => String(u).includes('/subscriptions/sub-mitce/refresh') && init?.method === 'POST'),
    ).toBe(false);

    unmount();

    // SourceSettings: turning off 自动刷新 hides TTL and PATCHes refresh_mode: 'server-manual'.
    const settingsView = render(
      <>
        <SourceSettings source={SAMPLE_SOURCE} active />
        <FeedbackHost />
        <AppToaster />
      </>,
    );
    const toggleOff = await runAgentAct(
      { steps: [{ ref: '自动刷新上游订阅', action: 'setChecked', args: [false] }] },
      { agent },
    );
    expect(toggleOff.ok, toggleOff.error?.message).toBe(true);
    expect(screen.queryByLabelText('缓存时长')).toBeNull();

    const saveOff = await runAgentAct({ steps: [{ ref: '保存', action: 'press' }] }, { agent });
    expect(saveOff.ok, saveOff.error?.message).toBe(true);
    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(
        ([u, init]) => String(u).includes('/subscriptions/sub-1') && init?.method === 'PATCH',
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ refresh_mode: 'server-manual' });
    });
    settingsView.unmount();

    // AddSourceDialog: turning off 自动刷新 POSTs refresh_mode: 'server-manual' and never auto-refreshes.
    fetchSpy.mockClear();
    render(
      <>
        <AddSourceDialog open onOpenChange={vi.fn()} sources={[SAMPLE_SOURCE]} />
        <AppToaster />
      </>,
    );
    const createManual = await runAgentAct(
      {
        steps: [
          { ref: '订阅链接', action: 'setValue', args: ['https://mitce.example.com/sub'] },
          { ref: '显示名称', action: 'setValue', args: ['Mitce New'] },
          { ref: '标识', action: 'setValue', args: ['mitce-new'] },
          { ref: '自动刷新上游订阅', action: 'setChecked', args: [false] },
          { ref: '确认添加', action: 'press' },
        ],
      },
      { agent },
    );
    expect(createManual.ok, createManual.error?.message).toBe(true);

    await waitFor(() => {
      const postCall = fetchSpy.mock.calls.find(
        ([u, init]) => String(u).endsWith('/api/v1/subscriptions') && init?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
        name: 'mitce-new',
        refresh_mode: 'server-manual',
      });
    });
    expect(
      fetchSpy.mock.calls.some(([u, init]) => String(u).includes('/refresh') && init?.method === 'POST'),
    ).toBe(false);
  });
});
