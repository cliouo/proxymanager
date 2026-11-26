import Link from 'next/link';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button as UiButton } from '@ui-sdk/react/button';
import { createAgent } from '@ui-sdk/react/agent';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentHost, clearAgentConfirms, createAppAllow, customTools } from '@/ui/agent';
import { dispatchAgentTool, toOpenAiTools } from '@/ui/assistant/agent';

const agent = createAgent({ allow: createAppAllow() });

afterEach(() => {
  clearAgentConfirms();
  vi.restoreAllMocks();
  delete (document as Document & { modelContext?: unknown }).modelContext;
});

describe('shared customTools for WebMCP and in-site AI', () => {
  test('toOpenAiTools exposes agentTools plus all customTools', () => {
    const names = toOpenAiTools().map((t) => t.function.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'snapshot',
        'query',
        'act',
        'wait_for',
        'search_mihomo_docs',
        'fetch_url',
        'preview_direct_alias_migration',
        'migrate_direct_alias',
        'preview_legacy_profile_repair',
        'repair_legacy_profile',
        'preview_legacy_chain_profile_repair',
        'repair_legacy_chain_profile',
      ]),
    );
  });

  test('in-site AI dispatches read customTools with X-Source: ai_chat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            question: 'dns 配置',
            repo: 'MetaCubeX/Meta-Docs',
            answer: 'dns:\n  enable: true',
            source: 'https://deepwiki.com/MetaCubeX/Meta-Docs',
            untrusted: true,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const result = await dispatchAgentTool(
      'search_mihomo_docs',
      { question: 'dns 配置' },
      { agent },
    );
    expect(result.kind).toBe('custom');
    expect(result.data).toMatchObject({ answer: 'dns:\n  enable: true', untrusted: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/tools/mihomo-docs');
    expect((init?.headers as Record<string, string>)['X-Source']).toBe('ai_chat');
  });

  test('WebMCP registers all customTools, tags X-Source: webmcp, gates writes via AgentConfirmDialog, and unregisters on unmount', async () => {
    const user = userEvent.setup();
    const tools = new Map<string, { name: string; execute: (input: object) => Promise<unknown> }>();

    Object.assign(document, {
      modelContext: {
        registerTool: async (
          tool: { name: string; execute: (input: object) => Promise<unknown> },
          options?: { signal?: AbortSignal },
        ) => {
          tools.set(tool.name, tool);
          options?.signal?.addEventListener('abort', () => tools.delete(tool.name), { once: true });
        },
      },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.includes('/tools/fetch-url')) {
        return new Response(
          JSON.stringify({ data: { url: body.url, content: 'rules', bytes: 5, untrusted: true } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/tools/direct-alias-migration') && body.action === 'apply') {
        return new Response(
          JSON.stringify({ data: { summary: { alias: '直连' }, newVersion: 6, auditEventId: 'e1' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { unmount } = render(<AgentHost agent={agent} />);

    await waitFor(() => {
      for (const tool of customTools) {
        expect(tools.has(tool.name)).toBe(true);
      }
    });

    // Read tool runs immediately with X-Source: webmcp
    const fetched = await tools.get('fetch_url')!.execute({ url: 'https://example.com/a.yaml' });
    expect(fetched).toMatchObject({ content: 'rules', untrusted: true });
    expect((fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>)['X-Source']).toBe('webmcp');

    // Write tool asks for confirmation; deny prevents apply call
    const deniedPromise = tools.get('migrate_direct_alias')!.execute({
      alias: '直连',
      expected_version: 5,
      expected_base_etag: '0123456789abcdef',
      expected_subscription_failure_signature: 'sig-1',
    });
    expect(await screen.findByText(/迁移为内建 DIRECT/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '拒绝' }));
    const denied = await deniedPromise;
    expect(denied).toMatchObject({ ok: false });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Approve executes apply with X-Source: webmcp
    const approvedPromise = tools.get('migrate_direct_alias')!.execute({
      alias: '直连',
      expected_version: 5,
      expected_base_etag: '0123456789abcdef',
      expected_subscription_failure_signature: 'sig-1',
    });
    expect(await screen.findByText(/迁移为内建 DIRECT/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '允许执行' }));
    const approved = await approvedPromise;
    expect(approved).toMatchObject({ newVersion: 6, auditEventId: 'e1' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect((fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>)['X-Source']).toBe('webmcp');

    // Unmount unregisters custom tools too
    unmount();
    for (const tool of customTools) {
      expect(tools.has(tool.name)).toBe(false);
    }
  });

  test('WebMCP unmount swallows AbortError rejections from native registerTool Promises', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    Object.assign(document, {
      modelContext: {
        registerTool: (_tool: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('signal is aborted without reason', 'AbortError')),
              { once: true },
            );
          }),
      },
    });

    try {
      const { unmount } = render(<AgentHost agent={agent} />);
      unmount();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('wait_for wakes up immediately when target DOM renders via MutationObserver', async () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.innerHTML = '<div class="skeleton"></div>';
    document.body.appendChild(main);
    try {
      const waitPromise = dispatchAgentTool(
        'wait_for',
        { text: '主力配置', timeout_ms: 2000 },
        { agent },
      );

      setTimeout(() => {
        const card = document.createElement('div');
        card.textContent = '主力配置';
        main.appendChild(card);
      }, 30);

      const res = await waitPromise;
      expect(res.kind).toBe('custom');
      expect(res.data).toMatchObject({ found: true, loading: true });
      expect((res.data as { waitedMs: number }).waitedMs).toBeLessThan(1000);
    } finally {
      main.remove();
    }
  });

  test('wait_for ignores sidebar navigation buttons and waits for target text inside #main', async () => {
    render(
      <div>
        <aside data-takeover-sidebar>
          <nav aria-label="主导航">
            <UiButton render={<Link href="/sources" onClick={(e) => e.preventDefault()} />}>节点来源</UiButton>
          </nav>
        </aside>
        <main id="main">
          <h1>规则集</h1>
        </main>
      </div>,
    );

    const waitPromise = dispatchAgentTool('wait_for', { text: '节点来源', timeout_ms: 1500 }, { agent });

    setTimeout(() => {
      const main = document.getElementById('main');
      if (main) main.innerHTML = '<h1>节点来源</h1>';
    }, 45);

    const res = await waitPromise;
    expect(res.kind).toBe('custom');
    const data = res.data as { found: boolean; waitedMs: number };
    expect(data.found).toBe(true);
    expect(data.waitedMs).toBeGreaterThanOrEqual(25);
  });
});
