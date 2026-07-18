/** Confirmation-gated, profile-scoped migration of a redundant direct alias. */

import { stringify } from 'yaml';
import { z } from 'zod';
import {
  BUILTIN_DIRECT,
  executeDirectAliasMigration,
  planDirectAliasMigration,
  type DirectMigrationSummary,
} from '@/lib/services/directMigrationService';
import { defineAction, defineWriteAction, type ActionEnvelope } from '../types';

const AliasSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'alias 不能包含控制字符')
  .refine((value) => value !== BUILTIN_DIRECT, 'alias 不能是 Mihomo 内建 DIRECT');

const PreviewInput = z.object({
  alias: AliasSchema.default('直连').describe('要移除的冗余 type: direct 节点名，默认「直连」'),
});

const MigrateInput = z.object({
  alias: AliasSchema.default('直连').describe('要迁移的冗余 type: direct 节点名'),
  expected_version: z
    .number()
    .int()
    .nonnegative()
    .describe('preview_direct_alias_migration 返回的 expectedVersion'),
  expected_base_etag: z
    .string()
    .regex(/^[a-f0-9]{16}$/u)
    .describe('preview_direct_alias_migration 返回的 expectedBaseEtag'),
});

function publicSummary(
  summary: Omit<DirectMigrationSummary, 'expectedVersion'>,
  expectedVersion: number,
): DirectMigrationSummary {
  return { ...summary, expectedVersion };
}

function confirmationDiff(summary: DirectMigrationSummary, expectedBaseEtag: string) {
  const before = {
    customProxy: {
      name: summary.alias,
      type: 'direct',
      fields: summary.removedProxyFields,
    },
    references: {
      baseProxyDialer: summary.baseProxyDialerReferences,
      baseProviders: summary.baseProviderReferences,
      baseLiteralGroups: summary.baseLiteralGroupReferences,
      baseLiteralRules: summary.baseLiteralRuleReferences,
      groupMembers: summary.groupMemberReferences,
      groupOther: summary.groupOtherReferences,
      rulesEnabled: summary.enabledRulesTouched,
      rulesDisabled: summary.disabledRulesTouched,
    },
  };
  const after = {
    customProxy: 'removed',
    allKnownReferences: BUILTIN_DIRECT,
    groupsTouched: summary.groupsTouched,
    rulesTouched: summary.rulesTouched,
    inheritedTemplateOverrides: summary.inheritedTemplateOverrides,
    groupNames: summary.groupNames,
    subscriptionValidation: {
      isolatedExistingFailures: summary.isolatedSubscriptionFailures,
      migrationDoesNotRepairSubscriptions: summary.isolatedSubscriptionFailures > 0,
    },
  };
  return {
    op: 'migrate-direct-alias',
    path: `direct-alias[${summary.alias}]`,
    beforeYaml: stringify(before, { lineWidth: 0 }).trimEnd(),
    afterYaml: stringify(after, { lineWidth: 0 }).trimEnd(),
    concurrency: { expectedVersion: summary.expectedVersion, expectedBaseEtag },
  };
}

const previewDirectAliasMigration = defineAction({
  name: 'preview_direct_alias_migration',
  description:
    '只读预检：验证当前 profile 的自定义 type: direct 别名能否无损替换为内建 DIRECT，返回完整引用计数、隔离的既有订阅校验失败数和 expectedVersion；迁移前必须先调用。确定性订阅错误不会被本工具修复，上游不可用仍会阻塞。',
  input: PreviewInput,
  risk: 'read',
  async run(ctx, input) {
    const plan = await planDirectAliasMigration(ctx.profileId, input.alias);
    const summary = publicSummary(plan.summary, plan.expectedVersion);
    return {
      kind: 'direct-migration-preview',
      data: { safe: true, ...summary, expectedBaseEtag: plan.expectedBaseEtag },
    };
  },
});

const migrateDirectAlias = defineWriteAction({
  name: 'migrate_direct_alias',
  description:
    '将当前 profile 中完全冗余的自定义 type: direct 别名删除，并把 base 已知引用、所有策略组成员及全部规则（含停用规则）原子改为内建 DIRECT。只隔离与候选无关的确定性既有订阅校验错误且会在确认卡标明；不会修复订阅。必须先预检并传 expected_version 与 expected_base_etag，需用户确认。',
  input: MigrateInput,
  risk: 'write',
  summary: (input) => `把直连别名「${input.alias}」无损迁移为内建 ${BUILTIN_DIRECT}`,
  async preview(ctx, input) {
    const plan = await planDirectAliasMigration(
      ctx.profileId,
      input.alias,
      input.expected_version,
      input.expected_base_etag,
    );
    return {
      diff: confirmationDiff(
        publicSummary(plan.summary, plan.expectedVersion),
        plan.expectedBaseEtag,
      ),
      confirmation: {
        subscriptionFailureSignature: plan.subscriptionFailureSignature,
      },
    };
  },
  async execute(ctx, input): Promise<ActionEnvelope> {
    const result = await executeDirectAliasMigration(
      ctx.profileId,
      input.alias,
      input.expected_version,
      input.expected_base_etag,
      ctx.actor,
      ctx.confirmation?.subscriptionFailureSignature,
    );
    return {
      kind: 'write-result',
      data: {
        op: 'migrate-direct-alias',
        summary: `已删除直连别名「${input.alias}」，并把全部已知引用迁移为 ${BUILTIN_DIRECT}`,
        result: {
          ...result.summary,
          newVersion: result.newVersion,
          auditEventId: result.auditEventId,
        },
      },
    };
  },
});

export const DIRECT_MIGRATION_READ_ACTIONS = [previewDirectAliasMigration];
export const DIRECT_MIGRATION_WRITE_ACTIONS = [migrateDirectAlias];
