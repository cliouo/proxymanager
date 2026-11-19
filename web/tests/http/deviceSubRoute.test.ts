/**
 * 设备订阅链接 `/api/sub/{token}/{profile}/{device}`。
 *
 * 语义必须与兄弟路由 `/{profile}` 对齐：同一把令牌（资源作用域仍是 profile）、
 * 同样的 ETag/304、同样的 noCache，外加设备维度的文件名与 base64 格式。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderDeviceConfig = vi.hoisted(() => vi.fn());
const renderProfileConfig = vi.hoisted(() => vi.fn());
const getProfileByName = vi.hoisted(() => vi.fn());
const guardSubToken = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/engine/renderCache', () => ({ renderDeviceConfig, renderProfileConfig }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfileByName }));
vi.mock('@/lib/http/subGuard', () => ({ guardSubToken }));

vi.mock('@/lib/engine/shadowrocketCompatibility', { spy: true });

const CONFIG = `mixed-port: 7891
proxies:
  - {name: HK-1, type: ss, server: hk.example.com, port: 8388, cipher: aes-128-gcm, password: p}
proxy-groups: []
rules:
  - MATCH,DIRECT
`;

// The real checker accepts only plain HTTP exits reached through a select
// group; an SS node named directly by a rule is still unverified.
const COMPATIBLE_CONFIG = `mode: rule
proxies:
  - {name: A, type: http, server: proxy.example, port: 8080}
proxy-groups:
  - {name: 出口, type: select, proxies: [A]}
rules:
  - DOMAIN,example.com,出口
`;

const BROKEN_CONFIG = `mode: rule
proxies:
  - {name: HK-1, type: ss, server: hk.example.com, port: 8388, cipher: aes-128-gcm, password: p}
proxy-groups: []
rules:
  - DOMAIN,example.com,HK-1
`;

// A GLOBAL select holding one plain HTTP node passes the final validator, so
// only the unverified running mode stands between this input and a 200.
const GLOBAL_HTTP_CONFIG = (rules: string) => `mode: global
proxies:
  - {name: A, type: http, server: proxy.example, port: 8080}
proxy-groups:
  - {name: GLOBAL, type: select, proxies: [A]}
${rules}
`;

function ctx(token: string, profile: string, device: string) {
  return { params: Promise.resolve({ token, profile, device }) } as never;
}

function rendered(over: Record<string, unknown> = {}) {
  return {
    resolved: { content: CONFIG, buildId: 'dev-build', inlinedProxyCount: 2 },
    displayName: null,
    deviceDisplayName: null,
    cache: 'miss',
    sharedCache: 'miss',
    ...over,
  };
}

function expectModeGlobalProblem(problem: {
  detail: string;
  errors: Record<string, unknown>[];
}): void {
  expect(problem.errors).toHaveLength(1);
  expect(problem.errors[0]).toMatchObject({
    status: 'unverified',
    mode: 'global',
    reference: 'GLOBAL',
  });
  // The gap is mode: global itself: no member or option is implicated and no
  // rule position is invented for rules the mode never evaluates.
  expect(problem.errors[0]).not.toHaveProperty('member');
  expect(problem.errors[0]).not.toHaveProperty('option');
  expect(problem.errors[0]).not.toHaveProperty('ruleNumber');
  expect(problem.detail).toContain('运行模式 global');
  expect(problem.detail).toContain('GLOBAL');
  expect(problem.detail).not.toContain('条规则');
}

describe('/api/sub/{token}/{profile}/{device}', () => {
  let GET: (req: Request, ctx: never) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    getProfileByName.mockResolvedValue({ id: 'p-home', name: 'home', kind: 'normal' });
    renderDeviceConfig.mockResolvedValue(rendered());
    ({ GET } = await import('@/app/api/sub/[token]/[profile]/[device]/route'));
  });

  afterEach(() => vi.resetModules());

  const deviceUrl = 'https://pm.test/api/sub/tk/home/macbook';
  const special = (etag?: string, query = '') =>
    GET(
      new Request(deviceUrl + '?client=shadowrocket' + query, {
        headers: etag ? { 'If-None-Match': etag } : {},
      }),
      ctx('tk', 'home', 'macbook'),
    );

  it('uses the link parameter and preserves the scoped render and bytes', async () => {
    const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
    vi.mocked(checkShadowrocketRules).mockReturnValueOnce([]);
    const response = await special(undefined, '&noCache=1');
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(CONFIG));
    expect(checkShadowrocketRules).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(renderDeviceConfig).toHaveBeenCalledWith('home', 'macbook', {
      expectedProfileId: 'p-home',
      providerUrlBase: 'https://pm.test/api/rule-providers/tk',
      noCache: true,
    });
    expect(
      (
        await GET(
          new Request(deviceUrl, { headers: { 'User-Agent': 'Shadowrocket/3488' } }),
          ctx('tk', 'home', 'macbook'),
        )
      ).status,
    ).toBe(200);
    expect(checkShadowrocketRules).toHaveBeenCalledTimes(1);
  });

  it('rejects the token before rendering or checking', async () => {
    const { ProblemDetailsError } = await import('@/lib/http/problem');
    const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
    guardSubToken.mockRejectedValueOnce(ProblemDetailsError.unauthorized());
    expect((await special()).status).toBe(401);
    expect(renderDeviceConfig).not.toHaveBeenCalled();
    expect(checkShadowrocketRules).not.toHaveBeenCalled();
  });

  it('runs the real compatibility checker through 200 → 422 → 200 and a compatible 304', async () => {
    const actual = await vi.importActual<typeof import('@/lib/engine/shadowrocketCompatibility')>(
      '@/lib/engine/shadowrocketCompatibility',
    );
    const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
    vi.mocked(checkShadowrocketRules).mockImplementation(actual.checkShadowrocketRules);
    renderDeviceConfig.mockReset();
    renderDeviceConfig
      .mockResolvedValueOnce(
        rendered({
          resolved: { content: COMPATIBLE_CONFIG, buildId: 'compatible-1', inlinedProxyCount: 1 },
        }),
      )
      // Fresh bytes under the client's old ETag must still be checked first.
      .mockResolvedValueOnce(
        rendered({
          resolved: { content: BROKEN_CONFIG, buildId: 'compatible-1', inlinedProxyCount: 1 },
        }),
      )
      .mockResolvedValueOnce(
        rendered({
          resolved: { content: COMPATIBLE_CONFIG, buildId: 'compatible-2', inlinedProxyCount: 1 },
        }),
      )
      .mockResolvedValueOnce(
        rendered({
          resolved: { content: COMPATIBLE_CONFIG, buildId: 'compatible-2', inlinedProxyCount: 1 },
        }),
      );

    const first = await special();
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBe('"compatible-1"');

    const blocked = await special(etag);
    expect(blocked.status).toBe(422);
    const problem = await blocked.json();
    expect(problem.errors).toMatchObject([
      { status: 'unverified', ruleNumber: 1, ruleType: 'DOMAIN', target: 'HK-1' },
    ]);
    expect(problem.detail).toContain('HK-1');
    expect(checkShadowrocketRules).toHaveBeenCalledTimes(2);

    const recovered = await special(etag);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toBe(COMPATIBLE_CONFIG);

    const cached = await special('"compatible-2"');
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect(checkShadowrocketRules).toHaveBeenCalledTimes(4);
  });

  it('locates listener and TUN diagnostics in the 422 detail without a fake rule number', async () => {
    const actual = await vi.importActual<typeof import('@/lib/engine/shadowrocketCompatibility')>(
      '@/lib/engine/shadowrocketCompatibility',
    );
    const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
    vi.mocked(checkShadowrocketRules).mockImplementation(actual.checkShadowrocketRules);

    const listenerConfig =
      COMPATIBLE_CONFIG +
      `listeners:
  - {name: mixed-in, type: mixed, port: 7890, rule: office}
sub-rules:
  office:
    - PROCESS-NAME,reader,出口
`;
    renderDeviceConfig.mockResolvedValueOnce(
      rendered({
        resolved: { content: listenerConfig, buildId: 'listener', inlinedProxyCount: 1 },
      }),
    );
    const listenerProblem = await (await special()).json();
    expect(listenerProblem.errors).toMatchObject([
      {
        status: 'unverified',
        listener: 'mixed-in',
        table: 'office',
        ruleNumber: 1,
        ruleType: 'PROCESS-NAME',
        target: '出口',
      },
    ]);
    expect(listenerProblem.detail).toContain('监听器 mixed-in');
    expect(listenerProblem.detail).toContain('子规则表 office');
    expect(listenerProblem.detail).toContain('PROCESS-NAME');
    expect(listenerProblem.detail).toContain('出口');

    const tunConfig =
      COMPATIBLE_CONFIG +
      `tun: {enable: true, auto-route: true, auto-redirect: true, route-exclude-address-set: [remote-ip]}
rule-providers:
  remote-ip: {type: http, behavior: ipcidr}
`;
    renderDeviceConfig.mockResolvedValueOnce(
      rendered({ resolved: { content: tunConfig, buildId: 'tun', inlinedProxyCount: 1 } }),
    );
    const tunProblem = await (await special()).json();
    expect(tunProblem.errors).toMatchObject([
      {
        status: 'unverified',
        field: 'route-exclude-address-set',
        setName: 'remote-ip',
      },
    ]);
    expect(tunProblem.errors[0].ruleNumber).toBeUndefined();
    expect(tunProblem.detail).toContain('TUN 字段 route-exclude-address-set');
    expect(tunProblem.detail).toContain('remote-ip');

    const globalConfig = `mode: global
proxies:
  - {name: A, type: http, server: proxy.example, port: 8080}
  - {name: B, type: socks5, server: secret.example, port: 1080, password: secret}
proxy-groups:
  - {name: GLOBAL, type: select, proxies: [A, B]}
rules: []
`;
    renderDeviceConfig.mockResolvedValueOnce(
      rendered({ resolved: { content: globalConfig, buildId: 'global', inlinedProxyCount: 2 } }),
    );
    const globalProblem = await (await special()).json();
    expect(globalProblem.errors).toMatchObject([
      {
        status: 'unverified',
        mode: 'global',
        reference: 'GLOBAL',
        member: 'B',
        option: expect.stringContaining('type=socks5'),
      },
    ]);
    expect(globalProblem.errors[0].ruleNumber).toBeUndefined();
    expect(globalProblem.detail).toContain('运行模式 global');
    expect(globalProblem.detail).toContain('GLOBAL');
    expect(globalProblem.detail).toContain('B');
    expect(globalProblem.detail).toContain('type=socks5');
    expect(JSON.stringify(globalProblem)).not.toContain('secret.example');
    expect(JSON.stringify(globalProblem)).not.toContain('"secret"');
  });

  const GLOBAL_RULE_INPUTS = [
    ['empty rules', 'rules: []'],
    [
      'a DOMAIN rule for GLOBAL that global mode never evaluates',
      'rules:\n  - DOMAIN,idle.example,GLOBAL',
    ],
  ] as const;

  it.each(GLOBAL_RULE_INPUTS)(
    '422s the first mode:global request with %s and a plain HTTP GLOBAL',
    async (_label, rules) => {
      const actual = await vi.importActual<typeof import('@/lib/engine/shadowrocketCompatibility')>(
        '@/lib/engine/shadowrocketCompatibility',
      );
      const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
      vi.mocked(checkShadowrocketRules).mockImplementation(actual.checkShadowrocketRules);
      renderDeviceConfig.mockResolvedValue(
        rendered({
          resolved: {
            content: GLOBAL_HTTP_CONFIG(rules),
            buildId: 'global-http',
            inlinedProxyCount: 1,
          },
        }),
      );

      const response = await special();
      expect(response.status).toBe(422);
      expectModeGlobalProblem(await response.json());
      expect(checkShadowrocketRules).toHaveBeenCalledOnce();
    },
  );

  it.each(GLOBAL_RULE_INPUTS)(
    '422s the conditional mode:global request with %s instead of 304',
    async (_label, rules) => {
      const actual = await vi.importActual<typeof import('@/lib/engine/shadowrocketCompatibility')>(
        '@/lib/engine/shadowrocketCompatibility',
      );
      const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
      vi.mocked(checkShadowrocketRules).mockImplementation(actual.checkShadowrocketRules);
      renderDeviceConfig.mockResolvedValue(
        rendered({
          resolved: {
            content: GLOBAL_HTTP_CONFIG(rules),
            buildId: 'global-http',
            inlinedProxyCount: 1,
          },
        }),
      );

      const response = await special('"global-http"');
      expect(response.status).toBe(422);
      expectModeGlobalProblem(await response.json());
      expect(checkShadowrocketRules).toHaveBeenCalledOnce();
    },
  );

  it.each(['incompatible', 'unverified'] as const)(
    'rechecks synthetic cached bytes before 304 and recovers (%s)',
    async (status) => {
      const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
      const issue = {
        status,
        ruleNumber: 2,
        ruleType: 'RULE-SET',
        target: '出口',
        reference: 'remote',
        reason: '合成诊断',
      };
      vi.mocked(checkShadowrocketRules)
        .mockReturnValueOnce([])
        .mockReturnValueOnce([issue])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([])
        .mockReturnValueOnce([]);
      const previous = await special();
      const etag = previous.headers.get('etag')!;
      renderDeviceConfig.mockResolvedValue(rendered({ cache: 'hit' }));
      const blocked = await special(etag);
      expect(blocked.status).toBe(422);
      expect(blocked.headers.get('Content-Type')).toContain('application/problem+json');
      const problem = await blocked.json();
      expect(problem.errors).toEqual([issue]);
      for (const part of [
        status === 'incompatible' ? '已知不兼容' : '待验证',
        '2',
        'RULE-SET',
        '出口',
        'remote',
        '合成诊断',
      ]) {
        expect(problem.detail).toContain(part);
      }
      expect((await special()).status).toBe(200);
      expect((await special(etag)).status).toBe(304);
      const fixed = COMPATIBLE_CONFIG;
      renderDeviceConfig.mockResolvedValue(
        rendered({ resolved: { content: fixed, buildId: 'fixed', inlinedProxyCount: 1 } }),
      );
      const recovered = await special(etag);
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toBe(fixed);
    },
  );

  it('streams large 422 reports with every diagnostic in final rule order', async () => {
    const { checkShadowrocketRules } = await import('@/lib/engine/shadowrocketCompatibility');
    const issues = Array.from({ length: 28000 }, (_, i) => ({
      status: 'unverified' as const,
      ruleNumber: i + 1,
      ruleType: 'DST-PORT',
      target: '出口',
      reason: '该规则类型、匹配条件或参数缺少 Clash YAML 导入后的分流依据。',
    }));
    vi.mocked(checkShadowrocketRules).mockReturnValueOnce(issues);
    const response = await special();
    expect(response.status).toBe(422);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      expect(part.value.length).toBeLessThan(256 * 1024);
      chunks.push(part.value);
    }
    const body = Buffer.concat(chunks);
    expect(body.length).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(JSON.parse(body.toString()).errors).toEqual(issues);
  });

  it('uses the real checker for a mutable rule provider without exposing its URL', async () => {
    const content =
      CONFIG.replace('MATCH,DIRECT', 'RULE-SET,remote,DIRECT') +
      'rule-providers: {remote: {type: http, behavior: domain, url: "https://example.org/private-path"}}';
    renderDeviceConfig.mockResolvedValue(rendered({ resolved: { content, buildId: 'remote' } }));
    const response = await special('"dev-build"');
    expect(response.status).toBe(422);
    const problem = await response.json();
    expect(problem.errors).toMatchObject([
      { reference: 'remote', status: 'unverified', ruleNumber: 1 },
    ]);
    expect(JSON.stringify(problem)).not.toContain('private-path');
  });

  it.each(['base64', 'v2ray'])('rejects conflicting device link purposes (%s)', async (format) => {
    expect((await special(undefined, '&format=' + format)).status).toBe(400);
    expect(renderDeviceConfig).not.toHaveBeenCalled();
  });

  it('serves the device config with a device-specific ETag', async () => {
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONFIG);
    expect(res.headers.get('ETag')).toBe('"dev-build"');
    expect(res.headers.get('Content-Type')).toContain('text/yaml');
    expect(res.headers.get('X-Render-Cache')).toBe('miss');
  });

  it('guards with the PROFILE as the token resource (设备不引入第三种令牌)', async () => {
    await GET(new Request('https://pm.test/api/sub/tk/home/macbook'), ctx('tk', 'home', 'macbook'));
    expect(guardSubToken).toHaveBeenCalledWith(
      expect.anything(),
      'tk',
      expect.objectContaining({ type: 'profile', id: 'p-home' }),
    );
  });

  it('names the file after the device', async () => {
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(res.headers.get('Content-Disposition')).toContain('proxymanager-home-macbook.yaml');
  });

  it("prefers the device's own display_name for the filename", async () => {
    renderDeviceConfig.mockResolvedValue(rendered({ deviceDisplayName: '我的笔记本' }));
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(res.headers.get('Content-Disposition')).toContain('filename*');
  });

  it('304s a matching If-None-Match', async () => {
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook', {
        headers: { 'if-none-match': '"dev-build"' },
      }),
      ctx('tk', 'home', 'macbook'),
    );
    expect(res.status).toBe(304);
  });

  it('returns changed content instead of 304 when the client sends the previous build ETag', async () => {
    const updated = CONFIG.replace('8388', '64321');
    renderDeviceConfig.mockResolvedValue(
      rendered({ resolved: { content: updated, buildId: 'updated-build', inlinedProxyCount: 2 } }),
    );
    const response = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook', {
        headers: { 'if-none-match': '"dev-build"' },
      }),
      ctx('tk', 'home', 'macbook'),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('ETag')).toBe('"updated-build"');
    expect(await response.text()).toContain('port: 64321');
  });

  it('forwards ?noCache=1 and the provider URL base', async () => {
    await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook?noCache=1'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(renderDeviceConfig).toHaveBeenCalledWith('home', 'macbook', {
      expectedProfileId: 'p-home',
      providerUrlBase: 'https://pm.test/api/rule-providers/tk',
      noCache: true,
    });
  });

  it('public device distribution keeps fetch-health recording enabled (no preview flag)', async () => {
    await GET(new Request('https://pm.test/api/sub/tk/home/macbook'), ctx('tk', 'home', 'macbook'));
    const opts = renderDeviceConfig.mock.calls[0]?.[2] as { recordFetchHealth?: boolean };
    // Real distribution is a genuine attempt: health must be recorded, so the
    // option is absent (defaults true) rather than preview-suppressed.
    expect(opts.recordFetchHealth).toBeUndefined();
  });

  it('emits a base64 share-link subscription for ?format=base64', async () => {
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook?format=base64'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    expect(res.headers.get('Content-Disposition')).toContain('.txt');
    const decoded = Buffer.from(await res.text(), 'base64').toString('utf8');
    expect(decoded).toContain('ss://');
    // base64 与 yaml 必须是不同的 ETag，否则客户端换格式拿到 304 空响应。
    expect(res.headers.get('ETag')).toBe('"dev-build-b64"');
  });

  it('400s an unknown format instead of silently falling back', async () => {
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook?format=toml'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(res.status).toBe(400);
  });

  it('404s a template profile (Phase T 的闸门对设备链接同样有效)', async () => {
    getProfileByName.mockResolvedValue({ name: 'simple', kind: 'template' });
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/simple/macbook'),
      ctx('tk', 'simple', 'macbook'),
    );
    expect(res.status).toBe(404);
    expect(renderDeviceConfig).not.toHaveBeenCalled();
  });

  it('propagates the renderer 404 for an unknown device', async () => {
    const { ProblemDetailsError } = await import('@/lib/http/problem');
    renderDeviceConfig.mockRejectedValue(ProblemDetailsError.notFound('设备 "ghost" 不存在。'));
    const res = await GET(
      new Request('https://pm.test/api/sub/tk/home/ghost'),
      ctx('tk', 'home', 'ghost'),
    );
    expect(res.status).toBe(404);
  });
});

describe('shared profile conditional requests', () => {
  it.each([
    ['dev-build', 304],
    ['updated-build', 200],
  ])('renders current content before comparing a client ETag (%s)', async (buildId, status) => {
    getProfileByName.mockResolvedValue({ id: 'p-home', name: 'home', kind: 'normal' });
    renderProfileConfig.mockResolvedValue(
      rendered({ resolved: { content: CONFIG, buildId, inlinedProxyCount: 1 } }),
    );
    const { GET } = await import('@/app/api/sub/[token]/[profile]/route');
    const response = await GET(
      new Request('https://pm.test/api/sub/tk/home', {
        headers: { 'if-none-match': '"dev-build"' },
      }),
      { params: Promise.resolve({ token: 'tk', profile: 'home' }) } as never,
    );
    expect(response.status).toBe(status);
    expect(renderProfileConfig).toHaveBeenCalledWith(
      'home',
      expect.objectContaining({ expectedProfileId: 'p-home', noCache: false }),
    );
    expect(response.headers.get('X-Render-Cache')).toBe('miss');
  });
});

it('serves Shadowrocket only on the shared profile with its own validator', async () => {
  getProfileByName.mockResolvedValue({ id: 'p-home', name: 'home', kind: 'normal' });
  renderProfileConfig.mockResolvedValue(rendered());
  const { GET } = await import('@/app/api/sub/[token]/[profile]/route');
  const url = 'https://pm.test/api/sub/tk/home?format=shadowrocket';
  const response = await GET(new Request(url), ctx('tk', 'home', ''));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('.conf');
  expect(await response.text()).toContain('FINAL,DIRECT');
  const etag = response.headers.get('etag')!;
  expect(etag).not.toBe('"dev-build"');
  const cached = await GET(new Request(url, { headers: { 'if-none-match': etag } }), ctx('tk', 'home', ''));
  expect(cached.status).toBe(304);
});
