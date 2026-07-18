/** Confirmation-gated repair for legacy chain/source validation deadlocks. */

import { stringify } from 'yaml';
import { z } from 'zod';
import { ClientSafeProblemDetailsError } from '@/lib/http/problem';
import {
  executeLegacyChainProfileRepair,
  planLegacyChainProfileRepair,
  type LegacyChainProfileRepairInput,
  type StaleChainRepairSpec,
} from '@/lib/services/legacyChainProfileRepairService';
import type { ProxyGroupFilterRepair } from '@/lib/services/proxyGroupFilterRepair';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

const FilterRepairSchema = z
  .object({
    id: z.uuid().describe('要修复的策略组 id'),
    filter: z.string().max(4_096).nullable().optional(),
    exclude_filter: z.string().max(4_096).nullable().optional(),
  })
  .refine((value) => value.filter !== undefined || value.exclude_filter !== undefined, {
    message: '每个策略组至少要修复 filter 或 exclude_filter 之一',
  });

const RepairsSchema = z
  .array(FilterRepairSchema)
  .min(2)
  .max(16)
  .superRefine((repairs, ctx) => {
    const seen = new Set<string>();
    repairs.forEach((repair, index) => {
      if (seen.has(repair.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '策略组 id 不能重复' });
      }
      seen.add(repair.id);
    });
  });
const StaleChainSchema = z.object({
  chain_group_id: z.uuid().describe('要删除的陈旧链策略组 id'),
  front_pool_group_id: z.uuid().describe('该链唯一引用的前置池策略组 id'),
  consumer_group_id: z.uuid().describe('唯一引用该链且删除引用后仍有成员的消费组 id'),
});

const RecoveryShape = {
  alias: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'alias 不能包含控制字符')
    .refine((value) => value !== 'DIRECT', 'alias 不能是 Mihomo 内建 DIRECT')
    .default('直连'),
  repairs: RepairsSchema,
  quarantine_spx_subscription_id: z.uuid().optional(),
  stale_chain: StaleChainSchema.optional(),
};

function requireSpecialRecovery<
  T extends { quarantine_spx_subscription_id?: string; stale_chain?: unknown },
>(schema: z.ZodType<T>): z.ZodType<T> {
  return schema.refine(
    (value) =>
      value.quarantine_spx_subscription_id !== undefined || value.stale_chain !== undefined,
    { message: '必须指定 spx 隔离或陈旧链删除中的至少一项' },
  );
}

const PreviewInput = requireSpecialRecovery(z.object(RecoveryShape));
const RepairInput = requireSpecialRecovery(
  z.object({
    ...RecoveryShape,
    expected_version: z.number().int().nonnegative(),
    expected_base_etag: z.string().regex(/^[a-f0-9]{16}$/u),
  }),
);

type ActionRepair = z.infer<typeof FilterRepairSchema>;
type ActionStaleChain = z.infer<typeof StaleChainSchema>;

function nativeRepairs(repairs: ActionRepair[]): ProxyGroupFilterRepair[] {
  return repairs.map(({ id, filter, exclude_filter }) => ({
    id,
    ...(filter !== undefined ? { filter } : {}),
    ...(exclude_filter !== undefined ? { 'exclude-filter': exclude_filter } : {}),
  }));
}

function nativeStaleChain(input?: ActionStaleChain): StaleChainRepairSpec | undefined {
  return input
    ? {
        chainGroupId: input.chain_group_id,
        frontPoolGroupId: input.front_pool_group_id,
        consumerGroupId: input.consumer_group_id,
      }
    : undefined;
}

function nativeInput(input: {
  alias: string;
  repairs: ActionRepair[];
  quarantine_spx_subscription_id?: string;
  stale_chain?: ActionStaleChain;
}): LegacyChainProfileRepairInput {
  return {
    alias: input.alias,
    repairs: nativeRepairs(input.repairs),
    ...(input.quarantine_spx_subscription_id
      ? { quarantineSpxSubscriptionId: input.quarantine_spx_subscription_id }
      : {}),
    ...(input.stale_chain ? { staleChain: nativeStaleChain(input.stale_chain) } : {}),
  };
}

function filterSnapshot(
  groups: Array<{ name: string; filter?: string; 'exclude-filter'?: string }>,
) {
  return Object.fromEntries(
    groups.map((group) => [
      group.name,
      {
        filter: group.filter ?? null,
        ...(group['exclude-filter'] !== undefined
          ? { excludeFilter: group['exclude-filter'] }
          : {}),
      },
    ]),
  );
}

const previewLegacyChainProfileRepair = defineAction({
  name: 'preview_legacy_chain_profile_repair',
  description:
    '只读预检旧链恢复：严格验证 spx 隔离或陈旧链删除，并与 DIRECT 迁移和 2–16 个非法筛选修复组成一个完整候选。',
  input: PreviewInput,
  risk: 'read',
  async run(ctx, input) {
    const plan = await planLegacyChainProfileRepair(ctx.profileId, nativeInput(input));
    return {
      kind: 'legacy-chain-profile-repair-preview',
      data: {
        safe: true,
        summary: plan.summary,
        expectedVersion: plan.expectedVersion,
        expectedBaseEtag: plan.expectedBaseEtag,
      },
    };
  },
});

const repairLegacyChainProfile = defineWriteAction({
  name: 'repair_legacy_chain_profile',
  description:
    '一次确认、一次 CAS 原子修复旧链 profile：可隔离 spx 或删除已证实陈旧的链，同时迁移 DIRECT 并修复非法筛选。',
  input: RepairInput,
  risk: 'write',
  summary: (input) =>
    `原子恢复旧链配置：迁移「${input.alias}」并修复 ${input.repairs.length} 个筛选`,
  async preview(ctx, input) {
    const plan = await planLegacyChainProfileRepair(
      ctx.profileId,
      nativeInput(input),
      input.expected_version,
      input.expected_base_etag,
    );
    const direct = plan.summary.directMigration;
    const before = {
      directAlias: { name: direct.alias, fields: direct.removedProxyFields },
      references: {
        groups: direct.groupNames,
        rules: direct.rulesTouched,
      },
      filters: filterSnapshot(plan.filterRepairBefore),
      ...(plan.summary.spxQuarantine
        ? {
            spx: {
              source: plan.summary.spxQuarantine.sourceName,
              nodes: plan.summary.spxQuarantine.quarantinedNodes,
              affectedProfiles: plan.summary.spxQuarantine.affectedProfiles,
            },
          }
        : {}),
      ...(plan.summary.staleChain
        ? {
            staleChain: {
              chain: plan.summary.staleChain.chainGroupName,
              pool: plan.summary.staleChain.frontPoolGroupName,
              consumer: plan.summary.staleChain.consumerGroupName,
              missingBackend: plan.summary.staleChain.backendName,
            },
          }
        : {}),
    };
    const after = {
      directAlias: 'DIRECT',
      filters: filterSnapshot(plan.filterRepairAfter),
      ...(plan.summary.spxQuarantine
        ? { quarantineSource: plan.summary.spxQuarantine.quarantineName }
        : {}),
      ...(plan.summary.staleChain ? { staleChainRemoved: true } : {}),
      fullRender: 'passed',
    };
    return {
      diff: {
        op: 'repair-legacy-chain-profile',
        path: `profile[${ctx.profileId}]`,
        beforeYaml: stringify(before, { lineWidth: 0 }).trimEnd(),
        afterYaml: stringify(after, { lineWidth: 0 }).trimEnd(),
        concurrency: {
          expectedVersion: plan.expectedVersion,
          expectedBaseEtag: plan.expectedBaseEtag,
        },
      },
      confirmation: { configVersion: plan.expectedVersion },
    };
  },
  async execute(ctx, input): Promise<ActionEnvelope> {
    if (ctx.confirmation?.configVersion !== input.expected_version) {
      throw ClientSafeProblemDetailsError.conflict('确认卡版本信息缺失或不一致，请重新预览。');
    }
    const result = await executeLegacyChainProfileRepair(
      ctx.profileId,
      nativeInput(input),
      input.expected_version,
      input.expected_base_etag,
      ctx.actor,
    );
    return {
      kind: 'write-result',
      data: {
        op: 'repair-legacy-chain-profile',
        summary: `已原子修复 ${result.summary.repairedFilterGroups.length} 个筛选并恢复旧链配置`,
        result: {
          ...result.summary,
          newVersion: result.newVersion,
          auditEventId: result.auditEventId,
        },
      },
    };
  },
});

export const LEGACY_CHAIN_PROFILE_REPAIR_READ_ACTIONS = [previewLegacyChainProfileRepair];
export const LEGACY_CHAIN_PROFILE_REPAIR_WRITE_ACTIONS = [repairLegacyChainProfile];
