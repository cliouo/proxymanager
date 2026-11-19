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

  it.each(['incompatible', 'unverified'] as const)(
    'rechecks cached bytes before 304 and recovers (%s)',
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
      const fixed = CONFIG.replace('MATCH,DIRECT', 'DOMAIN,example.com,HK-1');
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
