/**
 * Write actions (Tier C) — gated rule edits. Each maps onto the existing
 * `rule-anchor-append` scenario through the dispatcher, so audit logging and
 * undo (inverses) come for free. None of these execute inline: the
 * orchestrator previews + mints a confirmation token, and execution only
 * happens after the user authorises it via /api/v1/assistant/confirm.
 */

import { z } from 'zod';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getRule } from '@/lib/repos/rulesRepo';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { ensureValidAnchorAndPolicy, loadParsedBase } from '@/lib/services/rulesService';
import { RuleTypeSchema, type Rule } from '@/schemas';
import { defineWriteAction, type ActionEnvelope } from '../types';

const SCENARIO = 'rule-anchor-append';

function trim(rule: {
  type: string;
  value?: string;
  policy: string;
  anchor: string;
  note?: string | null;
  options?: string[];
  enabled?: boolean;
}) {
  return {
    type: rule.type,
    value: rule.value ?? '',
    policy: rule.policy,
    anchor: rule.anchor,
    ...(rule.options?.length ? { options: rule.options } : {}),
    ...(rule.enabled === false ? { enabled: false } : {}),
    note: rule.note ?? null,
  };
}

function writeResult(
  op: 'add' | 'update' | 'delete',
  summary: string,
  data: unknown,
  events: Array<{ id: string; op: string }>,
): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, result: data, events } };
}

async function mustGetRule(id: string): Promise<Rule> {
  const rule = await getRule(id);
  if (!rule) throw ProblemDetailsError.notFound(`规则 ${id} 不存在。`);
  return rule;
}

/* ─── add_rule ──────────────────────────────────────────────────────── */

const AddRuleInput = z
  .object({
    type: RuleTypeSchema,
    value: z.string().max(256).optional().describe('域名/IP-CIDR/规则集名等；MATCH 不需要 value'),
    policy: z.string().min(1).max(64).describe('目标策略组名，必须是 base.yaml 已存在的'),
    anchor: z
      .string()
      .min(1)
      .max(64)
      .describe('插入的锚点名（prelude/manual/late 等），必须是 base.yaml 已声明的'),
    options: z
      .array(z.string().max(64))
      .max(8)
      .optional()
      .describe('规则修饰符，如 ["no-resolve"]；拼在规则末尾'),
    enabled: z.boolean().optional().describe('false=停用（保留但不下发）；默认启用'),
    note: z.string().max(256).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type !== 'MATCH' && (!v.value || v.value.trim() === '')) {
      ctx.addIssue({ code: 'custom', message: '非 MATCH 规则必须填写 value', path: ['value'] });
    }
  });

const addRule = defineWriteAction({
  name: 'add_rule',
  description:
    '新增一条分流规则到任意锚点（prelude/manual/late）。支持修饰符 options（如 no-resolve）、MATCH（无 value）、enabled 启停。需用户确认后才生效。policy/anchor 必须是 base.yaml 里已存在的；不确定时先调用 get_base_overview 查可用值。',
  input: AddRuleInput,
  risk: 'write',
  summary: (i) => {
    const head =
      i.type === 'MATCH'
        ? `MATCH → ${i.policy}`
        : `${i.type},${i.value}${i.options?.length ? `,${i.options.join(',')}` : ''} → ${i.policy}`;
    return `新增规则：${head}（锚点 ${i.anchor}${i.enabled === false ? '，停用' : ''}）`;
  },
  async preview(_ctx, input) {
    const parsed = await loadParsedBase();
    ensureValidAnchorAndPolicy({ anchor: input.anchor, policy: input.policy }, parsed);
    return { diff: { op: 'add', after: trim(input) } };
  },
  async execute(ctx, input) {
    const res = await dispatch({
      scenario: SCENARIO,
      op: 'create',
      payload: { ...input, value: input.value ?? '', source: 'manual' },
      actor: ctx.actor,
    });
    return writeResult(
      'add',
      `已新增规则 ${input.type === 'MATCH' ? 'MATCH' : input.value} → ${input.policy}`,
      res.data,
      res.events.map((e) => ({ id: e.id, op: e.op })),
    );
  },
});

/* ─── update_rule ───────────────────────────────────────────────────── */

const UpdateRuleInput = z
  .object({
    id: z.uuid(),
    type: RuleTypeSchema.optional(),
    value: z.string().min(1).max(256).optional(),
    policy: z.string().min(1).max(64).optional(),
    anchor: z.string().min(1).max(64).optional(),
    options: z.array(z.string().max(64)).max(8).optional().describe('替换修饰符列表，如 ["no-resolve"]；传 [] 清空'),
    enabled: z.boolean().optional().describe('true=启用，false=停用'),
    note: z.string().max(256).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'id' && v[k as keyof typeof v] !== undefined), {
    message: '至少要修改一个字段',
  });

const updateRule = defineWriteAction({
  name: 'update_rule',
  description:
    '修改一条已存在规则的字段（policy/value/anchor/options/note，或用 enabled 启停）。需用户确认后才生效。先用 list_rules 拿到规则 id。',
  input: UpdateRuleInput,
  risk: 'write',
  summary: (i) => `修改规则 ${i.id.slice(0, 8)}…`,
  async preview(_ctx, input) {
    const before = await mustGetRule(input.id);
    const after = {
      ...before,
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.value !== undefined ? { value: input.value } : {}),
      ...(input.policy !== undefined ? { policy: input.policy } : {}),
      ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
      ...(input.options !== undefined ? { options: input.options } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    if (input.anchor !== undefined || input.policy !== undefined) {
      const parsed = await loadParsedBase();
      ensureValidAnchorAndPolicy({ anchor: after.anchor, policy: after.policy }, parsed);
    }
    return { diff: { op: 'update', before: trim(before), after: trim(after) } };
  },
  async execute(ctx, input) {
    const { id, ...rest } = input;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
    const res = await dispatch({
      scenario: SCENARIO,
      op: 'patch',
      payload: { id, patch },
      actor: ctx.actor,
    });
    return writeResult(
      'update',
      `已修改规则 ${id.slice(0, 8)}…`,
      res.data,
      res.events.map((e) => ({ id: e.id, op: e.op })),
    );
  },
});

/* ─── delete_rule ───────────────────────────────────────────────────── */

const DeleteRuleInput = z.object({ id: z.uuid() });

const deleteRule = defineWriteAction({
  name: 'delete_rule',
  description: '删除一条已存在的手动规则。需用户确认后才生效。先用 list_rules 拿到规则 id。',
  input: DeleteRuleInput,
  risk: 'write',
  summary: (i) => `删除规则 ${i.id.slice(0, 8)}…`,
  async preview(_ctx, input) {
    const before = await mustGetRule(input.id);
    return { diff: { op: 'delete', before: trim(before) } };
  },
  async execute(ctx, input) {
    const before = await mustGetRule(input.id);
    const res = await dispatch({
      scenario: SCENARIO,
      op: 'delete',
      payload: { id: input.id },
      actor: ctx.actor,
    });
    return writeResult(
      'delete',
      `已删除规则 ${before.value} → ${before.policy}`,
      res.data,
      res.events.map((e) => ({ id: e.id, op: e.op })),
    );
  },
});

export const WRITE_ACTIONS = [addRule, updateRule, deleteRule];
