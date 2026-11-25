import { withProblemDetails } from '@/lib/http/handler';
import { ProblemDetailsError } from '@/lib/http/problem';
import { z } from '@/lib/openapi/zod';
import { resolveScopeProfile } from '@/lib/profileScope';
import { BUILTIN_DIRECT } from '@/lib/services/directMigrationService';
import {
  executeLegacyProfileRepair,
  planLegacyProfileRepair,
} from '@/lib/services/legacyProfileRepairService';
import type { ProxyGroupFilterRepair } from '@/lib/services/proxyGroupFilterRepair';
import { resolveActor } from '@/lib/services/rulesService';

export const dynamic = 'force-dynamic';

const AliasSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'alias 不能包含控制字符')
  .refine((value) => value !== BUILTIN_DIRECT, 'alias 不能是 Mihomo 内建 DIRECT');

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
        ctx.addIssue({
          code: 'custom',
          message: '同一策略组不能在一个恢复批次中重复出现',
          path: [index, 'id'],
        });
      }
      seen.add(repair.id);
    });
  });

const PreviewSchema = z.object({
  action: z.literal('preview'),
  alias: AliasSchema.default('直连'),
  repairs: RepairsSchema,
});

const ApplySchema = z.object({
  action: z.literal('apply'),
  alias: AliasSchema.default('直连'),
  repairs: RepairsSchema,
  expected_version: z.number().int().nonnegative(),
  expected_base_etag: z.string().regex(/^[a-f0-9]{16}$/u),
  expected_subscription_failure_signature: z.string().min(1),
});

const InputSchema = z.discriminatedUnion('action', [PreviewSchema, ApplySchema]);

function nativeRepairs(repairs: z.infer<typeof RepairsSchema>): ProxyGroupFilterRepair[] {
  return repairs.map(({ id, filter, exclude_filter }) => ({
    id,
    ...(filter !== undefined ? { filter } : {}),
    ...(exclude_filter !== undefined ? { 'exclude-filter': exclude_filter } : {}),
  }));
}

export const POST = withProblemDetails(async (request: Request) => {
  const raw = await request.json().catch(() => {
    throw ProblemDetailsError.badRequest('Request body must be valid JSON.');
  });
  const input = InputSchema.parse(raw);
  const profile = await resolveScopeProfile(request);

  if (input.action === 'preview') {
    const plan = await planLegacyProfileRepair(profile.id, input.alias, nativeRepairs(input.repairs));
    return Response.json({
      data: {
        safe: true,
        directMigration: { ...plan.summary, expectedVersion: plan.expectedVersion },
        repairedFilterGroups: plan.filterRepairAfter.map((group) => group.name),
        expectedVersion: plan.expectedVersion,
        expectedBaseEtag: plan.expectedBaseEtag,
        subscriptionFailureSignature: plan.subscriptionFailureSignature,
      },
    });
  }

  const result = await executeLegacyProfileRepair(
    profile.id,
    input.alias,
    nativeRepairs(input.repairs),
    input.expected_version,
    input.expected_base_etag,
    resolveActor(request),
    input.expected_subscription_failure_signature,
  );
  return Response.json({
    data: {
      summary: result.summary,
      newVersion: result.newVersion,
      auditEventId: result.auditEventId,
    },
  });
});
