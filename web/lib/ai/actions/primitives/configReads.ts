/**
 * Whole-config read actions (Tier D phase 1). Give the assistant a redacted
 * view of the entire base.yaml — a structural outline plus on-demand drill
 * into any section — so it can answer questions about dns / sniffer / tun /
 * proxy-groups / etc., not just rules. Node credentials are never exposed.
 */

import { z } from 'zod';
import {
  buildOutline,
  fullRedactedYaml,
  getConfigSection,
  loadBaseContent,
} from '@/lib/ai/configAccess';
import { renderProfileConfig } from '@/lib/engine/renderCache';
import { ProblemDetailsError } from '@/lib/http/problem';
import { getProfile } from '@/lib/repos/profilesRepo';
import { listRules } from '@/lib/repos/rulesRepo';
import { defineAction } from '../types';

const getConfigOutline = defineAction({
  name: 'get_config_outline',
  description:
    '读取整个 base.yaml 的结构目录：有哪些顶层区块、各区块的子键或具名条目（proxy-groups、rule-providers、dns 子键、sniffer/tun、监听端口等）。回答涉及 dns/嗅探/策略组/端口等整体配置的问题、或决定要钻取哪个区块前，先调用。规则正文不在这里（rules 仅显示条数），用 list_rules 查看。节点凭证已脱敏。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    const [content, rules] = await Promise.all([
      loadBaseContent(ctx.profileId),
      listRules(ctx.profileId),
    ]);
    // The skeleton's `rules:` block is markers-only; surface the real count
    // (from the rule store) instead of a misleading empty/null entry.
    const sections = buildOutline(content).map((s) =>
      s.key === 'rules' ? { key: 'rules', kind: 'list' as const, count: rules.length } : s,
    );
    if (!sections.some((s) => s.key === 'rules')) {
      sections.push({ key: 'rules', kind: 'list', count: rules.length });
    }
    return { kind: 'config-outline', data: { sections } };
  },
});

const getConfigSectionAction = defineAction({
  name: 'get_config_section',
  description:
    '读取 base.yaml 某个区块/路径的具体内容（返回 YAML）。路径语法：map 用点，如 `dns` 或 `dns.enhanced-mode`；具名序列用 [名字]，如 `proxy-groups[OpenAI]`、`rule-providers[openai_classic]`。⚠️ 这是骨架视图：`proxies:` 区块只含用户手写的固定节点（订阅源注入的节点不在这里），完整渲染请用 get_config_full 或 list_proxy_nodes。含节点凭证的部分（proxies/proxy-providers）会自动脱敏为 ***。',
  input: z.object({
    path: z
      .string()
      .min(1)
      .max(200)
      .describe('如 dns / sniffer / tun.enable / proxy-groups[OpenAI]'),
  }),
  risk: 'read',
  async run(ctx, input) {
    const content = await loadBaseContent(ctx.profileId);
    const res = getConfigSection(content, input.path);
    if (!res.found) {
      return { kind: 'config-section', data: { path: input.path, found: false } };
    }
    return {
      kind: 'config-section',
      data: { path: input.path, found: true, yaml: res.yaml, redacted: res.redacted },
    };
  },
});

const getConfigFull = defineAction({
  name: 'get_config_full',
  description:
    '读取完整下发配置（已脱敏）：骨架 + 注入到各锚点的全部**生效**规则 + enabled 订阅源注入的节点，等于实际发给 Mihomo/Clash 的最终结果。仅当需要全局视角时调用——例如"优化整个配置""通盘检查一下"；日常单点问题请用 get_config_outline + get_config_section。注意：渲染结果**不含已停用规则、也没有规则 id**——要看停用规则或拿 id 改规则，请用 list_rules 配合 add/update/delete_rule。节点凭证 / 订阅 token 已脱敏为 ***。',
  input: z.object({}),
  risk: 'read',
  async run(ctx) {
    // 走渲染缓存:providerUrlBase 不传(= null 身份),与 /api/v1/base/parsed
    // 共享同一条缓存,版本未变时这里只剩一次 Redis MGET,不再每问全量渲染。
    //
    // 有意变化:旧实现 resolveConfig(persistSnapshot:false)不写 resolved 快照;
    // renderProfileConfig miss 时内部会写。快照本来就是「渲染成功后的产物」,
    // AI 触发的渲染与 /api/sub、preview 路由触发的渲染产出同一份数据
    // (ignoreFailedSubs:true 下失败订阅同样以 stale/warning 状态入列),
    // 所以多写一次无害且让快照更新更及时。
    // renderProfileConfig 按 name 查 profile,而 ctx 持有 id —— 先取名字。
    const profile = await getProfile(ctx.profileId);
    if (!profile) {
      throw ProblemDetailsError.unprocessable('当前配置文件不存在。');
    }
    const { resolved } = await renderProfileConfig(profile.name, {
      // 与旧 loadBaseContent 的错误语义保持一致(422,而非默认 404)。
      missingBaseError: () => ProblemDetailsError.unprocessable('base.yaml 尚未初始化。'),
    });
    return { kind: 'config-full', data: { yaml: fullRedactedYaml(resolved.content) } };
  },
});

export const CONFIG_READ_ACTIONS = [getConfigOutline, getConfigSectionAction, getConfigFull];
