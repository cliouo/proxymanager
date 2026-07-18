/** Confirmation-gated recovery for profiles blocked by two legacy error classes. */

import { stringify } from 'yaml';
import { z } from 'zod';
import { BUILTIN_DIRECT, type DirectMigrationSummary } from '@/lib/services/directMigrationService';
import {
  executeLegacyProfileRepair,
  planLegacyProfileRepair,
} from '@/lib/services/legacyProfileRepairService';
import type { ProxyGroupFilterRepair } from '@/lib/services/proxyGroupFilterRepair';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

const AliasSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'alias 不能包含控制字符')
  .refine((value) => value !== BUILTIN_DIRECT, 'alias 不能是 Mihomo 内建 DIRECT');

const FilterRepairSchema = z
  .object({
    id: z.uuid().describe('要修复的策略组 id（先用 list_proxy_groups 获取）'),
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
        ctx.addIssue({
          code: 'custom',
          message: '同一策略组不能在一个恢复批次中重复出现',
          path: [index, 'id'],
        });
      }
      seen.add(repair.id);
    });
  });

const PreviewInput = z.object({
  alias: AliasSchema.default('直连').describe('要迁移为内建 DIRECT 的冗余直连别名'),
  repairs: RepairsSchema.describe('必须与直连别名迁移同时完成的 2 到 16 个非法筛选修复'),
});

const RepairInput = z.object({
  alias: AliasSchema.default('直连').describe('要迁移为内建 DIRECT 的冗余直连别名'),
  repairs: RepairsSchema.describe('必须与直连别名迁移同时完成的 2 到 16 个非法筛选修复'),
  expected_version: z
    .number()
    .int()
    .nonnegative()
    .describe('preview_legacy_profile_repair 返回的 expectedVersion'),
  expected_base_etag: z
    .string()
    .regex(/^[a-f0-9]{16}$/u)
    .describe('preview_legacy_profile_repair 返回的 expectedBaseEtag'),
});

type ActionRepair = z.infer<typeof FilterRepairSchema>;

function nativeRepairs(repairs: ActionRepair[]): ProxyGroupFilterRepair[] {
  return repairs.map(({ id, filter, exclude_filter }) => ({
    id,
    ...(filter !== undefined ? { filter } : {}),
    ...(exclude_filter !== undefined ? { 'exclude-filter': exclude_filter } : {}),
  }));
}

function directSummary(
  summary: Omit<DirectMigrationSummary, 'expectedVersion'>,
  expectedVersion: number,
): DirectMigrationSummary {
  return { ...summary, expectedVersion };
}

function filterSnapshot(
  groups: Array<{ name: string; filter?: string; 'exclude-filter'?: string }>,
) {
  return groups.map((group) => ({
    name: group.name,
    filter: group.filter ?? null,
    excludeFilter: group['exclude-filter'] ?? null,
  }));
}

const previewLegacyProfileRepair = defineAction({
  name: 'preview_legacy_profile_repair',
  description:
    '只读预检：同一候选中迁移冗余 direct 别名并修复 2–16 个当前非法策略组筛选，返回版本与 base ETag。仅用于两类错误互相阻塞的恢复场景。',
  input: PreviewInput,
  risk: 'read',
  async run(ctx, input) {
    const plan = await planLegacyProfileRepair(
      ctx.profileId,
      input.alias,
      nativeRepairs(input.repairs),
    );
    return {
      kind: 'legacy-profile-repair-preview',
      data: {
        safe: true,
        directMigration: directSummary(plan.summary, plan.expectedVersion),
        repairedFilterGroups: plan.filterRepairAfter.map((group) => group.name),
        expectedVersion: plan.expectedVersion,
        expectedBaseEtag: plan.expectedBaseEtag,
      },
    };
  },
});

const repairLegacyProfile = defineWriteAction({
  name: 'repair_legacy_profile',
  description:
    '原子恢复被两类旧错误共同阻塞的 profile：迁移安全 direct 别名并修复 2–16 个非法筛选；完整渲染通过后用一张确认卡一次提交。',
  input: RepairInput,
  risk: 'write',
  summary: (input) =>
    `原子迁移直连别名「${input.alias}」并修复 ${input.repairs.length} 个策略组筛选`,
  async preview(ctx, input) {
    const plan = await planLegacyProfileRepair(
      ctx.profileId,
      input.alias,
      nativeRepairs(input.repairs),
      input.expected_version,
      input.expected_base_etag,
    );
    const before = {
      customProxy: {
        name: plan.summary.alias,
        type: 'direct',
        fields: plan.summary.removedProxyFields,
      },
      references: {
        baseProxyDialer: plan.summary.baseProxyDialerReferences,
        baseProviders: plan.summary.baseProviderReferences,
        baseLiteralGroups: plan.summary.baseLiteralGroupReferences,
        baseLiteralRules: plan.summary.baseLiteralRuleReferences,
        groupMembers: plan.summary.groupMemberReferences,
        groupOther: plan.summary.groupOtherReferences,
        rulesEnabled: plan.summary.enabledRulesTouched,
        rulesDisabled: plan.summary.disabledRulesTouched,
      },
      filters: filterSnapshot(plan.filterRepairBefore),
    };
    const after = {
      customProxy: 'removed',
      allKnownReferences: BUILTIN_DIRECT,
      directMigration: {
        groupsTouched: plan.summary.groupsTouched,
        rulesTouched: plan.summary.rulesTouched,
        inheritedTemplateOverrides: plan.summary.inheritedTemplateOverrides,
        groupNames: plan.summary.groupNames,
      },
      filters: filterSnapshot(plan.filterRepairAfter),
      allGroupsTouched: plan.groups.map((group) => group.name),
      subscriptionValidation: {
        isolatedExistingFailures: plan.summary.isolatedSubscriptionFailures,
        migrationDoesNotRepairSubscriptions: plan.summary.isolatedSubscriptionFailures > 0,
      },
    };
    return {
      diff: {
        op: 'repair-legacy-profile',
        path: `legacy-profile[${plan.summary.alias}; ${plan.filterRepairAfter
          .map((group) => group.name)
          .join(', ')}]`,
        beforeYaml: stringify(before, { lineWidth: 0 }).trimEnd(),
        afterYaml: stringify(after, { lineWidth: 0 }).trimEnd(),
        concurrency: {
          expectedVersion: plan.expectedVersion,
          expectedBaseEtag: plan.expectedBaseEtag,
        },
      },
      confirmation: {
        subscriptionFailureSignature: plan.subscriptionFailureSignature,
      },
    };
  },
  async execute(ctx, input): Promise<ActionEnvelope> {
    const result = await executeLegacyProfileRepair(
      ctx.profileId,
      input.alias,
      nativeRepairs(input.repairs),
      input.expected_version,
      input.expected_base_etag,
      ctx.actor,
      ctx.confirmation?.subscriptionFailureSignature,
    );
    return {
      kind: 'write-result',
      data: {
        op: 'repair-legacy-profile',
        summary: `已迁移直连别名「${input.alias}」并原子修复 ${result.summary.repairedFilterGroups.length} 个策略组筛选`,
        result: {
          ...result.summary,
          newVersion: result.newVersion,
          auditEventId: result.auditEventId,
        },
      },
    };
  },
});

export const LEGACY_PROFILE_REPAIR_READ_ACTIONS = [previewLegacyProfileRepair];
export const LEGACY_PROFILE_REPAIR_WRITE_ACTIONS = [repairLegacyProfile];
