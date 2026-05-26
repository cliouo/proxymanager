/**
 * Read actions (Tier B) — safe, side-effect-free views the assistant can
 * pull to ground its answers in the user's actual config.
 *
 * Deliberately NOT exposed: the raw base.yaml text and any rendered profile.
 * Those embed node credentials / subscription tokens (Never-List), so the
 * model only ever sees structural summaries (anchor names, policy/group
 * names, provider names) and the user's own rule entries.
 */

import { z } from 'zod';
import { listRules } from '@/lib/repos/rulesRepo';
import { loadParsedBase } from '@/lib/services/rulesService';
import { defineAction } from '../types';

const getBaseOverview = defineAction({
  name: 'get_base_overview',
  description:
    '读取当前 base.yaml 的结构摘要：可用的规则锚点(anchors)、策略组/节点名(policies)、代理集合(proxy-providers)、规则集(rule-providers)。回答"有哪些策略组/锚点能用"或写规则前先查可用目标时调用。不含任何节点凭证。',
  input: z.object({}),
  risk: 'read',
  async run() {
    const parsed = await loadParsedBase();
    return {
      kind: 'base-overview',
      data: {
        anchors: parsed.anchors,
        policies: parsed.policies,
        proxyProviders: parsed.proxyProviders,
        ruleProviders: parsed.ruleProviders,
      },
    };
  },
});

const listRulesAction = defineAction({
  name: 'list_rules',
  description:
    '列出用户当前的全部分流规则(rules)，可按锚点(anchor)过滤。每条含 type/value/policy/anchor/options(修饰符)/enabled(是否生效)/note。enabled=false 表示已停用、不下发。回答"某锚点下有哪些规则""哪些规则停用了"或改规则前拿 id 时调用。',
  input: z.object({
    anchor: z.string().min(1).max(64).optional().describe('只返回该锚点下的规则'),
  }),
  risk: 'read',
  async run(_ctx, input) {
    const all = await listRules();
    const rules = input.anchor ? all.filter((r) => r.anchor === input.anchor) : all;
    return {
      kind: 'rule-list',
      data: {
        anchor: input.anchor ?? null,
        count: rules.length,
        rules: rules.map((r) => ({
          id: r.id,
          type: r.type,
          value: r.value,
          policy: r.policy,
          anchor: r.anchor,
          options: r.options ?? [],
          enabled: r.enabled !== false,
          source: r.source,
          note: r.note ?? null,
        })),
      },
    };
  },
});

export const READ_ACTIONS = [getBaseOverview, listRulesAction];
