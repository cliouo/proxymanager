import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { z } from '@/lib/openapi/zod';
import { resolveScopeProfile } from '@/lib/profileScope';
import {
  executeLegacyChainProfileRepair,
  planLegacyChainProfileRepair,
  type LegacyChainProfileRepairInput,
} from '@/lib/services/legacyChainProfileRepairService';
import type { ProxyGroupFilterRepair } from '@/lib/services/proxyGroupFilterRepair';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

const FilterRepairSchema = z
  .object({
    id: z.uuid(),
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
  chain_group_id: z.uuid(),
  front_pool_group_id: z.uuid(),
  consumer_group_id: z.uuid(),
});

const BaseShape = {
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

const PreviewSchema = requireSpecialRecovery(z.object({ action: z.literal('preview'), ...BaseShape }));
const ApplySchema = requireSpecialRecovery(
  z.object({
    action: z.literal('apply'),
    ...BaseShape,
    expected_version: z.number().int().nonnegative(),
    expected_base_etag: z.string().regex(/^[a-f0-9]{16}$/u),
  }),
);

const InputSchema = z.union([PreviewSchema, ApplySchema]);

function toNativeInput(input: z.infer<typeof PreviewSchema>): LegacyChainProfileRepairInput {
  const repairs: ProxyGroupFilterRepair[] = input.repairs.map(({ id, filter, exclude_filter }) => ({
    id,
    ...(filter !== undefined ? { filter } : {}),
    ...(exclude_filter !== undefined ? { 'exclude-filter': exclude_filter } : {}),
  }));
  return {
    alias: input.alias,
    repairs,
    ...(input.quarantine_spx_subscription_id
      ? { quarantineSpxSubscriptionId: input.quarantine_spx_subscription_id }
      : {}),
    ...(input.stale_chain
      ? {
          staleChain: {
            chainGroupId: input.stale_chain.chain_group_id,
            frontPoolGroupId: input.stale_chain.front_pool_group_id,
            consumerGroupId: input.stale_chain.consumer_group_id,
          },
        }
      : {}),
  };
}

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = InputSchema.parse(raw);
  const profile = await resolveScopeProfile(request);

  if (input.action === 'preview') {
    const plan = await planLegacyChainProfileRepair(profile.id, toNativeInput(input));
    return Response.json({
      data: {
        safe: true,
        summary: plan.summary,
        expectedVersion: plan.expectedVersion,
        expectedBaseEtag: plan.expectedBaseEtag,
      },
    });
  }

  const result = await executeLegacyChainProfileRepair(
    profile.id,
    toNativeInput({ ...input, action: 'preview' }),
    input.expected_version,
    input.expected_base_etag,
    resolveActor(request),
  );
  return Response.json({
    data: {
      summary: result.summary,
      newVersion: result.newVersion,
      auditEventId: result.auditEventId,
    },
  });
});
