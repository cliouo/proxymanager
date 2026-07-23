/**
 * Phase T「模版类型」的三条不变量：
 *   1. `kind` parse-forward —— 存量记录没有这个字段，读出来必须是 normal；
 *   2. 分发拒绝 —— `/api/sub/{token}/{profile}` 对模版 404，且**渲染之前**就短路；
 *   3. 切换器 / 列表页分组 —— 分组与置顶是纯函数，组件本身（.tsx）不进
 *      vitest 的收集范围，逻辑落在 lib/profiles/kind.ts 才测得到。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TEMPLATE_NAME_PREFIXES,
  isTemplateProfile,
  matchesTemplateNameConvention,
  partitionProfilesByKind,
  templatesFirst,
} from '@/lib/profiles/kind';
import { ProfileCreateSchema, ProfileSchema, ProfileUpdateSchema } from '@/schemas';

/* ─── 1. schema: kind parse-forward ─────────────────────────────────── */

const STORED_LEGACY = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'home',
  source: { type: 'subscription', id: '22222222-2222-4222-8222-222222222222' },
  updated_at: 1_700_000_000,
};

describe('ProfileSchema — kind parse-forward', () => {
  it('defaults a stored record with no kind to normal', () => {
    const parsed = ProfileSchema.parse(STORED_LEGACY);
    expect(parsed.kind).toBe('normal');
    expect(isTemplateProfile(parsed)).toBe(false);
    // parse-forward 只补 kind，其余字段原样保留。
    expect(parsed.name).toBe('home');
    expect(parsed.source).toEqual(STORED_LEGACY.source);
  });

  it('keeps an explicit template kind', () => {
    const parsed = ProfileSchema.parse({ ...STORED_LEGACY, kind: 'template' });
    expect(parsed.kind).toBe('template');
    expect(isTemplateProfile(parsed)).toBe(true);
  });

  it('rejects an unknown kind rather than silently normalising it', () => {
    expect(() => ProfileSchema.parse({ ...STORED_LEGACY, kind: 'draft' })).toThrow();
  });

  it('defaults create input to normal and accepts an explicit template', () => {
    expect(ProfileCreateSchema.parse({ name: 'fresh' }).kind).toBe('normal');
    expect(ProfileCreateSchema.parse({ name: 'tpl', kind: 'template' }).kind).toBe('template');
  });

  it('leaves kind untouched on a patch that does not mention it', () => {
    expect(ProfileUpdateSchema.parse({ notes: 'x' }).kind).toBeUndefined();
    expect(ProfileUpdateSchema.parse({ kind: 'template' }).kind).toBe('template');
  });
});

/* ─── 2. 分发拒绝：/api/sub/{token}/{profile} ────────────────────────── */

const renderProfileConfig = vi.hoisted(() => vi.fn());
const getProfileByName = vi.hoisted(() => vi.fn());
const guardSubToken = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('@/lib/engine/renderCache', () => ({ renderProfileConfig }));
vi.mock('@/lib/repos/profilesRepo', () => ({ getProfileByName }));
vi.mock('@/lib/http/subGuard', () => ({ guardSubToken }));

function ctx(token: string, profile: string) {
  return { params: Promise.resolve({ token, profile }) } as never;
}

function okRender() {
  return {
    resolved: { content: 'proxies: []\n', buildId: 'b1', inlinedProxyCount: 0 },
    displayName: undefined,
    cache: 'miss',
  };
}

describe('/api/sub/{token}/{profile} — 模版不可分发', () => {
  let GET: (req: Request, ctx: never) => Promise<Response>;

  beforeEach(async () => {
    vi.clearAllMocks();
    renderProfileConfig.mockResolvedValue(okRender());
    ({ GET } = await import('@/app/api/sub/[token]/[profile]/route'));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('404s a template and never reaches the renderer', async () => {
    getProfileByName.mockResolvedValue({ name: 'simple', kind: 'template' });

    const res = await GET(new Request('https://pm.test/api/sub/tk/simple'), ctx('tk', 'simple'));

    expect(res.status).toBe(404);
    expect(renderProfileConfig).not.toHaveBeenCalled();
    const body = (await res.json()) as { title: string; detail: string };
    expect(body.title).toBe('Not Found');
    expect(body.detail).toContain('模版不可分发');
    // 令牌闸门仍在模版判定之前跑 —— 模版的存在性不该绕过鉴权。
    expect(guardSubToken).toHaveBeenCalledWith(expect.anything(), 'tk', 'simple');
  });

  it('serves a normal profile as before', async () => {
    getProfileByName.mockResolvedValue({ name: 'home', kind: 'normal' });

    const res = await GET(new Request('https://pm.test/api/sub/tk/home'), ctx('tk', 'home'));

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Build-Id')).toBe('b1');
    expect(renderProfileConfig).toHaveBeenCalledOnce();
  });

  it('serves a legacy record that has no kind at all', async () => {
    getProfileByName.mockResolvedValue({ name: 'home' });

    const res = await GET(new Request('https://pm.test/api/sub/tk/home'), ctx('tk', 'home'));

    expect(res.status).toBe(200);
  });

  it('leaves an unknown name to the renderer (its own 404), not to the kind gate', async () => {
    getProfileByName.mockResolvedValue(null);

    const res = await GET(new Request('https://pm.test/api/sub/tk/ghost'), ctx('tk', 'ghost'));

    expect(res.status).toBe(200); // renderer mocked to succeed — the point is it got called
    expect(renderProfileConfig).toHaveBeenCalledOnce();
  });
});

/* ─── 3. 切换器 / 列表页分组 ─────────────────────────────────────────── */

const p = (name: string, kind?: 'normal' | 'template') => ({ name, kind });

describe('partitionProfilesByKind — 切换器与列表页的分组', () => {
  it('splits templates out while keeping input order inside each group', () => {
    const list = [
      p('default', 'normal'),
      p('general', 'template'),
      p('home'),
      p('simple', 'template'),
    ];

    const { normal, templates } = partitionProfilesByKind(list);

    expect(normal.map((x) => x.name)).toEqual(['default', 'home']);
    expect(templates.map((x) => x.name)).toEqual(['general', 'simple']);
  });

  it('treats a record with no kind as a normal profile', () => {
    const { normal, templates } = partitionProfilesByKind([p('legacy')]);
    expect(normal).toHaveLength(1);
    expect(templates).toHaveLength(0);
  });

  it('yields an empty template group when nothing is a template (侧边栏不渲染该小节)', () => {
    const { templates } = partitionProfilesByKind([p('a'), p('b', 'normal')]);
    expect(templates).toEqual([]);
  });
});

describe('templatesFirst — 新建流的 copy_from 候选顺序', () => {
  it('hoists templates above ordinary profiles', () => {
    const list = [p('default', 'normal'), p('home'), p('simple', 'template')];
    expect(templatesFirst(list).map((x) => x.name)).toEqual(['simple', 'default', 'home']);
  });

  it('is a no-op ordering when there is no template', () => {
    const list = [p('default'), p('home')];
    expect(templatesFirst(list).map((x) => x.name)).toEqual(['default', 'home']);
  });
});

describe('matchesTemplateNameConvention — migrate:profile-kind 的名单', () => {
  it('matches the production template names and the early series', () => {
    expect(TEMPLATE_NAME_PREFIXES).toEqual([
      'template-simple',
      'template-general',
      'simple',
      'general',
    ]);
    for (const name of [
      'template-simple',
      'template-simple-v2',
      'template-general',
      'template-general-cn',
      'simple',
      'simple-v2',
      'general',
      'general-cn',
    ]) {
      expect(matchesTemplateNameConvention(name)).toBe(true);
    }
  });

  it('leaves everything else alone', () => {
    for (const name of ['default', 'home', 'my-simple', 'work']) {
      expect(matchesTemplateNameConvention(name)).toBe(false);
    }
  });
});
