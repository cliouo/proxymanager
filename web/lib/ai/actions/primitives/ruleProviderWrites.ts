/**
 * Rule-set library actions — read + gated writes over the platform-managed
 * rule-sets ("规则集" / rule-providers library), mirroring the rule actions.
 * Writes dispatch through the `rule-provider` scenario, so audit + undo come
 * for free, and never run inline (confirmation handshake).
 *
 * A rule-set is only emitted into the delivered `rule-providers:` block once a
 * RULE-SET rule references it — so creating one here is "add to library", and
 * wiring it up is a separate RULE-SET rule via add_rule.
 */

import { z } from 'zod';
import { stringify } from 'yaml';
import { ProblemDetailsError } from '@/lib/http/problem';
import { safeFetchText } from '@/lib/net/safeFetch';
import { listRules } from '@/lib/repos/rulesRepo';
import { getRuleSet, listRuleSets } from '@/lib/services/ruleSetService';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import type { RuleSet } from '@/schemas';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

const SCENARIO = 'rule-provider';

type LibFields = Partial<
  Pick<RuleSet, 'name' | 'source' | 'format' | 'behavior' | 'url' | 'content' | 'interval' | 'proxy' | 'note'>
>;

/** Compact YAML view of a library entry for the confirm card's line-diff. */
function libYaml(s: LibFields): string {
  const source = s.source ?? 'local';
  const obj: Record<string, unknown> = { name: s.name, source, format: s.format };
  if (s.behavior) obj.behavior = s.behavior;
  if (source === 'remote') obj.url = s.url;
  if (s.interval) obj.interval = s.interval;
  if (s.proxy) obj.proxy = s.proxy;
  if (s.note) obj.note = s.note;
  if (source === 'local' && s.content) obj.content = s.content;
  return stringify(obj).trimEnd();
}

function writeResult(
  op: string,
  summary: string,
  data: unknown,
  events: Array<{ id: string; op: string }>,
): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events } };
}

async function mustGet(id: string): Promise<RuleSet> {
  const set = await getRuleSet(id);
  if (!set) throw ProblemDetailsError.notFound(`规则集 ${id} 不存在。`);
  return set;
}

/* ─── list_rule_providers ───────────────────────────────────────────── */

const listRuleProviders = defineAction({
  name: 'list_rule_providers',
  description:
    '列出规则集库（rule-providers）的全部条目：name(被 RULE-SET 规则引用的值)/source(local 托管 或 remote 外部URL)/format/behavior/url/interval/enabled，以及每个被多少条 RULE-SET 规则引用(referenced)。回答"有哪些规则集""某规则集被谁引用""改规则集前拿 id"时调用。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    const [sets, rules] = await Promise.all([listRuleSets(), listRules(ctx.profileId)]);
    const refs = new Map<string, number>();
    for (const r of rules) {
      if (r.type === 'RULE-SET' && r.value) refs.set(r.value, (refs.get(r.value) ?? 0) + 1);
    }
    return {
      kind: 'rule-provider-list',
      data: {
        count: sets.length,
        providers: sets.map((s) => ({
          id: s.id,
          name: s.name,
          source: s.source ?? 'local',
          format: s.format,
          behavior: s.behavior ?? null,
          url: (s.source ?? 'local') === 'remote' ? s.url : null,
          interval: s.interval ?? null,
          referenced: refs.get(s.name) ?? 0,
          note: s.note ?? null,
        })),
      },
    };
  },
});

/* ─── create_rule_provider ──────────────────────────────────────────── */

const CreateInput = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9_-]+$/, '只能是小写字母/数字/下划线/连字符')
      .max(64)
      .describe('规则集名(slug)；RULE-SET 规则用这个名字引用它'),
    source: z.enum(['local', 'remote']).optional().describe('local=平台托管内容；remote=外部URL。默认 local'),
    format: z.enum(['yaml', 'text', 'mrs']).describe('local 仅支持 yaml/text；remote 可用 mrs'),
    behavior: z.enum(['classical', 'domain', 'ipcidr']).optional().describe('mihomo rule-provider behavior'),
    content: z.string().max(200000).optional().describe('local 必填：规则集内容(如 payload: ...)'),
    url: z.string().max(2000).optional().describe('remote 必填：mihomo 直接抓取的外部 URL'),
    interval: z.number().int().positive().optional().describe('刷新间隔(秒)，默认 86400'),
    proxy: z.string().max(64).optional().describe('下载用的代理/策略名(可选)'),
    note: z.string().max(256).optional(),
  })
  .superRefine((v, ctx) => {
    const source = v.source ?? 'local';
    if (source === 'remote' && !v.url) {
      ctx.addIssue({ code: 'custom', message: 'remote 必须提供 url', path: ['url'] });
    }
    if (source === 'local' && (!v.content || v.content.trim() === '')) {
      ctx.addIssue({ code: 'custom', message: 'local 必须提供 content', path: ['content'] });
    }
    if (source === 'local' && v.format === 'mrs') {
      ctx.addIssue({ code: 'custom', message: 'local 不支持 mrs', path: ['format'] });
    }
  });

const createRuleProvider = defineWriteAction({
  name: 'create_rule_provider',
  description:
    '在规则集库新增一个规则集（local 托管内容 或 remote 外部URL）。需用户确认。注意：新建只是入库，要让它生效还需用 add_rule 加一条 RULE-SET 规则引用它的 name。',
  input: CreateInput,
  risk: 'write',
  summary: (i) =>
    `新增规则集：${i.name}（${i.source ?? 'local'}${(i.source ?? 'local') === 'remote' ? ` ${i.url}` : ''}）`,
  async preview(_ctx, input) {
    return { diff: { op: 'add', path: `rule-providers[${input.name}]`, afterYaml: libYaml(input) } };
  },
  async execute(ctx, input) {
    const res = await dispatch({ scenario: SCENARIO, op: 'create', payload: input, actor: ctx.actor, profileId: ctx.profileId });
    return writeResult('add', `已新增规则集 ${input.name}`, res.data, res.events.map((e) => ({ id: e.id, op: e.op })));
  },
});

/* ─── update_rule_provider ──────────────────────────────────────────── */

const UpdateInput = z
  .object({
    id: z.uuid().describe('规则集 id（先用 list_rule_providers 获取）'),
    source: z.enum(['local', 'remote']).optional(),
    format: z.enum(['yaml', 'text', 'mrs']).optional(),
    behavior: z.enum(['classical', 'domain', 'ipcidr']).optional(),
    content: z.string().max(200000).optional(),
    url: z.string().max(2000).optional(),
    interval: z.number().int().positive().optional(),
    proxy: z.string().max(64).optional(),
    note: z.string().max(256).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'id' && v[k as keyof typeof v] !== undefined), {
    message: '至少要修改一个字段',
  });

const updateRuleProvider = defineWriteAction({
  name: 'update_rule_provider',
  description:
    '修改规则集库中某条目的字段（content/url/behavior/format/interval/proxy/note，或用 enabled 启停）。需用户确认。先用 list_rule_providers 拿 id。',
  input: UpdateInput,
  risk: 'write',
  summary: (i) => `修改规则集 ${i.id.slice(0, 8)}…`,
  async preview(_ctx, input) {
    const before = await mustGet(input.id);
    const after = { ...before, ...input, id: before.id };
    return {
      diff: {
        op: 'update',
        path: `rule-providers[${before.name}]`,
        beforeYaml: libYaml(before),
        afterYaml: libYaml(after),
      },
    };
  },
  async execute(ctx, input) {
    const { id, ...rest } = input;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    const res = await dispatch({ scenario: SCENARIO, op: 'patch', payload: { id, patch }, actor: ctx.actor, profileId: ctx.profileId });
    return writeResult('update', `已修改规则集 ${id.slice(0, 8)}…`, res.data, res.events.map((e) => ({ id: e.id, op: e.op })));
  },
});

/* ─── delete_rule_provider ──────────────────────────────────────────── */

const DeleteInput = z.object({ id: z.uuid().describe('规则集 id（先用 list_rule_providers 获取）') });

const deleteRuleProvider = defineWriteAction({
  name: 'delete_rule_provider',
  description:
    '从规则集库删除一个规则集。需用户确认。若仍被 RULE-SET 规则引用会被拒绝——先用 update_rule/delete_rule 处理引用它的规则。',
  input: DeleteInput,
  risk: 'write',
  summary: (i) => `删除规则集 ${i.id.slice(0, 8)}…`,
  async preview(_ctx, input) {
    const before = await mustGet(input.id);
    return { diff: { op: 'delete', path: `rule-providers[${before.name}]`, beforeYaml: libYaml(before) } };
  },
  async execute(ctx, input) {
    const before = await mustGet(input.id);
    const res = await dispatch({ scenario: SCENARIO, op: 'delete', payload: { id: input.id }, actor: ctx.actor, profileId: ctx.profileId });
    return writeResult('delete', `已删除规则集 ${before.name}`, res.data, res.events.map((e) => ({ id: e.id, op: e.op })));
  },
});

/* ─── localize_rule_provider ────────────────────────────────────────── */

const LocalizeInput = z.object({
  id: z.uuid().describe('要转为本地托管的规则集 id（先用 list_rule_providers 获取）'),
});

const localizeRuleProvider = defineWriteAction({
  name: 'localize_rule_provider',
  description:
    '把一个 remote(外部URL) 规则集转为本平台托管：确认后由平台抓取其 URL 的当前内容存为本地内容，之后由本平台分发、可在平台内维护。仅适用于 yaml/text 格式（mrs 二进制不支持）。需用户确认。',
  input: LocalizeInput,
  risk: 'write',
  summary: (i) => `转为本地托管：${i.id.slice(0, 8)}…`,
  async preview(_ctx, input) {
    const before = await mustGet(input.id);
    if ((before.source ?? 'local') !== 'remote') {
      throw ProblemDetailsError.unprocessable('该规则集已是本地托管，无需转换。');
    }
    if (!before.url) throw ProblemDetailsError.unprocessable('该规则集缺少 url，无法抓取。');
    if (before.format === 'mrs') {
      throw ProblemDetailsError.unprocessable('mrs 为二进制格式，无法转为本地文本托管。');
    }
    return {
      diff: {
        op: 'update',
        path: `rule-providers[${before.name}]`,
        beforeYaml: libYaml(before),
        afterYaml: libYaml({ ...before, source: 'local', url: '', content: `（确认后抓取自 ${before.url}）` }),
      },
    };
  },
  async execute(ctx, input) {
    const before = await mustGet(input.id);
    if ((before.source ?? 'local') !== 'remote' || !before.url) {
      throw ProblemDetailsError.unprocessable('该规则集不是带 url 的 remote，无法本地化。');
    }
    if (before.format === 'mrs') {
      throw ProblemDetailsError.unprocessable('mrs 无法转为本地托管。');
    }
    const fetched = await safeFetchText(before.url, { maxBytes: 2_000_000 });
    const res = await dispatch({
      scenario: SCENARIO,
      op: 'patch',
      payload: { id: input.id, patch: { source: 'local', content: fetched.text, url: '' } },
      actor: ctx.actor,
      profileId: ctx.profileId,
    });
    return writeResult(
      'update',
      `已将 ${before.name} 转为本地托管（抓取 ${fetched.bytes} 字节）`,
      res.data,
      res.events.map((e) => ({ id: e.id, op: e.op })),
    );
  },
});

export const RULE_PROVIDER_READ_ACTIONS = [listRuleProviders];
export const RULE_PROVIDER_WRITE_ACTIONS = [
  createRuleProvider,
  updateRuleProvider,
  deleteRuleProvider,
  localizeRuleProvider,
];
