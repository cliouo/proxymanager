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
import { listProxyGroups } from '@/lib/repos/proxyGroupsRepo';
import { listProxyGroupTemplates } from '@/lib/repos/proxyGroupTemplatesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { listRuleSets } from '@/lib/repos/ruleSetsRepo';
import { getResolvedSnapshot } from '@/lib/repos/resolvedRepo';
import { loadParsedBase } from '@/lib/services/rulesService';
import { defineAction } from '../types';

const getBaseOverview = defineAction({
  name: 'get_base_overview',
  description:
    '读取当前 base.yaml 的结构摘要：可用的规则锚点(anchors)、策略组/手写节点名(policies)、用户手写残留的 proxy-providers(若有)、规则集(ruleProviders，即规则集库的 name，RULE-SET 规则可引用)。回答"有哪些策略组/锚点/规则集能用"或写规则前先查可用目标时调用。订阅源注入的节点不在这里——查可用节点请用 list_proxy_nodes。不含任何节点凭证。',
  input: z.object({}),
  risk: 'read',
  async run() {
    // rule-providers are now platform-managed (the rule-set library), not the
    // base.yaml block — surface their names from the hash, not the parsed base.
    const [parsed, sets] = await Promise.all([loadParsedBase(), listRuleSets()]);
    return {
      kind: 'base-overview',
      data: {
        anchors: parsed.anchors,
        policies: parsed.policies,
        proxyProviders: parsed.proxyProviders,
        ruleProviders: sets.map((s) => s.name),
      },
    };
  },
});

const listProxyNodes = defineAction({
  name: 'list_proxy_nodes',
  description:
    '列出渲染后实际可用的代理节点名（手写节点 + 全部 enabled 订阅源注入的节点，已应用节点前缀与算子）。读自上次 resolveConfig 的快照——若快照缺失（系统刚启动 / 未渲染过），返回空列表并提示用户先打开「最终配置」预览一次。回答"我有哪些节点可用"、写涉及具体节点名的 proxy-group 之前必查。仅返回名字，不含任何节点凭证。',
  input: z.object({}),
  risk: 'read',
  async run() {
    const snapshot = await getResolvedSnapshot();
    if (!snapshot) {
      return {
        kind: 'proxy-nodes',
        data: {
          nodes: [],
          collisions: [],
          hint: '尚未生成解析快照——让用户打开「最终配置」或访问订阅 URL 触发一次渲染后再查。',
        },
      };
    }
    return {
      kind: 'proxy-nodes',
      data: {
        nodes: snapshot.nodeNames,
        collisions: snapshot.collisions,
        computedAt: snapshot.computedAt,
        buildId: snapshot.buildId,
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

const listProxyGroupsAction = defineAction({
  name: 'list_proxy_groups',
  description:
    '列出当前 hash 中的全部策略组(proxy-groups)和共享模板(templates)。每个策略组含 name/type(mihomo 原生类型)/kind(UI 预设标签:raw/region/single-sub/collection-scope/...)/proxies/filter/template_id/dialer-proxy/include-all-* 等字段;single-sub 组的 bound_subscription_id 与 collection-scope 组的 bound_collection_id 在此暴露(渲染时据此自动生成 filter / proxies)。回答"我有哪些策略组""某组怎么配的""有没有用模板"或写规则需要选 policy 之前调用。AI 不能改策略组,只读;用户改要去「策略组」页。',
  input: z.object({}),
  risk: 'read',
  async run() {
    const [groups, templates] = await Promise.all([
      listProxyGroups(),
      listProxyGroupTemplates(),
    ]);
    return {
      kind: 'proxy-group-list',
      data: {
        count: groups.length,
        groups: groups.map((g) => ({
          name: g.name,
          type: g.type,
          kind: g.kind,
          section: g.section ?? null,
          template_id: g.template_id ?? null,
          bound_subscription_id: g.bound_subscription_id ?? null,
          bound_collection_id: g.bound_collection_id ?? null,
          proxies: g.proxies ?? null,
          use: g.use ?? null,
          'include-all-proxies': g['include-all-proxies'] ?? null,
          'include-all-providers': g['include-all-providers'] ?? null,
          filter: g.filter ?? null,
          'exclude-filter': g['exclude-filter'] ?? null,
          'dialer-proxy': g['dialer-proxy'] ?? null,
          url: g.url ?? null,
          interval: g.interval ?? null,
          tolerance: g.tolerance ?? null,
          notes: g.notes ?? null,
        })),
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type ?? null,
          url: t.url ?? null,
          interval: t.interval ?? null,
          tolerance: t.tolerance ?? null,
          notes: t.notes ?? null,
        })),
      },
    };
  },
});

export const READ_ACTIONS = [
  getBaseOverview,
  listProxyNodes,
  listRulesAction,
  listProxyGroupsAction,
];
