/**
 * Proxy-group actions — a membership-preview read plus gated create/update/
 * delete writes over the platform-managed proxy-groups ("策略组") hash.
 *
 * Unlike rules/rule-providers, proxy-groups have no scenario layer; the UI
 * mutates them straight through `proxyGroupService` (which already enforces
 * name-uniqueness, template existence, dialer-proxy cycle detection, rename
 * cascade across other groups' proxies/dialer-proxy + rule policies, and
 * reference guards on delete). These actions call that same service, so the
 * assistant's edits behave exactly like the 策略组 page — only fronted by the
 * confirmation handshake (`defineWriteAction`: preview → card → execute).
 *
 * The headline pairing is `preview_proxy_group_members` + `update_proxy_group`:
 * resolve a candidate `filter`/`exclude-filter` against the live node list to
 * verify it BEFORE proposing the edit (catches e.g. a region filter whose bare
 * `us` token also swallows AU-stralia / R-us-sia nodes).
 */

import { z } from 'zod';
import { stringify } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { matchFilter } from '@/lib/proxies/filterMatch';
import { getResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import {
  createProxyGroup,
  deleteProxyGroup as svcDelete,
  getProxyGroup,
  patchProxyGroup,
} from '@/lib/services/proxyGroupService';
import type { ProxyGroup, ProxyGroupCreate, ProxyGroupUpdate } from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

const TYPES = ['select', 'url-test', 'fallback', 'load-balance', 'relay'] as const;
const KINDS = ['raw', 'manual', 'filter', 'all', 'single-sub'] as const;

/** How many matched names to inline in a preview before truncating. */
const MAX_PREVIEW_NAMES = 200;

/** Compact YAML view of a group's effective fields for the confirm card diff. */
function groupYaml(g: Partial<ProxyGroup>): string {
  const obj: Record<string, unknown> = { name: g.name, type: g.type };
  if (g.kind) obj.kind = g.kind;
  if (g.section) obj.section = g.section;
  if (g.proxies?.length) obj.proxies = g.proxies;
  if (g.use?.length) obj.use = g.use;
  if (g['include-all-proxies']) obj['include-all-proxies'] = true;
  if (g['include-all-providers']) obj['include-all-providers'] = true;
  if (g.filter) obj.filter = g.filter;
  if (g['exclude-filter']) obj['exclude-filter'] = g['exclude-filter'];
  if (g['exclude-type']) obj['exclude-type'] = g['exclude-type'];
  if (g.url) obj.url = g.url;
  if (g.interval) obj.interval = g.interval;
  if (g.tolerance !== undefined) obj.tolerance = g.tolerance;
  if (g['dialer-proxy']) obj['dialer-proxy'] = g['dialer-proxy'];
  if (g.notes) obj.notes = g.notes;
  return stringify(obj).trimEnd();
}

function writeResult(op: string, summary: string, data: unknown): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events: [] } };
}

async function mustGet(profileId: string, id: string): Promise<ProxyGroup> {
  const g = await getProxyGroup(profileId, id);
  if (!g) throw ProblemDetailsError.notFound(`策略组 ${id} 不存在。`);
  return g;
}

async function nodePool(profileId: string): Promise<{ names: string[]; hint?: string }> {
  const snapshot = await getResolvedSnapshot(profileId);
  if (!snapshot) {
    return {
      names: [],
      hint: '尚未生成解析快照——让用户打开「最终配置」或访问订阅 URL 触发一次渲染后再查。',
    };
  }
  return { names: snapshot.nodeNames };
}

/* ─── shared editable-field shapes (snake_case → kebab patch) ───────── */

const EDITABLE = {
  type: z.enum(TYPES).describe('mihomo 原生类型：select 手动 / url-test 自动测速 / fallback / load-balance / relay'),
  kind: z.enum(KINDS).describe('UI 预设形态：manual 手选 / filter 筛选 / all 全部 / single-sub 绑定订阅 / raw 逃生口'),
  section: z.string().max(64).describe('UI 分组标签，如「地区」「规则集」'),
  proxies: z.array(z.string()).describe('手选成员列表（节点名 / 其它策略组名 / DIRECT 等内置）'),
  filter: z.string().max(2000).describe('正则(Go RE2)，对纳入的节点名做包含匹配；配 include_all_proxies 用'),
  exclude_filter: z.string().max(2000).describe('正则，从 filter 命中里再排除掉匹配的节点'),
  include_all_proxies: z.boolean().describe('纳入全部可用节点作为候选池（地区/筛选组必开）'),
  exclude_type: z.string().max(128).describe('按节点类型排除，如 "Direct,Reject"（非正则）'),
  url: z.string().max(2000).describe('健康检查 URL（url-test/fallback/load-balance）'),
  interval: z.number().int().positive().describe('健康检查间隔(秒)'),
  tolerance: z.number().int().nonnegative().describe('url-test 容差(ms)'),
  dialer_proxy: z.string().max(128).describe('该组自身流量先经此代理/组（链式）'),
  notes: z.string().max(256).describe('备注'),
};

/** Map the snake_case tool input onto the kebab-case native proxy-group keys. */
function toKebab(input: Record<string, unknown>): Record<string, unknown> {
  const map: Record<string, string> = {
    exclude_filter: 'exclude-filter',
    include_all_proxies: 'include-all-proxies',
    exclude_type: 'exclude-type',
    dialer_proxy: 'dialer-proxy',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[map[k] ?? k] = v;
  }
  return out;
}

/* ─── preview_proxy_group_members ───────────────────────────────────── */

const PreviewInput = z
  .object({
    id: z.uuid().optional().describe('已有策略组 id（先用 list_proxy_groups 拿）；默认取它现有的 filter'),
    filter: z.string().max(2000).optional().describe('候选 filter 正则；给了就覆盖该组现有 filter 来试算'),
    exclude_filter: z.string().max(2000).optional().describe('候选 exclude-filter 正则；给了就覆盖现有的'),
  })
  .refine((v) => v.id || v.filter || v.exclude_filter, {
    message: '至少给 id 或 filter / exclude_filter 之一',
  });

const previewMembers = defineAction({
  name: 'preview_proxy_group_members',
  description:
    '试算一个 filter(+exclude-filter) 正则会从当前可用节点里筛出哪些节点——按 mihomo 语义(filter 命中保留、再去掉 exclude-filter 命中)对真实节点名跑一遍。改/优化地区组或筛选组的正则前后都该调用来验证。可传已有组 id(默认用它的 filter)、也可传候选 filter/exclude_filter 覆盖来对比。只读，不改配置。返回命中节点名和数量。',
  input: PreviewInput,
  risk: 'read',
  async run(ctx, input) {
    const { names, hint } = await nodePool(ctx.profileId);
    let filter = input.filter;
    let excludeFilter = input.exclude_filter;
    let groupName: string | null = null;
    if (input.id) {
      const g = await mustGet(ctx.profileId, input.id);
      groupName = g.name;
      if (filter === undefined) filter = g.filter;
      if (excludeFilter === undefined) excludeFilter = g['exclude-filter'];
    }
    const res = matchFilter(names, filter, excludeFilter);
    const truncated = res.matched.length > MAX_PREVIEW_NAMES;
    return {
      kind: 'proxy-group-members',
      data: {
        group: groupName,
        filter: filter ?? null,
        'exclude-filter': excludeFilter ?? null,
        poolSize: names.length,
        matchedCount: res.matched.length,
        matched: truncated ? res.matched.slice(0, MAX_PREVIEW_NAMES) : res.matched,
        truncated,
        regexError: res.error,
        hint,
      },
    };
  },
});

/* ─── create_proxy_group ────────────────────────────────────────────── */

const CreateInput = z
  .object({
    name: z.string().min(1).max(64).describe('策略组名（唯一；规则的 policy、其它组的 proxies 用它引用）'),
    type: EDITABLE.type.default('select'),
    kind: EDITABLE.kind.default('manual'),
    section: EDITABLE.section.optional(),
    proxies: EDITABLE.proxies.optional(),
    filter: EDITABLE.filter.optional(),
    exclude_filter: EDITABLE.exclude_filter.optional(),
    include_all_proxies: EDITABLE.include_all_proxies.optional(),
    exclude_type: EDITABLE.exclude_type.optional(),
    url: EDITABLE.url.optional(),
    interval: EDITABLE.interval.optional(),
    tolerance: EDITABLE.tolerance.optional(),
    dialer_proxy: EDITABLE.dialer_proxy.optional(),
    notes: EDITABLE.notes.optional(),
  })
  .refine((v) => v.proxies?.length || v.include_all_proxies || v.filter, {
    message: '组得有成员来源：proxies 手选 或 include_all_proxies(可配 filter)',
  });

const createGroup = defineWriteAction({
  name: 'create_proxy_group',
  description:
    '新建一个策略组。需用户确认。成员来源二选一：手选 proxies(列节点/其它组名)，或 include_all_proxies=true 纳入全部节点再用 filter 正则筛选(地区/服务分组的常用做法)。url-test 类型记得给 url/interval。新建后要它生效通常还需 add_rule 加规则把流量指向它，或把它加进其它组的 proxies。',
  input: CreateInput,
  risk: 'write',
  summary: (i) => `新建策略组：${i.name}（${i.type ?? 'select'}）`,
  async preview(_ctx, input) {
    const { name, type, kind, ...rest } = input;
    const view = { name, type, kind, ...toKebab(rest) } as Partial<ProxyGroup>;
    return { diff: { op: 'add', path: `proxy-groups[${name}]`, afterYaml: groupYaml(view) } };
  },
  async execute(ctx, input) {
    const { name, type, kind, section, notes, ...rest } = input;
    const payload = {
      name,
      type,
      kind,
      ...(section !== undefined ? { section } : {}),
      ...(notes !== undefined ? { notes } : {}),
      ...toKebab(rest),
    } as ProxyGroupCreate;
    const created = await createProxyGroup(ctx.profileId, payload);
    return writeResult('add', `已新建策略组 ${name}`, { id: created.id, name: created.name });
  },
});

/* ─── update_proxy_group ────────────────────────────────────────────── */

const UpdateInput = z
  .object({
    id: z.uuid().describe('策略组 id（先用 list_proxy_groups 拿）'),
    name: z.string().min(1).max(64).optional().describe('改名——会级联改写引用它的其它组 proxies / dialer-proxy 与规则 policy'),
    type: EDITABLE.type.optional(),
    kind: EDITABLE.kind.optional(),
    section: EDITABLE.section.nullable().optional(),
    proxies: EDITABLE.proxies.optional(),
    filter: EDITABLE.filter.nullable().optional(),
    exclude_filter: EDITABLE.exclude_filter.nullable().optional(),
    include_all_proxies: EDITABLE.include_all_proxies.optional(),
    exclude_type: EDITABLE.exclude_type.nullable().optional(),
    url: EDITABLE.url.optional(),
    interval: EDITABLE.interval.optional(),
    tolerance: EDITABLE.tolerance.optional(),
    dialer_proxy: EDITABLE.dialer_proxy.nullable().optional(),
    notes: EDITABLE.notes.nullable().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'id' && v[k as keyof typeof v] !== undefined), {
    message: '至少要改一个字段',
  });

const updateGroup = defineWriteAction({
  name: 'update_proxy_group',
  description:
    '修改一个已有策略组的字段（最常见：改 filter / exclude_filter 优化地区或筛选组的正则；也可改 proxies / name / type / url 等）。需用户确认。把可空字段传 null 表示清除该字段。改正则前先用 preview_proxy_group_members 验证命中。先用 list_proxy_groups 拿 id。',
  input: UpdateInput,
  risk: 'write',
  summary: (i) => `修改策略组 ${i.id.slice(0, 8)}…`,
  async preview(ctx, input) {
    const { id, ...rest } = input;
    const before = await mustGet(ctx.profileId, id);
    const patch = toKebab(rest);
    const after: Partial<ProxyGroup> = { ...before };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (after as Record<string, unknown>)[k];
      else (after as Record<string, unknown>)[k] = v;
    }
    return {
      diff: {
        op: 'update',
        path: `proxy-groups[${before.name}]`,
        beforeYaml: groupYaml(before),
        afterYaml: groupYaml(after),
      },
    };
  },
  async execute(ctx, input) {
    const { id, ...rest } = input;
    const before = await mustGet(ctx.profileId, id);
    const patch = toKebab(rest) as ProxyGroupUpdate;
    const updated = await patchProxyGroup(ctx.profileId, id, patch);
    return writeResult('update', `已修改策略组 ${before.name}`, { id: updated.id, name: updated.name });
  },
});

/* ─── delete_proxy_group ────────────────────────────────────────────── */

const DeleteInput = z.object({ id: z.uuid().describe('策略组 id（先用 list_proxy_groups 拿）') });

const deleteGroup = defineWriteAction({
  name: 'delete_proxy_group',
  description:
    '删除一个策略组。需用户确认。若仍被其它组的 proxies / dialer-proxy 或某条规则的 policy 引用会被拒绝——先改掉那些引用。',
  input: DeleteInput,
  risk: 'write',
  summary: (i) => `删除策略组 ${i.id.slice(0, 8)}…`,
  async preview(ctx, input) {
    const before = await mustGet(ctx.profileId, input.id);
    return { diff: { op: 'delete', path: `proxy-groups[${before.name}]`, beforeYaml: groupYaml(before) } };
  },
  async execute(ctx, input) {
    const before = await mustGet(ctx.profileId, input.id);
    const removed = await svcDelete(ctx.profileId, input.id);
    if (!removed) throw ProblemDetailsError.notFound(`策略组 ${input.id} 不存在。`);
    return writeResult('delete', `已删除策略组 ${before.name}`, { name: before.name });
  },
});

export const PROXY_GROUP_READ_ACTIONS = [previewMembers];
export const PROXY_GROUP_WRITE_ACTIONS = [createGroup, updateGroup, deleteGroup];
