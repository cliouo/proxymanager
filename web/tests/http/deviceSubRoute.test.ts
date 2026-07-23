/**
 * 设备订阅链接 `/api/sub/{token}/{profile}/{device}`。
 *
 * 语义必须与兄弟路由 `/{profile}` 对齐：同一把令牌（资源作用域仍是 profile）、
 * 同样的 ETag/304、同样的 noCache，外加设备维度的文件名与 base64 格式。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renderDeviceConfig = vi.hoisted(() => vi.fn());
const getProfileByName = vi.hoisted(() => vi.fn());
const guardSubToken = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/engine/renderCache', () => ({ renderDeviceConfig }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfileByName }));
vi.mock('@/lib/http/subGuard', () => ({ guardSubToken }));

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
    sharedCache: 'hit',
    ...over,
  };
}

describe('/api/sub/{token}/{profile}/{device}', () => {
  let GET: (req: Request, ctx: never) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    getProfileByName.mockResolvedValue({ name: 'home', kind: 'normal' });
    renderDeviceConfig.mockResolvedValue(rendered());
    ({ GET } = await import('@/app/api/sub/[token]/[profile]/[device]/route'));
  });

  afterEach(() => vi.resetModules());

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
    expect(guardSubToken).toHaveBeenCalledWith(expect.anything(), 'tk', 'home');
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

  it('forwards ?noCache=1 and the provider URL base', async () => {
    await GET(
      new Request('https://pm.test/api/sub/tk/home/macbook?noCache=1'),
      ctx('tk', 'home', 'macbook'),
    );
    expect(renderDeviceConfig).toHaveBeenCalledWith('home', 'macbook', {
      providerUrlBase: 'https://pm.test/api/rule-providers/tk',
      noCache: true,
    });
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
