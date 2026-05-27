/**
 * Whole-config write actions (Tier D phase 2). Path-scoped set/delete on
 * base.yaml, gated by the confirmation handshake. Preview does a dry-run
 * (apply to a throwaway doc + validate) so a doomed edit never mints a token;
 * execute dispatches the `config-section` scenario (audit + undo).
 */

import { z } from 'zod';
import { dryRunDelete, dryRunSet } from '@/lib/ai/configEdit';
import { assertEditablePath, parsePath } from '@/lib/ai/configPath';
import { dispatch } from '@/lib/scenarios/_shared/dispatch';
import { defineWriteAction, type ActionEnvelope } from '../types';

function writeResult(
  op: string,
  summary: string,
  events: Array<{ id: string; op: string }>,
): ActionEnvelope {
  return { kind: 'write-result', data: { op, summary, events } };
}

const setConfigSection = defineWriteAction({
  name: 'set_config_section',
  description:
    '新增或替换 base.yaml 某路径的内容（dns / sniffer / tun / proxy-groups / 顶层标量等）。value 用 YAML 表达：标量直接写（如 fake-ip、true），整组写 YAML map。需用户确认。路径语法同 get_config_section；禁改 proxies（节点由订阅源注入）、proxy-providers（项目不再托管，用户手写的原样透传）、rules / rule-providers（走各自专属 action）。',
  input: z.object({
    path: z
      .string()
      .min(1)
      .max(200)
      .describe('如 dns.enhanced-mode / proxy-groups[OpenAI] / sniffer'),
    value: z.string().min(1).max(20000).describe('YAML 表达的新值'),
  }),
  risk: 'write',
  summary: (i) => `设置配置 ${i.path}`,
  async preview(_ctx, input) {
    assertEditablePath(parsePath(input.path));
    const { beforeYaml, afterYaml, existed } = await dryRunSet(input.path, input.value);
    return { diff: { op: existed ? 'update' : 'add', path: input.path, beforeYaml, afterYaml } };
  },
  async execute(ctx, input) {
    const res = await dispatch({
      scenario: 'config-section',
      op: 'set',
      payload: { path: input.path, value: input.value },
      actor: ctx.actor,
    });
    return writeResult(
      'set-section',
      `已更新配置 ${input.path}`,
      res.events.map((e) => ({ id: e.id, op: e.op })),
    );
  },
});

const deleteConfigSection = defineWriteAction({
  name: 'delete_config_section',
  description:
    '删除 base.yaml 某路径（如某个 proxy-group、某 dns 字段）。需用户确认。禁删 proxies / proxy-providers / rules / rule-providers；若删除会让规则失去引用会被拒绝。',
  input: z.object({
    path: z.string().min(1).max(200).describe('如 proxy-groups[旧组] / dns.fallback'),
  }),
  risk: 'write',
  summary: (i) => `删除配置 ${i.path}`,
  async preview(_ctx, input) {
    assertEditablePath(parsePath(input.path));
    const { beforeYaml } = await dryRunDelete(input.path);
    return { diff: { op: 'delete', path: input.path, beforeYaml } };
  },
  async execute(ctx, input) {
    const res = await dispatch({
      scenario: 'config-section',
      op: 'delete',
      payload: { path: input.path },
      actor: ctx.actor,
    });
    return writeResult(
      'delete-section',
      `已删除配置 ${input.path}`,
      res.events.map((e) => ({ id: e.id, op: e.op })),
    );
  },
});

export const CONFIG_WRITE_ACTIONS = [setConfigSection, deleteConfigSection];
